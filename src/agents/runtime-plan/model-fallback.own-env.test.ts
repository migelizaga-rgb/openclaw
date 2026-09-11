import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ensureAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";
import { resolvePreparedRuntimeModelAuth } from "./resolve-auth.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "fixture-plugin",
      providers: ["fixture-api", "fixture-plan"],
      providerAuthAliases: { "fixture-plan": "fixture-api" },
      setup: { providers: [{ id: "fixture-api", envVars: ["FIXTURE_API_KEY"] }] },
    },
  ],
});
const profileId = "fixture-api:revoked";
afterEach(clearRuntimeConfigSnapshot);

it.each([
  "own-env",
  "configured-env",
  "prepared-env",
  "unbound-env",
  "missing-env",
  "pin",
  "config-order",
  "store-order",
  "shared-alias",
] as const)(
  "keeps model fallback aligned with usable account selection for %s",
  async (selection) => {
    await withOpenClawTestState(
      {
        layout: "home",
        prefix: "fallback-own-env-",
        env: {
          FIXTURE_API_KEY: [
            "missing-env",
            "configured-env",
            "prepared-env",
            "unbound-env",
          ].includes(selection)
            ? undefined
            : "environment-account",
          EXPLICIT_AUTH_KEY: "configured-environment-account",
        },
      },
      async (state) => {
        const provider = selection === "shared-alias" ? "fixture-plan" : "fixture-api";
        const cfg: OpenClawConfig = {
          agents: { defaults: { model: `${provider}/test-model` }, entries: { main: {} } },
          ...(selection === "config-order"
            ? { auth: { order: { "fixture-api": [profileId] } } }
            : {}),
        };
        if (selection === "configured-env" || selection === "prepared-env") {
          cfg.models = {
            providers: {
              "fixture-api": {
                baseUrl: "https://fixture.invalid/v1",
                models: [],
                apiKey: { source: "env", provider: "default", id: "EXPLICIT_AUTH_KEY" },
              },
            },
          };
        }
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            [profileId]: { type: "api_key", provider: "fixture-api", key: "revoked-account" },
          },
          usageStats: {
            [profileId]: { disabledUntil: Date.now() + 600_000, disabledReason: "auth_permanent" },
          },
          ...(selection === "store-order" ? { order: { "fixture-api": [profileId] } } : {}),
        });
        await withPluginMetadataSnapshotScope(
          metadataSnapshot,
          async () => {
            if (selection === "prepared-env") {
              setRuntimeConfigSnapshot(
                {
                  ...cfg,
                  models: {
                    providers: {
                      "fixture-api": {
                        baseUrl: "https://fixture.invalid/v1",
                        models: [],
                        apiKey: "configured-environment-account",
                      },
                    },
                  },
                },
                cfg,
              );
            }
            const model: Model = {
              provider,
              id: "test-model",
              name: "Fixture",
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            };
            const run = vi.fn(async () => {
              const store = ensureAuthProfileStore(state.agentDir());
              const prepared = prepareAgentRuntimeAuth({
                provider,
                modelId: model.id,
                modelApi: model.api,
                modelBaseUrl: model.baseUrl,
                config: cfg,
                env: process.env,
                authProfileStore: store,
                metadataSnapshot,
              });
              const resolved = await resolvePreparedRuntimeModelAuth({
                plan: prepared.plan,
                model,
                cfg,
                store,
              });
              return resolved.auth.apiKey;
            });
            const result = runWithModelFallback({
              cfg,
              provider,
              model: model.id,
              agentId: "main",
              agentDir: state.agentDir(),
              fallbacksOverride: [],
              manifestPlugins: metadataSnapshot.manifestRegistry.plugins,
              ...(selection === "pin" ? { userLockedAuthProfileId: profileId } : {}),
              run,
            });
            if (
              selection === "own-env" ||
              selection === "configured-env" ||
              selection === "prepared-env"
            ) {
              await expect(result).resolves.toMatchObject({
                outcome: "completed",
                result:
                  selection !== "own-env"
                    ? "configured-environment-account"
                    : "environment-account",
              });
              expect(run).toHaveBeenCalledOnce();
            } else {
              await expect(result).rejects.toThrow("All models failed");
              expect(run).not.toHaveBeenCalled();
            }
          },
          { config: cfg, trustConfigIdentity: true },
        );
      },
    );
  },
);
