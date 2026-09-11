import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import * as openaiRoutes from "../../agents/openai-model-routes.js";
import { recordPreparedModelRuntimeAuthSource } from "../../agents/prepared-model-runtime-auth.js";
import { getPreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { buildModelAuthServingSnapshot } from "./models-auth-status-serving.js";
import type { ModelAuthStatusResult } from "./models-auth-status.types.js";

describe("models.authStatus serving source", () => {
  it("preserves a provider route rejection without exporting its route object", async () => {
    const incompatible = {
      kind: "incompatible" as const,
      code: "platform-only-model-on-chatgpt",
      message: "This model requires OpenAI Platform API-key authentication.",
    };
    const resolver = vi
      .spyOn(openaiRoutes, "createOpenAIModelRoutesResolver")
      .mockReturnValue(() => incompatible);
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/fixture-model",
          models: { "openai/fixture-model": { agentRuntime: { id: "openclaw" } } },
        },
      },
    };
    try {
      const read = () =>
        buildModelAuthServingSnapshot({
          agentId: "main",
          agentDir: "/tmp/serving-route-agent",
          workspaceDir: "/tmp/serving-route-workspace",
          config,
          observationConfig: config,
          entries: [],
          routeVariants: [],
          catalogComplete: true,
          authStore: {
            version: 1,
            profiles: {
              "openai:fixture": { type: "api_key", provider: "openai", key: "fixture-private-key" },
            },
          },
          authModes: {},
          authMaterializations: [],
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
          pluginRegistry: createEmptyPluginRegistry(),
          isCurrent: () => true,
        });
      const serving = await read();
      expect(serving.models).toEqual([
        expect.objectContaining({
          provider: "openai",
          model: "fixture-model",
          availability: false,
          routeIncompatibility: { code: incompatible.code, message: incompatible.message },
        }),
      ]);
      expect(serving.models[0]).not.toHaveProperty("routeResolution");
      expect(serving.models[0]).not.toHaveProperty("selectedRoute");
      resolver.mockReturnValue(() => ({
        kind: "routes",
        routes: [
          {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            authRequirement: "api-key",
            requestTransportOverrides: "none",
            runtimePolicy: { compatibleIds: ["openclaw"] },
          },
        ],
      }));
      const available = await read();
      expect(available.models[0]).toMatchObject({ availability: true, authRequirement: "api-key" });
      expect(available.models[0]).not.toHaveProperty("selectedRoute");
      expect(JSON.stringify(available)).not.toContain("fixture-private-key");
    } finally {
      resolver.mockRestore();
    }
  });

  it("reports retained serving auth separately from saved account inventory", async () => {
    const state = await createOpenClawTestState({
      label: "models-auth-status-serving",
      env: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const provider = "serving-fixture";
    const model = "configured-model";
    const token = "serving-status-gateway-token";
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { model: `${provider}/${model}`, imageModel: `${provider}/image-only` },
        list: [
          { id: "main", workspace: state.workspaceDir },
          { id: "other" },
          {
            id: "pinned",
            model: {
              primary: `${provider}/${model}`,
              fallbacks: [`${provider}/${model}@serving:B`],
            },
          },
          {
            id: "alias-pinned",
            model: { primary: `${provider}/${model}`, fallbacks: ["pinned-account"] },
            models: { [`${provider}/${model}@serving:B`]: { alias: "pinned-account" } },
          },
        ],
      },
      models: {
        providers: {
          [provider]: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            models: [
              {
                id: model,
                name: "Configured model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32768,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
      plugins: { enabled: false },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    const profileB = {
      type: "api_key" as const,
      provider,
      key: "fixture-B-secret",
    };
    const source = (profileId: string) => ({
      kind: "profile" as const,
      provider,
      profileId,
      mode: "api_key",
      readiness: "ready" as const,
      cooldown: "clear" as const,
    });
    try {
      await state.writeConfig(cfg);
      await state.writeAuthProfiles({ version: 1, profiles: { "serving:B": profileB } });
      await state.writeAuthProfiles(
        {
          version: 1,
          profiles: { "serving:C": { type: "api_key", provider, key: "fixture-C-secret" } },
          order: { [provider]: ["serving:C"] },
        },
        "other",
      );
      const { client, server } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        const owner = () => {
          const snapshot = getPreparedModelRuntimeSnapshot({
            config: getRuntimeConfig(),
            agentId: "main",
            agentDir: state.agentDir(),
          });
          assert(snapshot);
          return snapshot;
        };
        const status = () =>
          client.request<ModelAuthStatusResult>("models.authStatus", { agentId: "main" });
        const initial = await status();
        expect(initial.servingAuth).toMatchObject({
          agentId: "main",
          agentDir: state.agentDir(),
          models: [{ provider, model, availability: true, selectedProfileId: "serving:B" }],
        });
        recordPreparedModelRuntimeAuthSource(owner(), provider, model, source("serving:B"));
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "serving:A": { type: "api_key", provider, key: "fixture-A-secret" },
            "serving:B": profileB,
          },
        });
        await client.request("models.authRefresh", { agentId: "main", operation: "login" });
        const retained = await status();
        expect(retained.providers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              provider,
              profiles: expect.arrayContaining([
                expect.objectContaining({ profileId: "serving:A" }),
              ]),
            }),
          ]),
        );
        expect(retained.servingAuth?.models).toEqual([
          expect.objectContaining({ provider, model, selectedProfileId: "serving:B" }),
        ]);
        recordPreparedModelRuntimeAuthSource(owner(), provider, model, source("serving:A"));
        const switched = await status();
        expect(switched.servingAuth?.models).toEqual([
          expect.objectContaining({ provider, model, selectedProfileId: "serving:A" }),
        ]);
        const serialized = JSON.stringify(switched.servingAuth);
        for (const privateField of [
          "fixture-A-secret",
          "fixture-B-secret",
          "routeResolution",
          "selectedRoute",
          "headers",
          "127.0.0.1",
        ]) {
          expect(serialized).not.toContain(privateField);
        }
        const other = await client.request<ModelAuthStatusResult>("models.authStatus", {
          agentId: "other",
        });
        expect(other.servingAuth).toMatchObject({
          agentId: "other",
          agentDir: state.agentDir("other"),
          models: [{ provider, model, selectedProfileId: "serving:C" }],
        });
        const pinned = await client.request<ModelAuthStatusResult>("models.authStatus", {
          agentId: "pinned",
        });
        expect(pinned.servingAuth).toEqual({
          agentId: "pinned",
          agentDir: state.agentDir("pinned"),
          models: [],
        });
        const aliasPinned = await client.request<ModelAuthStatusResult>("models.authStatus", {
          agentId: "alias-pinned",
        });
        expect(aliasPinned.servingAuth).toEqual({
          agentId: "alias-pinned",
          agentDir: state.agentDir("alias-pinned"),
          models: [],
        });
      } finally {
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      await state.cleanup();
    }
  });
});
