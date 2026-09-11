import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createModelsListTestContext,
  providerCatalogEntry,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

const liveCatalog = vi.hoisted(() => vi.fn());
vi.mock("../../agents/prepared-model-runtime.scoped-catalog.js", () => ({
  prepareScopedReadOnlyLiveModelCatalog: liveCatalog,
  prepareScopedReadOnlyModelCatalog: () => {
    throw new Error("Unexpected static acquisition");
  },
}));
afterEach(() => vi.clearAllMocks());

it.each(["default", "all", "refresh"] as const)(
  "admits a saved family account only for the session-selected provider in %s listings",
  async (view) => {
    await withOpenClawTestState(
      {
        label: "session-provider-catalog",
        env: { ...WITHOUT_OPENAI_ENV_AUTH, BYTEPLUS_API_KEY: undefined },
      },
      async (state) => {
        const cfg: OpenClawConfig = {
          agents: { defaults: { model: "test/unrelated" }, entries: { main: {} } },
        };
        await state.writeConfig(cfg);
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "byteplus:saved": {
              type: "api_key",
              provider: "byteplus",
              key: "fixture-saved-account",
            },
          },
        });
        const sessionKey = "agent:main:family-pin";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "family-pin",
            updatedAt: 1,
            providerOverride: "byteplus-plan",
            modelOverride: "ark-code-latest",
            modelOverrideSource: "user",
          },
        );
        const selected = providerCatalogEntry("byteplus-plan", "ark-code-latest");
        const sibling = providerCatalogEntry("byteplus-other", "unselected-model");
        const dynamic = providerCatalogEntry("byteplus-plan", "account-only-model");
        const metadataSnapshot = createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "byteplus",
              providers: ["byteplus", "byteplus-plan", "byteplus-other"],
              providerAuthAliases: { "byteplus-plan": "byteplus", "byteplus-other": "byteplus" },
              setup: { providers: [{ id: "byteplus", envVars: ["BYTEPLUS_API_KEY"] }] },
            },
          ],
        });
        const context = createModelsListTestContext({
          cfg,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          metadataSnapshot,
          catalog: [],
          staticEntries: [selected, sibling],
        });
        liveCatalog.mockResolvedValue({
          entries: [dynamic, sibling],
          routeVariants: [dynamic, sibling],
        });
        const request = async (params: Record<string, unknown>) => {
          const respond = vi.fn<RespondFn>();
          await expectDefined(
            modelsHandlers["models.list"],
            "models.list handler",
          )({
            req: { type: "req", id: "session-provider-catalog", method: "models.list", params },
            params,
            context,
            client: null,
            respond,
            isWebchatConnect: () => false,
          });
          return respond;
        };

        const pinned = await request({
          sessionKey,
          view: view === "refresh" ? "all" : view,
          includeDetails: true,
          ...(view === "refresh" ? { refresh: true } : {}),
        });

        expect(pinned).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            models: expect.arrayContaining([
              expect.objectContaining({
                provider: "byteplus-plan",
                id: selected.id,
                available: true,
              }),
            ]),
          }),
          undefined,
        );
        expect(pinned).not.toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            models: expect.arrayContaining([
              expect.objectContaining({ provider: "byteplus-other", available: true }),
            ]),
          }),
          undefined,
        );
        if (view === "refresh") {
          expect(liveCatalog).toHaveBeenCalledWith(
            expect.objectContaining({ config: cfg, readOnly: true }),
            ["byteplus-plan"],
            expect.objectContaining({
              requestedProviderIds: ["byteplus-plan"],
              authStore: expect.objectContaining({
                profiles: expect.objectContaining({ "byteplus:saved": expect.anything() }),
              }),
            }),
          );
          expect(pinned).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              models: expect.arrayContaining([
                expect.objectContaining({ id: dynamic.id, available: true }),
              ]),
            }),
            undefined,
          );
        } else {
          expect(liveCatalog).not.toHaveBeenCalled();
        }
        const unscoped = await request({ agentId: "main", view: "all", includeDetails: true });
        expect(unscoped).not.toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            models: expect.arrayContaining([
              expect.objectContaining({ provider: "byteplus-plan", available: true }),
            ]),
          }),
          undefined,
        );
        expect(cfg.models?.providers).toBeUndefined();
      },
    );
  },
);
