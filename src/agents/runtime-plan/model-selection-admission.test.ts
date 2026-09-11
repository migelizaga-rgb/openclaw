import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { registerResolvedAgentDir, unregisterResolvedAgentDir } from "../agent-dir-registry.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
import { resolveCatalogProviderUseAdmission } from "../models-config.providers.catalog-context.js";
import { createProviderApiKeyResolver } from "../models-config.providers.secrets.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const registered: { agentId: string; agentDir: string }[] = [];
afterEach(() => {
  for (const registration of registered.splice(0)) {
    unregisterResolvedAgentDir(registration);
  }
});

const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "byteplus",
      providers: ["byteplus", "byteplus-plan"],
      setup: { providers: [{ id: "byteplus", envVars: ["BYTEPLUS_API_KEY"] }] },
      providerAuthAliases: { "byteplus-plan": "byteplus" },
    },
  ],
});
const authStore: AuthProfileStore = {
  version: 1,
  profiles: {
    "byteplus:saved": { type: "api_key", provider: "byteplus", key: "saved-account" },
  },
};

it.each(["utility", "child"] as const)(
  "uses the saved family account in availability and catalog for a %s-only selection",
  (selector) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/primary",
          ...(selector === "utility" ? { utilityModel: "plan" } : { subagents: { model: "plan" } }),
          models: { "byteplus-plan/plan-model": { alias: "plan" } },
        },
        entries: {
          inherited: {},
          overridden:
            selector === "utility"
              ? { utilityModel: "openai/utility" }
              : { subagents: { model: "openai/child" } },
        },
      },
    };
    for (const agentId of [undefined, "inherited", "overridden"]) {
      const selected = agentId !== "overridden";
      expect(
        createModelAuthAvailabilityResolver({
          cfg,
          agentId,
          authStore,
          env: {},
          metadataSnapshot,
        }).resolveProviderAuthAvailability("byteplus-plan"),
      ).toBe(selected);
      const agentDir = tempDirs.make("selected-provider-catalog-");
      if (agentId) {
        const registration = { agentId, agentDir };
        registerResolvedAgentDir(registration);
        registered.push(registration);
      }
      const admission = resolveCatalogProviderUseAdmission({
        config: cfg,
        env: {},
        agentDir,
        profiles: authStore.profiles,
        pluginMetadataSnapshot: metadataSnapshot,
      });
      expect(admission.get("byteplus-plan")).toEqual(
        selected ? { kind: "profile", profileId: "byteplus:saved" } : undefined,
      );
      if (selected) {
        expect(
          createProviderApiKeyResolver(
            {},
            authStore,
            cfg,
            undefined,
            undefined,
            {},
            admission,
          )("byteplus-plan").discoveryApiKey,
        ).toBe("saved-account");
      }
    }
  },
);

it("does not select an unused alias or another agent's utility provider", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: "openai/primary",
        models: { "byteplus-plan/plan-model": { alias: "plan" } },
      },
      entries: { alpha: {}, beta: { utilityModel: "plan" } },
    },
  };
  for (const agentId of [undefined, "alpha", "beta"]) {
    expect(
      createModelAuthAvailabilityResolver({
        cfg,
        agentId,
        authStore,
        env: {},
        metadataSnapshot,
      }).resolveProviderAuthAvailability("byteplus-plan"),
    ).toBe(agentId === "beta");
  }
});

it.each(["main", "child"] as const)(
  "does not admit displaced global %s fallbacks after an agent selects its own primary",
  (selector) => {
    const defaults = { primary: "openai/default", fallbacks: ["byteplus-plan/plan-model"] };
    const localModels: Record<string, AgentModelConfig | undefined> = {
      string: "openai/local",
      object: { primary: "openai/local" },
      empty: { fallbacks: [] },
      inherited: undefined,
    };
    const cfg: OpenClawConfig = {
      agents: {
        defaults: selector === "main" ? { model: defaults } : { subagents: { model: defaults } },
        entries: Object.fromEntries(
          Object.entries(localModels).map(([id, model]) => [
            id,
            selector === "main" ? { model } : { subagents: { model } },
          ]),
        ),
      },
    };
    for (const agentId of [undefined, "string", " STRING ", "object", "empty", "inherited"]) {
      expect(
        createModelAuthAvailabilityResolver({
          cfg,
          agentId,
          authStore,
          env: {},
          metadataSnapshot,
        }).resolveProviderAuthAvailability("byteplus-plan"),
      ).toBe(agentId === undefined || agentId === "inherited");
    }
  },
);

it("uses an agent's summary model instead of the global summary provider", () => {
  const cfg: OpenClawConfig = {
    tts: { summaryModel: "byteplus-plan/plan-model" },
    agents: {
      entries: { inherited: {}, overridden: { tts: { summaryModel: "openai/local-summary" } } },
    },
  };
  for (const agentId of [undefined, "inherited", "overridden"]) {
    expect(
      createModelAuthAvailabilityResolver({
        cfg,
        agentId,
        authStore,
        env: {},
        metadataSnapshot,
      }).resolveProviderAuthAvailability("byteplus-plan"),
    ).toBe(agentId !== "overridden");
  }
});
