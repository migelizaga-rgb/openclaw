import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { setConfigProviderUseBindings } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import type { PreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog-auth.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import {
  replaceRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./auth-profiles/runtime-snapshots.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import {
  HARNESS_ID,
  PLUGIN_ID,
  PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
  UNRELATED_PLUGIN_ID,
  UNRELATED_PLUGIN_WORKER_MARKER_ENV,
  createCatalogFixture,
  writeFixturePlugin,
  writeUnrelatedFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import { invalidatePreparedModelRuntimeOwnersForAuthMutation } from "./prepared-model-runtime-auth-publication.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import { prepareModelRuntimeOwner } from "./prepared-model-runtime.owner.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForWorkers, waitForMarker } =
  usePreparedCatalogWorkerFixtures();

async function createStartupBindingSnapshot() {
  const fixture = createCatalogFixture(makeTempDir, 0, {
    CODEX_HOME: makeTempDir("openclaw-worker-empty-codex-"),
    WORKER_CATALOG_API_KEY: "environment-account",
  });
  const { agentDir, workspaceDir, config, env } = fixture;
  setConfigProviderUseBindings(config, {
    [PROVIDER_ID]: { apiKey: { source: "env", provider: "default", id: "WORKER_CATALOG_API_KEY" } },
  });
  const input = {
    agentId: "main",
    agentDir,
    inheritedAuthDir: agentDir,
    workspaceDir,
    config,
    env,
  };
  let current = true;
  const supersede = () => {
    current = false;
  };
  retireAfterTest(supersede);
  const prepared = (
    await startSerializedSnapshotBuildBatch(
      [
        {
          input,
          catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
          isGenerationCurrent: () => current,
          isBuildCurrent: () => current,
        },
      ],
      new Map(),
      30_000,
      "static",
    ).pending
  )[0];
  if (!prepared) {
    throw new Error("prepared runtime produced no snapshot");
  }
  return { ...fixture, snapshot: prepared.snapshot, supersede };
}

describe("prepared model catalog worker plugin scope", () => {
  it("keeps catalog contributors on the models.list route without importing unrelated plugins", async () => {
    const root = makeTempDir("openclaw-model-catalog-scope-worker-");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const workspaceDir = path.join(root, "workspace");
    const marker = path.join(root, "worker-marker.txt");
    const unrelatedMarker = path.join(root, "unrelated-worker-plugin.txt");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const pluginFile = writeFixturePlugin({ root, spinMs: 0 });
    const unrelatedPluginFile = writeUnrelatedFixturePlugin(root);
    const config = {
      models: {
        providers: {
          [PROVIDER_ID]: { baseUrl: "https://worker-catalog.invalid/v1", models: [] },
        },
      },
      agents: {
        defaults: {
          model: `${PROVIDER_ID}/sqlite-model`,
          models: {
            [`${PROVIDER_ID}/sqlite-model`]: { agentRuntime: { id: HARNESS_ID } },
          },
        },
        list: [{ id: "main", default: true, agentDir, workspace: workspaceDir }],
      },
      plugins: {
        allow: [PLUGIN_ID, UNRELATED_PLUGIN_ID],
        load: { paths: [pluginFile, unrelatedPluginFile] },
        entries: {
          [PLUGIN_ID]: { enabled: true },
          [UNRELATED_PLUGIN_ID]: { enabled: true },
        },
      },
    } satisfies OpenClawConfig;
    const env = {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKER_CATALOG_MARKER: marker,
      [UNRELATED_PLUGIN_WORKER_MARKER_ENV]: unrelatedMarker,
      [REF_ONLY_API_ENV]: "ref-only-api-secret-not-real",
      [REF_ONLY_TOKEN_ENV]: "ref-only-token-secret-not-real",
    };
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: { version: 1, profiles: {} } }]);

    const input = {
      agentId: "main",
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir,
      config,
      env,
    };
    let current = true;
    retireAfterTest(() => {
      current = false;
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env });
    });
    const prepared = (
      await startSerializedSnapshotBuildBatch(
        [
          {
            input,
            catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
            isGenerationCurrent: () => current,
            isBuildCurrent: () => current,
          },
        ],
        new Map(),
        30_000,
        "static",
      ).pending
    )[0];
    if (!prepared) {
      throw new Error("prepared runtime produced no snapshot");
    }
    const authStore = getPreparedModelRuntimeAuthStore(prepared.snapshot);
    if (!authStore) {
      throw new Error("prepared runtime produced no auth store");
    }
    const projectSnapshot = async (full: boolean): Promise<PreparedGatewayModelCatalogSnapshot> => {
      const modelCatalog = full
        ? await prepared.snapshot.loadFullModelCatalog!()
        : prepared.snapshot.modelCatalog;
      return {
        ...modelCatalog,
        agentId: "main",
        agentDir,
        workspaceDir,
        config,
        observationConfig: prepared.snapshot.observationConfig,
        isCurrent: prepared.snapshot.isCurrent,
        pluginRegistry: prepared.snapshot.pluginRegistry,
        catalogComplete: full,
        authModes: prepared.snapshot.authModes,
        authStore,
        metadataSnapshot: prepared.snapshot.metadataSnapshot,
        authMaterializations: [],
      };
    };
    const loadGatewayModelCatalogSnapshot: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] =
      async (params) => {
        const {
          authModes: _authModes,
          authStore: _authStore,
          metadataSnapshot: _metadataSnapshot,
          authMaterializations: _authMaterializations,
          observationConfig: _observationConfig,
          isCurrent: _isCurrent,
          pluginRegistry: _pluginRegistry,
          ...snapshot
        } = await projectSnapshot(params?.readOnly === false);
        return snapshot;
      };
    let published = await projectSnapshot(false);
    registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
      loadDeferred: async (params) =>
        (published = await projectSnapshot(params?.readOnly === false)),
      readPrepared: async () => published,
    });
    const respond = vi.fn();
    const context = Object.assign({} as GatewayRequestContext, {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn(), warn: vi.fn() },
    });
    await expectDefined(
      modelsHandlers["models.list"],
      'modelsHandlers["models.list"] test invariant',
    )({
      req: {
        type: "req",
        id: "models-list-worker-scope",
        method: "models.list",
        params: { view: "all", refresh: true },
      },
      params: { view: "all", refresh: true },
      respond: respond as RespondFn,
      client: null,
      isWebchatConnect: () => false,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        models: expect.arrayContaining([
          expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
        ]),
      }),
      undefined,
    );
    expect(fs.existsSync(unrelatedMarker)).toBe(false);
  });
  it.each(["added", "removed", "another root"] as const)(
    "fences delayed catalog publication when another agent account is %s",
    async (change) => {
      const fixture = await createStartupBindingSnapshot();
      const oldStateDir = process.env.OPENCLAW_STATE_DIR;
      vi.stubEnv("OPENCLAW_STATE_DIR", fixture.env.OPENCLAW_STATE_DIR);
      const otherDir = path.join(fixture.env.OPENCLAW_STATE_DIR, "agents", "other", "agent");
      fs.mkdirSync(otherDir, { recursive: true });
      setRuntimeAuthProfileStoreSnapshot(
        ensureAuthProfileStore(otherDir, { syncExternalCli: false }),
        otherDir,
      );
      if (change === "removed") {
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "other:saved": {
                type: "api_key",
                provider: "unrelated-provider",
                key: "saved-account",
              },
            },
          },
          otherDir,
        );
      }
      const owner = prepareModelRuntimeOwner(
        { agentDir: fixture.agentDir, config: fixture.config, env: fixture.env },
        "explicit",
      );
      const barrier = `${fixture.marker}.hold`;
      fs.writeFileSync(barrier, "");
      const catalog = fixture.snapshot.loadFullModelCatalog!();
      void catalog.catch(() => {});
      try {
        await waitForMarker(fixture.marker);
        const mutationDir =
          change === "another root"
            ? path.join(makeTempDir("openclaw-catalog-foreign-owner-"), "agents", "other", "agent")
            : otherDir;
        if (change === "another root") {
          vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(path.dirname(path.dirname(mutationDir))));
          fs.mkdirSync(mutationDir, { recursive: true });
          setRuntimeAuthProfileStoreSnapshot(
            ensureAuthProfileStore(mutationDir, { syncExternalCli: false }),
            mutationDir,
          );
        }
        saveAuthProfileStore(
          {
            version: 1,
            profiles:
              change === "removed"
                ? {}
                : {
                    "other:saved": { type: "api_key", provider: PROVIDER_ID, key: "saved-account" },
                  },
          },
          mutationDir,
        );
        const invalidated = invalidatePreparedModelRuntimeOwnersForAuthMutation(
          new Map([["main", owner]]),
          {
            agentDir: mutationDir,
            affectsInheritedStores: false,
            profileSetChanged: true,
          },
        );
        if (change === "another root") {
          expect(invalidated.invalidatedOwners).toEqual([]);
          fs.rmSync(barrier);
          await expect(catalog).resolves.toBeDefined();
        } else {
          expect(invalidated.invalidatedOwners).toEqual([owner]);
          expect(owner.generation).toBe(1);
          expect(owner.catalogStale).toBe(true);
          await expect(catalog).rejects.toThrow("superseded");
          await waitForWorkers();
          expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\n");
        }
      } finally {
        fixture.supersede();
        fs.rmSync(barrier, { force: true });
        await Promise.allSettled([catalog]);
        vi.stubEnv("OPENCLAW_STATE_DIR", oldStateDir);
      }
    },
  );
});
