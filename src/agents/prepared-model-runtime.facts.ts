import { performance } from "node:perf_hooks";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { Result } from "@openclaw/normalization-core/result";
import { prepareMediaCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getPluginMetadataSnapshotCache, retainPluginCache } from "../plugins/plugin-cache.js";
import {
  getPreparedMessageToolCatalog,
  getPreparedMessageToolCatalogForRegistry,
} from "../plugins/prepared-message-tool-catalog.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { getPluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
} from "../plugins/registry-lifecycle.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import { resolveProviderBindingEnvVarCandidates } from "../secrets/provider-env-vars.js";
import type { AgentCredentialMap } from "./agent-auth-credentials.js";
import { prepareAmbientAgentCredentialsForDiscovery } from "./agent-auth-discovery.js";
import { discoverAuthStorageFacts } from "./agent-model-discovery.js";
import { withAgentRosterFactsBatch } from "./agent-scope-config.js";
import { getPreparedRuntimeAuthProfileStoreSnapshotCore } from "./auth-profiles/runtime-snapshots.js";
import { buildInlineProviderModels } from "./embedded-agent-runner/model.inline-provider.js";
import {
  createBundledStaticCatalogModelResolver,
  loadBundledProviderStaticCatalogContextModels,
} from "./embedded-agent-runner/model.static-catalog.js";
import { createStaticModelIdMatcher } from "./embedded-agent-runner/model.static-id.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { resolveSelectedModelProviderIds } from "./model-selection-config.js";
import {
  buildConfiguredModelCatalog,
  parseConfiguredModelVisibilityEntries,
} from "./model-selection-shared.js";
import { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import { resolvePluginModelCatalogOwnerPluginId } from "./plugin-model-catalog.js";
import { loadPreparedModelRuntimeAuthStore } from "./prepared-model-runtime.auth-store.js";
import type {
  PreparedModelRuntimeAgentBaseFacts,
  PreparedModelRuntimeAgentFacts,
} from "./prepared-model-runtime.catalog-contract.js";
import { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectConfiguredProviderIdsNeedingStaticCatalog,
  collectPreparedModelRuntimeProviderIds,
  prepareConfiguredRuntimeModels,
  prepareRuntimeCapabilityModels,
} from "./prepared-model-runtime.configured.js";
import {
  prepareWorkspacePluginRegistries,
  type PreparedInboundRegistryLoader,
} from "./prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { createPreparedPluginGeneration } from "./prepared-model-runtime.plugin-generation.js";
import { discardPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import type { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import {
  listPreparedSyntheticAuthProviderRefs,
  prepareSyntheticAuth,
  scopeSyntheticAuthProviderRefs,
} from "./prepared-model-runtime.synthetic-auth.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import { resolveProviderAuthAliasMap } from "./provider-auth-aliases.js";
import { resolveProviderUseAdmission } from "./provider-model-auth-source-plan.js";

function prepareAgentFacts(
  input: PreparedModelRuntimeInput,
  catalogMode: PreparedModelRuntimeCatalogMode,
  ambientCredentials: Readonly<AgentCredentialMap>,
  additionalProviderIds: readonly string[] = [],
  includeCredentialProviders = catalogMode === "live",
): PreparedModelRuntimeAgentBaseFacts {
  const env = input.env ?? process.env;
  const preparedStore = loadPreparedModelRuntimeAuthStore(input);
  const authFacts = discoverAuthStorageFacts(input.agentDir, {
    config: input.config,
    // Prepared owners consume only the already-published runtime auth generation. External CLI
    // hydration belongs to startup/control-plane and turn-time producers, never rebuilds.
    readOnly: true,
    ambientCredentials,
    ...(preparedStore ? { preparedStore } : {}),
    ...(input.skipCredentials ? { skipCredentials: true } : {}),
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
  });
  const credentials = authFacts.credentials;
  const requestedProviders = resolveSelectedModelProviderIds({
    cfg: input.config,
    agentId: input.agentId,
  });
  const admittedProviderIds = new Set(
    resolveProviderUseAdmission({
      config: input.config,
      env,
      profiles: authFacts.store.profiles,
      requestedProviders,
      storedCredentialAuthAliases: resolveProviderAuthAliasMap({
        ...input,
        storedCredential: true,
      }),
      nativeProviders: Object.entries(credentials).flatMap(([provider, credential]) =>
        credential.type === "api_key" && credential.nativeAuth ? [provider] : [],
      ),
      providerEnvVars: resolveProviderBindingEnvVarCandidates({ ...input, env }),
    }).keys(),
  );
  const templateAuthStorage = authFacts.authStorage;
  const rawConfiguredModelRefs = collectPreparedModelRuntimeConfiguredRefs(
    input.config,
    input.agentId,
  );
  return {
    input,
    env,
    authStore: authFacts.store,
    templateAuthStorage,
    credentials,
    admittedProviderIds,
    // Keep order and case-distinct refs: registry lookup remains exact-case even
    // where static/dynamic completion deduplicates case-insensitive merge keys.
    configuredModelRefs: rawConfiguredModelRefs.flatMap(({ value }) => {
      const ref = parseModelCatalogRef(value);
      return ref ? [ref] : [];
    }),
    // Gateway startup prepares only providers named by config/model selection. An unrelated
    // stored credential must not pull that provider's complete catalog into the admission path.
    providerIds: [
      ...new Set([
        ...requestedProviders,
        ...collectPreparedModelRuntimeProviderIds(
          input.config,
          admittedProviderIds,
          includeCredentialProviders,
          rawConfiguredModelRefs,
          input.agentId,
        ),
        ...parseConfiguredModelVisibilityEntries({
          cfg: input.config,
          agentId: input.agentId,
        }).providerWildcards,
        ...additionalProviderIds.map(normalizeProviderId).filter(Boolean),
      ]),
    ].toSorted((left, right) => left.localeCompare(right)),
  };
}

export async function prepareWorkspaceBuildGroup(
  inputs: readonly PreparedModelRuntimeInput[],
  catalogMode: PreparedModelRuntimeCatalogMode,
  options: {
    providerDiscoveryProviderIds?: readonly string[];
    preferBuiltPluginArtifacts?: boolean;
    includeCredentialProviders?: boolean;
    getConfiguredHarnessRuntimes?: () => readonly string[];
    basePluginIds?: readonly string[];
    onStage?: (stage: string) => void;
    registryResources?: PreparedModelRuntimeBuildResources;
  } = {},
  loadInboundPluginRegistry?: PreparedInboundRegistryLoader,
  reusablePluginGeneration?: PreparedModelRuntimePluginGeneration,
  preparedPluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
): Promise<{
  agentFacts: PreparedModelRuntimeAgentFacts[];
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  buildStats: Pick<
    PreparedModelRuntimeBuildStats,
    | "runtimePluginMs"
    | "pluginMetadataMs"
    | "staticProviderCatalogMs"
    | "ambientCredentialsMs"
    | "agentFactsMs"
    | "configuredProjectionMs"
  >;
}> {
  const input = inputs[0];
  if (!input) {
    throw new Error("prepared model runtime workspace group is empty");
  }
  const env = input.env ?? process.env;
  const reportStage = (stage: string) =>
    options.onStage?.(`${stage}; agent ${input.agentId ?? "standalone"}`);
  reportStage("workspace plugins");
  const pluginMetadataStartedAt = performance.now();
  const pluginMetadataSnapshot =
    preparedPluginMetadataSnapshot ??
    reusablePluginGeneration?.pluginMetadataSnapshot ??
    prepareOwnedPluginLoadContext(input, env, undefined);
  // Raw preparation owns its facts across awaited auth/catalog work. Successful
  // generations acquire their independent borrow before this build scope releases it.
  using _ = {
    [Symbol.dispose]: retainPluginCache(getPluginMetadataSnapshotCache(pluginMetadataSnapshot)),
  };
  const pluginMetadataMs = reusablePluginGeneration
    ? 0
    : performance.now() - pluginMetadataStartedAt;
  const runtimePluginStartedAt = performance.now();
  const preferBuiltPluginArtifacts =
    reusablePluginGeneration?.preferBuiltPluginArtifacts ??
    options.preferBuiltPluginArtifacts === true;
  options.registryResources?.retainGeneration(reusablePluginGeneration);
  const preparingRegistries = prepareWorkspacePluginRegistries(
    input,
    pluginMetadataSnapshot,
    loadInboundPluginRegistry,
    preferBuiltPluginArtifacts,
    reusablePluginGeneration,
    options.getConfiguredHarnessRuntimes,
    options.basePluginIds,
    options.registryResources,
  );
  const { inboundPluginRegistry, runtimePluginRegistry, primaryRegistry } =
    preparingRegistries instanceof Promise ? await preparingRegistries : preparingRegistries;
  const reuseRuntimeFacts =
    reusablePluginGeneration && runtimePluginRegistry === reusablePluginGeneration.pluginRegistry;
  const resources = primaryRegistry && getPluginRegistryInspectionResources(primaryRegistry);
  const mediaCapabilityProviderSource =
    primaryRegistry && resources
      ? Object.freeze({ registry: primaryRegistry, resources })
      : undefined;
  const runtimePluginMs = performance.now() - runtimePluginStartedAt;
  prepareOwnedPluginLoadContext(
    input,
    env,
    runtimePluginRegistry,
    pluginMetadataSnapshot,
    preferBuiltPluginArtifacts,
  );
  let preparedGeneration: PreparedModelRuntimePluginGeneration | undefined;
  const prepare = async () => {
    const matchesStaticModelId = createStaticModelIdMatcher({
      manifestPlugins: pluginMetadataSnapshot,
    });
    const mediaCapabilityProviders = reuseRuntimeFacts
      ? reusablePluginGeneration.mediaCapabilityProviders
      : input.readOnly || !runtimePluginRegistry
        ? undefined
        : prepareMediaCapabilityProviders({
            cfg: input.config,
            pluginMetadataSnapshot,
            registry: runtimePluginRegistry,
          });
    const messageToolCatalog = reuseRuntimeFacts
      ? reusablePluginGeneration.messageToolCatalog
      : runtimePluginRegistry
        ? getPreparedMessageToolCatalogForRegistry(runtimePluginRegistry)
        : catalogMode === "live"
          ? getPreparedMessageToolCatalog()
          : undefined;
    const resolveManifestStaticCatalogModel = createBundledStaticCatalogModelResolver({
      cfg: input.config,
      env,
      includeRuntimeDiscovery: true,
      metadataSnapshot: pluginMetadataSnapshot,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    });
    const configuredManifestModels = new Map<string, ProviderRuntimeModel | undefined>();
    const resolveConfiguredManifestModel = (lookup: { provider: string; modelId: string }) => {
      const key = `${normalizeProviderId(lookup.provider)}\0${lookup.modelId.trim().toLowerCase()}`;
      if (configuredManifestModels.has(key)) {
        return configuredManifestModels.get(key);
      }
      const model = resolveManifestStaticCatalogModel(lookup);
      configuredManifestModels.set(key, model);
      return model;
    };
    const configuredProviderIds = [
      ...new Set([
        ...inputs.flatMap(({ config, agentId }) =>
          withAgentRosterFactsBatch(config, () => [
            ...collectPreparedModelRuntimeProviderIds(
              config,
              [],
              false,
              collectPreparedModelRuntimeConfiguredRefs(config, agentId),
              agentId,
            ),
            ...parseConfiguredModelVisibilityEntries({ cfg: config, agentId }).providerWildcards,
          ]),
        ),
        ...(options.providerDiscoveryProviderIds ?? []).map(normalizeProviderId).filter(Boolean),
      ]),
    ].toSorted((left, right) => left.localeCompare(right));
    const staticCatalogProviderIds = [
      ...new Set([
        ...collectConfiguredProviderIdsNeedingStaticCatalog({
          config: input.config,
          matchesStaticModelId,
          resolveStaticCatalogModel: resolveConfiguredManifestModel,
        }),
        ...(options.providerDiscoveryProviderIds ?? []).map(normalizeProviderId).filter(Boolean),
      ]),
    ].toSorted((left, right) => left.localeCompare(right));
    const staticProviderCatalogStartedAt = performance.now();
    reportStage("static provider catalog");
    let preparedStaticProviderCatalog = reusablePluginGeneration
      ? reusablePluginGeneration.preparedStaticProviderCatalog
      : catalogMode === "static"
        ? await prepareImplicitProviderStaticCatalog({
            config: input.config,
            env,
            pluginMetadataSnapshot,
            providerDiscoveryProviderIds: configuredProviderIds,
            staticCatalogProviderIds,
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          })
        : undefined;
    if (
      catalogMode === "static" &&
      reusablePluginGeneration &&
      !reuseRuntimeFacts &&
      runtimePluginRegistry?.providers.length
    ) {
      // Selected owners may supply synthetic auth absent from startup's configured
      // providers. Carry those exact handles through refresh without rediscovery.
      preparedStaticProviderCatalog = Object.freeze({
        entries: preparedStaticProviderCatalog?.entries ?? [],
        providers: Object.freeze([
          ...new Map([
            ...(preparedStaticProviderCatalog?.providers ?? []).map(
              (provider) => [provider.id, provider] as const,
            ),
            ...runtimePluginRegistry.providers.map(
              ({ provider }) => [provider.id, provider] as const,
            ),
          ]).values(),
        ]),
      });
    }
    const staticProviderCatalogMs = reusablePluginGeneration
      ? 0
      : performance.now() - staticProviderCatalogStartedAt;
    const preparedSyntheticAuthProviders = preparedStaticProviderCatalog?.providers ?? [];
    // Static Gateway publication consumes discovery entrypoints; the run owns activation.
    const ambientCredentialsStartedAt = performance.now();
    reportStage("ambient credentials");
    const ambientCredentials = await prepareAmbientAgentCredentialsForDiscovery({
      config: input.config,
      env,
      authoritativeSyntheticAuthProviderRefs: pluginMetadataSnapshot.owners.cliBackends.keys(),
      syntheticAuthProviderRefs:
        catalogMode === "static"
          ? listPreparedSyntheticAuthProviderRefs(preparedSyntheticAuthProviders)
          : scopeSyntheticAuthProviderRefs(
              resolveRuntimeSyntheticAuthProviderRefs({
                config: input.config,
                env,
                index: pluginMetadataSnapshot.index,
                registryDiagnostics: pluginMetadataSnapshot.registryDiagnostics,
                ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
              }),
              configuredProviderIds,
            ),
      ...(catalogMode === "static"
        ? {
            resolveSyntheticAuth: (provider: string) =>
              prepareSyntheticAuth({
                config: input.config,
                env,
                workspaceDir: input.workspaceDir,
                provider,
                providers: preparedSyntheticAuthProviders,
              }),
          }
        : {}),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    });
    const ambientCredentialsMs = performance.now() - ambientCredentialsStartedAt;
    const agentFactsStartedAt = performance.now();
    reportStage("agent facts");
    const agentBaseFacts = inputs.map((candidate) =>
      withAgentRosterFactsBatch(candidate.config, () =>
        prepareAgentFacts(
          candidate,
          catalogMode,
          ambientCredentials,
          options.providerDiscoveryProviderIds,
          options.includeCredentialProviders,
        ),
      ),
    );
    const agentFactsMs = performance.now() - agentFactsStartedAt;
    const configuredProjectionStartedAt = performance.now();
    reportStage("configured model projection");
    const providerStaticModels =
      reusablePluginGeneration?.providerStaticModels ??
      (catalogMode === "static"
        ? []
        : await loadBundledProviderStaticCatalogContextModels({
            cfg: input.config,
            env,
            metadataSnapshot: pluginMetadataSnapshot,
            registeredProviders: runtimePluginRegistry?.providers,
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          }));
    // Provider definitions are process/config facts. Which refs are admitted remains agent-owned.
    const inlineProviderModels =
      reusablePluginGeneration?.inlineProviderModels ??
      buildInlineProviderModels(input.config.models?.providers ?? {}, {
        providerMetadataOwners: pluginMetadataSnapshot.owners,
      });
    const configuredCatalogEntries =
      reusablePluginGeneration?.configuredCatalogEntries ??
      buildConfiguredModelCatalog({
        cfg: input.config,
        manifestPlugins: pluginMetadataSnapshot,
        ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      });
    const agentFacts: PreparedModelRuntimeAgentFacts[] = [];
    for (const facts of agentBaseFacts) {
      const configuredRuntimeModels = prepareConfiguredRuntimeModels({
        config: facts.input.config,
        inlineProviderModels,
        configuredModelRefs: facts.configuredModelRefs,
        metadataSnapshot: pluginMetadataSnapshot,
        ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
        providerStaticModels,
        matchesStaticModelId,
        resolveStaticCatalogModel: resolveConfiguredManifestModel,
      });
      const runtimeCapabilityModels = prepareRuntimeCapabilityModels({
        config: facts.input.config,
        agentId: facts.input.agentId,
        candidates: [
          ...configuredCatalogEntries,
          ...configuredRuntimeModels.map(({ model, modelId, provider }) => ({
            ...modelCatalogRowToEntry(model),
            id: modelId,
            provider,
          })),
        ],
        resolveRuntimeModel: resolveConfiguredManifestModel,
      });
      const configuredGeneratedCatalogPluginIds = [
        ...new Set(
          (facts.input.config.models?.mode === "replace" ? [] : facts.providerIds).flatMap(
            (provider) => {
              const pluginId = resolvePluginModelCatalogOwnerPluginId({
                providerId: provider,
                pluginMetadataSnapshot,
              });
              return pluginId ? [pluginId] : [];
            },
          ),
        ),
      ].toSorted((left, right) => left.localeCompare(right));
      agentFacts.push({
        ...facts,
        configuredRuntimeModels,
        runtimeCapabilityModels,
        configuredGeneratedCatalogPluginIds,
      });
    }
    const configuredProjectionMs = performance.now() - configuredProjectionStartedAt;
    const pluginGeneration = createPreparedPluginGeneration({
      catalogMode,
      configuredCatalogEntries,
      inboundPluginRegistry,
      inlineProviderModels,
      mediaCapabilityProviders,
      mediaCapabilityProviderSource,
      messageToolCatalog,
      pluginMetadataSnapshot,
      preparedStaticProviderCatalog,
      providerStaticModels,
      preferBuiltPluginArtifacts,
      reusablePluginGeneration,
      runtimePluginRegistry,
    });
    preparedGeneration = pluginGeneration;
    return {
      agentFacts,
      buildStats: {
        runtimePluginMs,
        pluginMetadataMs,
        staticProviderCatalogMs,
        ambientCredentialsMs,
        agentFactsMs,
        configuredProjectionMs,
      },
      pluginGeneration,
    };
  };
  try {
    const run = () =>
      withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: pluginMetadataSnapshot,
          pluginRegistry: runtimePluginRegistry,
        },
        prepare,
      );
    if (!mediaCapabilityProviderSource) {
      return await run();
    }
    const isSourceCurrent = capturePluginLifecycleAuthority(
      mediaCapabilityProviderSource.registry,
      undefined,
      { scopedRuntime: true },
    );
    if (!isSourceCurrent?.()) {
      throw new Error("Prepared media capability provider source is retired");
    }
    const claim = mediaCapabilityProviderSource.resources.retain();
    let outcome: Result<Awaited<ReturnType<typeof prepare>>, unknown>;
    try {
      outcome = { ok: true, value: await run() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      // The caller still owns the original inspection; construction owns its actual awaited work.
      await claim.release();
    } catch (cleanupError) {
      outcome = {
        ok: false,
        error: outcome.ok
          ? cleanupError
          : new AggregateError(
              [outcome.error, cleanupError],
              "Prepared construction and registration cleanup failed",
              { cause: outcome.error },
            ),
      };
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    if (!isSourceCurrent()) {
      throw new Error("Prepared media capability provider source is retired");
    }
    return outcome.value;
  } catch (error) {
    const cleanup = preparedGeneration
      ? [discardPreparedPluginGeneration(preparedGeneration)]
      : [...new Set([runtimePluginRegistry, inboundPluginRegistry])].flatMap((registry) =>
          registry &&
          !getPluginRegistryInspectionResources(registry) &&
          !capturePluginRegistryLifecycleEpoch(registry)
            ? [disposePluginRegistryInstances(registry)]
            : [],
        );
    const results = await Promise.allSettled(cleanup);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError([error, ...failures], "Prepared plugin facts and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}

/** Record discovery scope before config projection or auth-owner publication can replace it. */
export function preparedModelInventoryKey(input: PreparedModelRuntimeInput): string {
  const { models, auth, env } = input.config;
  const plugins = normalizePluginsConfig(input.config.plugins);
  for (const entry of Object.values(plugins.entries)) {
    entry.config ??= {};
  }
  return fingerprintPreparedRuntimeFacts({
    ...input,
    config: { models, auth, env, plugins },
    env: input.env ?? process.env,
    runtimePluginSelections: undefined,
    order:
      getPreparedRuntimeAuthProfileStoreSnapshotCore(input.agentDir, input.inheritedAuthDir)
        ?.order ?? {},
  });
}
