import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setConfigProviderUseBindings } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getPreparedModelRuntimePreferredAuthSource } from "./prepared-model-runtime-auth.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import {
  prepareSimpleCompletionModel,
  completeWithPreparedSimpleCompletionModel,
} from "./simple-completion-runtime.js";

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});

describe("simple completion current credential", () => {
  it.each([
    { current: "working", readOnly: false, rejected: false },
    { current: "missing", readOnly: false, rejected: false },
    { current: "exhausted", readOnly: false, rejected: false },
    { current: "working", readOnly: true, rejected: false },
    { current: "working", readOnly: false, rejected: true },
  ] as const)(
    "serves and records the current source only after success (current=$current, readOnly=$readOnly, rejected=$rejected)",
    async ({ current, readOnly, rejected }) => {
      await withOpenClawTestState(
        {
          label: "simple-completion-current-auth",
          env: { COMPLETION_CURRENT_KEY: "environment-account" },
        },
        async (state) => {
          const requests: string[] = [];
          const server = createServer((request, response) => {
            requests.push(request.headers.authorization ?? "");
            request.resume();
            request.on("end", () => {
              if (rejected) {
                response.writeHead(401, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "Invalid fixture credential" } }));
                return;
              }
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.end(
                `data: ${JSON.stringify({
                  id: "auth-source-response",
                  object: "chat.completion.chunk",
                  model: "fixture",
                  choices: [{ index: 0, delta: { content: "served" }, finish_reason: "stop" }],
                })}\n\ndata: [DONE]\n\n`,
              );
            });
          });
          await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
          });
          try {
            const address = server.address();
            if (!address || typeof address === "string") {
              throw new Error("Completion fixture did not expose a TCP port");
            }
            const provider = "current-completion";
            const binding = {
              apiKey: { source: "env" as const, provider: "default", id: "COMPLETION_CURRENT_KEY" },
            };
            const config: OpenClawConfig = {
              agents: { defaults: { workspace: state.workspaceDir, model: `${provider}/fixture` } },
              models: {
                providers: {
                  [provider]: {
                    ...binding,
                    api: "openai-completions",
                    baseUrl: `http://127.0.0.1:${address.port}/v1`,
                    models: [
                      {
                        id: "fixture",
                        name: "Fixture",
                        reasoning: false,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 8192,
                        maxTokens: 1024,
                      },
                    ],
                  },
                },
              },
            };
            setConfigProviderUseBindings(config, { [provider]: binding });
            await state.writeAuthProfiles({
              version: 1,
              profiles: {
                "current-completion:saved":
                  current === "exhausted"
                    ? { type: "token", provider, token: "expired-account", expires: 1 }
                    : { type: "api_key", provider, key: "saved-account" },
              },
            });
            const lease = await acquireAgentRunPreparedModelRuntime(
              {
                config,
                agentId: "main",
                agentDir: state.agentDir(),
                workspaceDir: state.workspaceDir,
                readOnly,
              },
              { catalogMode: "static" },
            );
            try {
              if (current !== "working") {
                vi.stubEnv("COMPLETION_CURRENT_KEY", undefined);
              }
              expect(
                getPreparedModelRuntimePreferredAuthSource(lease.snapshot, provider, "fixture"),
              ).toBeUndefined();
              const prepared = await prepareSimpleCompletionModel({
                cfg: lease.snapshot.config,
                provider,
                modelId: "fixture",
                preparedModelRuntime: lease.snapshot,
              });
              if (current === "exhausted") {
                if (!("error" in prepared)) {
                  throw new Error("Expected unavailable credential recovery guidance");
                }
                expect(prepared.error).toContain('provider "current-completion"');
                expect(prepared.error).toContain('"current-completion:saved" (expired)');
                expect(prepared.error).toContain("openclaw configure");
                expect(requests).toEqual([]);
                expect(
                  getPreparedModelRuntimePreferredAuthSource(lease.snapshot, provider, "fixture"),
                ).toBeUndefined();
                return;
              }
              if ("error" in prepared) {
                throw new Error(prepared.error);
              }
              expect(
                getPreparedModelRuntimePreferredAuthSource(lease.snapshot, provider, "fixture"),
              ).toBeUndefined();
              const reply = await completeWithPreparedSimpleCompletionModel({
                model: prepared.model,
                auth: prepared.auth,
                cfg: lease.snapshot.config,
                context: {
                  messages: [{ role: "user", content: "Reply with served.", timestamp: 0 }],
                },
                options: { maxTokens: 32 },
              });
              if (rejected) {
                expect(reply.stopReason).toBe("error");
              } else {
                expect(reply.content).toEqual([{ type: "text", text: "served" }]);
              }
              const retained = getPreparedModelRuntimePreferredAuthSource(
                lease.snapshot,
                provider,
                "fixture",
              );
              if (readOnly || rejected) {
                expect(retained).toBeUndefined();
              } else {
                expect(retained).toMatchObject(
                  current === "missing"
                    ? { kind: "profile", profileId: "current-completion:saved" }
                    : { kind: "direct", boundEnvVar: "COMPLETION_CURRENT_KEY" },
                );
              }
              expect(requests).toEqual([
                `Bearer ${current === "working" ? "environment-account" : "saved-account"}`,
              ]);
              expect(prepared.auth.profileId).toBe(
                current === "working" ? undefined : "current-completion:saved",
              );
            } finally {
              lease.release();
            }
          } finally {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          }
        },
      );
    },
  );
});
