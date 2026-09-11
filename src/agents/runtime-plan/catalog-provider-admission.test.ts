import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAICompatibleProviderFamilyCatalog } from "../../plugin-sdk/provider-catalog-live-runtime.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { MODELS_CONFIG_IMPLICIT_ENV_VARS } from "../models-config.e2e-harness.js";

const mocks = vi.hoisted(() => ({
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderCatalog: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));
vi.mock("../../plugins/provider-discovery.js", () => ({
  resolveRuntimePluginDiscoveryProviders: mocks.resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog: mocks.runProviderCatalog,
  runProviderStaticCatalog: mocks.runProviderStaticCatalog,
  prepareProviderStaticCatalog: vi.fn(async () => ({ providers: [], entries: [] })),
  groupPluginDiscoveryProvidersByOrder: (providers: ProviderPlugin[]) => ({
    simple: providers,
    profile: [],
    paired: [],
    late: [],
  }),
  normalizePluginDiscoveryResult: ({
    result,
  }: {
    result?: { providers?: Record<string, unknown> } | null;
  }) => result?.providers ?? {},
}));
import { resolveImplicitProviders } from "../models-config.providers.implicit.js";

function createProvider(id: string): ProviderPlugin {
  return { id, label: id, auth: [], catalog: { order: "simple", run: async () => null } };
}
function createTextModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}
describe("catalog destination credential admission", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.runProviderCatalog.mockReset();
    state = await createOpenClawTestState({
      label: "catalog-destination-admission",
      env: Object.fromEntries(
        [...MODELS_CONFIG_IMPLICIT_ENV_VARS, "CODEX_API_KEY", "CODEX_HOME", "GOOGLE_CLOUD_API_KEY"]
          .filter((key) => key !== "VITEST" && key !== "NODE_ENV")
          .map((key) => [key, undefined]),
      ),
    });
  });
  afterEach(async () => {
    await state.cleanup();
  });
  it.each([
    { sibling: "none", configured: true },
    { sibling: "environment", configured: true },
    { sibling: "profile", configured: true },
    { sibling: "environment", configured: false },
  ])(
    "keeps SDK donor auth destination-specific (sibling: $sibling, configured: $configured)",
    async ({ sibling, configured }) => {
      const family = buildOpenAICompatibleProviderFamilyCatalog({
        credentialProviderId: "fixture-donor",
        entries: ["fixture-configured", "fixture-sibling"].map((id) => ({
          id,
          label: id,
          baseUrl: "not-a-url",
          models: [createTextModel("fixture-live", "Fixture live")],
          buildProvider: () => ({
            baseUrl: "not-a-url",
            api: "openai-completions" as const,
            models: [createTextModel("fixture-live", "Fixture live")],
          }),
        })),
        staticCatalog: async () => ({ providers: {} }),
        augmentModelCatalog: vi.fn(),
      });
      mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
        {
          id: "fixture-configured",
          aliases: ["fixture-sibling"],
          pluginId: "fixture-family",
          label: "Fixture family",
          auth: [],
          ...family,
        },
      ]);
      mocks.runProviderCatalog.mockImplementation((params) => family.catalog.run(params));
      mocks.runProviderStaticCatalog.mockResolvedValue({ providers: {} });
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture-family",
            providers: ["fixture-configured", "fixture-sibling"],
            setup: { providers: [{ id: "fixture-sibling", envVars: ["FIXTURE_SIBLING_KEY"] }] },
          },
        ],
      });
      const result = await resolveImplicitProviders({
        agentDir: state.agentDir(),
        env: {
          ...state.env,
          ...(sibling === "environment" ? { FIXTURE_SIBLING_KEY: "sibling-key" } : {}),
        },
        authStore: {
          version: 1,
          profiles:
            sibling === "profile"
              ? {
                  "fixture-sibling:saved": {
                    type: "api_key",
                    provider: "fixture-sibling",
                    key: "saved-key",
                  },
                }
              : {},
        },
        config: {
          models: {
            providers: {
              "fixture-donor": {
                baseUrl: "https://donor.example",
                apiKey: "donor-key",
                models: [],
              },
              ...(configured ? { "fixture-configured": { baseUrl: "not-a-url", models: [] } } : {}),
            },
          },
        },
        pluginMetadataSnapshot: metadata,
        providerDiscoveryProviderIds: ["fixture-configured", "fixture-sibling"],
      });
      expect(result?.["fixture-configured"]?.models?.map((model) => model.id)).toEqual(
        configured ? ["fixture-live"] : undefined,
      );
      expect(result?.["fixture-sibling"]).toBeUndefined();
    },
  );

  it.each([true, false])(
    "admits saved family auth only for the requested session destination: %s",
    async (requested) => {
      const config = { agents: { defaults: { model: "test/default" } } };
      const env = { ...state.env, FAMILY_API_KEY: "fixture-env-account" };
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "family",
            providers: ["family", "family-plan", "family-other"],
            providerAuthAliases: { "family-plan": "family", "family-other": "family" },
            setup: { providers: [{ id: "family", envVars: ["FAMILY_API_KEY"] }] },
          },
        ],
      });
      mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
        {
          ...createProvider("family"),
          aliases: ["family-plan", "family-other"],
        },
      ]);
      mocks.runProviderCatalog.mockImplementation((params) => {
        expect(params.resolveProviderApiKey("family-plan").discoveryApiKey).toBe(
          "fixture-saved-account",
        );
        return {
          providers: Object.fromEntries(
            ["family-plan", "family-other"].map((id) => [
              id,
              {
                baseUrl: "https://family.example",
                api: "openai-completions",
                models: [createTextModel("account-only", "Account only")],
              },
            ]),
          ),
        };
      });
      const result = await withPluginMetadataSnapshotScope(
        metadata,
        () =>
          resolveImplicitProviders({
            config,
            env,
            agentDir: state.agentDir(),
            authStore: {
              version: 1,
              profiles: {
                "family:saved": {
                  type: "api_key",
                  provider: "family",
                  key: "fixture-saved-account",
                },
              },
            },
            pluginMetadataSnapshot: metadata,
            providerDiscoveryProviderIds: ["family-plan"],
            requestedProviderIds: requested ? ["family-plan"] : [],
          }),
        { config, env },
      );
      expect(Object.keys(result ?? {})).toEqual(requested ? ["family-plan"] : []);
      expect(mocks.runProviderCatalog).toHaveBeenCalledTimes(requested ? 1 : 0);
    },
  );
});
