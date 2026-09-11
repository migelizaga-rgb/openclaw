import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  createEmbeddedRunAuthController,
  type EmbeddedRunAuthState,
} from "../embedded-agent-runner/run/auth-controller.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "./resolve-auth.js";

const model: Model = {
  id: "gpt-5.4",
  name: "Platform model",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  input: ["text"],
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_000,
};

describe("prepared environment credential identity", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(
    (["prepared-resolver", "ordinary-controller"] as const).flatMap((consumer) =>
      (["unchanged", "withdrawn", "rotated"] as const).map((change) => ({ consumer, change })),
    ),
  )(
    "$consumer keeps the admitted variable when it is $change during model materialization",
    async ({ consumer, change }) => {
      vi.stubEnv("OPENAI_API_KEY", "admitted-account-key");
      vi.stubEnv("CODEX_API_KEY", "other-account-key");
      const config: OpenClawConfig = {};
      const store: AuthProfileStore = { version: 1, profiles: {} };
      await using cache = createPluginCache();
      const metadataSnapshot = withPluginCache(cache, () =>
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "openai",
              providers: ["openai"],
              setup: {
                requiresRuntime: false,
                providers: [{ id: "openai", envVars: ["OPENAI_API_KEY"] }],
              },
            },
          ],
        }),
      );

      await withPluginMetadataSnapshotScope(
        metadataSnapshot,
        async () => {
          const prepared = prepareAgentRuntimeAuth({
            provider: model.provider,
            modelId: model.id,
            modelApi: model.api,
            modelBaseUrl: model.baseUrl,
            config,
            env: process.env,
            authProfileStore: store,
            metadataSnapshot,
            harnessId: "openclaw",
          });
          const materializeModel = async () => {
            if (change !== "unchanged") {
              vi.stubEnv(
                "OPENAI_API_KEY",
                change === "withdrawn" ? undefined : "rotated-admitted-key",
              );
            }
            return model;
          };
          const resolveOrdinaryController = async () => {
            const runtimeModel = await materializeModel();
            const state: EmbeddedRunAuthState = {
              models: { runtime: runtimeModel, effective: runtimeModel },
              apiKeyInfo: null,
              lastProfileId: undefined,
              runtimeAuthState: null,
              runtimeAuthRefreshCancelled: false,
              profileIndex: 0,
              thinkLevel: "off",
            };
            const controller = createEmbeddedRunAuthController({
              config,
              agentDir: "/unused/agent",
              workspaceDir: "/unused/workspace",
              authStore: store,
              authStorage: { setRuntimeApiKey: vi.fn() },
              profileCandidates: [undefined],
              initialThinkLevel: "off",
              attemptedThinking: new Set(),
              fallbackConfigured: false,
              allowTransientCooldownProbe: false,
              provider: model.provider,
              modelId: model.id,
              state,
              prepareModelForAuthProfile: async () => ({
                runtimeModel,
                boundEnvVar: prepared.plan.boundEnvVar,
                allowAuthProfileFallback: false,
                commit() {},
              }),
              log: { debug() {}, info() {}, warn() {} },
            });
            await controller.initializeAuthProfile();
            return { auth: state.apiKeyInfo };
          };
          const resolution =
            consumer === "ordinary-controller"
              ? resolveOrdinaryController()
              : resolvePreparedRuntimeAuthAttempts({
                  attempts: prepared.attempts,
                  store,
                  modelId: model.id,
                  model,
                  materializeModel,
                  resolveAuth: ({ attempt, model: preparedModel }) =>
                    resolvePreparedRuntimeModelAuth({
                      plan: attempt.plan,
                      model: preparedModel,
                      cfg: config,
                      store,
                    }),
                  errorMessage: "Prepared environment credential could not be resolved.",
                });

          if (change === "withdrawn") {
            await expect(resolution).rejects.toMatchObject({
              code: "missing-provider-auth",
              provider: "openai",
            });
          } else {
            await expect(resolution).resolves.toMatchObject({
              auth: {
                apiKey: change === "rotated" ? "rotated-admitted-key" : "admitted-account-key",
                source: "env: OPENAI_API_KEY",
              },
            });
          }
        },
        { config, trustConfigIdentity: true },
      );
    },
  );
});
