import fs from "node:fs";
import path from "node:path";
import type { ModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { stableStringify } from "@openclaw/normalization-core";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolvePreparedProviderStaticConfigs } from "../plugins/provider-discovery.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { discoverModelsFromCapturedSources } from "./agent-model-discovery.js";
import type { InlineModelEntry } from "./embedded-agent-runner/model.inline-provider.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
} from "./prepared-model-runtime.catalog-contract.js";
import { completeConfiguredRuntimeModels } from "./prepared-model-runtime.configured-completion.js";
import type {
  PreparedConfiguredRuntimeModel,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import type { AuthStorage } from "./sessions/auth-storage.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

type ConfiguredCatalogAgentFacts = {
  input: { config: OpenClawConfig };
  configuredModelRefs: readonly ModelCatalogRef[];
};

type ConfiguredCatalogWorkspaceFacts = {
  pluginMetadataSnapshot: PluginMetadataSnapshot;
  inlineProviderModels: readonly InlineModelEntry[];
};

function createConfiguredModelCatalogSnapshot(params: {
  agentFacts: ConfiguredCatalogAgentFacts;
  workspaceFacts: ConfiguredCatalogWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): ModelCatalogSnapshot {
  const replace = params.agentFacts.input.config.models?.mode === "replace";
  const configuredEntries = dedupeByKey(
    [
      ...buildConfiguredModelCatalog({
        cfg: params.agentFacts.input.config,
        catalog:
          params.agentFacts.input.config.models?.mode === "replace"
            ? []
            : params.templateModelRegistry.getAll().map(modelCatalogRowToEntry),
        manifestPlugins: params.workspaceFacts.pluginMetadataSnapshot,
      }),
      ...(replace
        ? []
        : params.configuredRuntimeModels.map(({ model }) => modelCatalogRowToEntry(model))),
      ...(replace
        ? []
        : params.agentFacts.configuredModelRefs.flatMap(({ provider, modelId }) => {
            const model = params.templateModelRegistry.find(provider, modelId);
            return model ? [modelCatalogRowToEntry(model)] : [];
          })),
    ],
    resolveModelCatalogIdentityKey,
  );
  const staticEntries = (replace ? [] : params.configuredRuntimeModels).map(({ model }) =>
    modelCatalogRowToEntry(model),
  );
  return {
    entries: configuredEntries,
    routeVariants: configuredEntries,
    ...(staticEntries.length > 0 ? { staticEntries } : {}),
  };
}

export function prepareConfiguredRuntimeFacts(params: {
  agentFacts: ConfiguredCatalogAgentFacts;
  workspaceFacts: ConfiguredCatalogWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): PreparedModelRuntimeCatalogFacts {
  return {
    templateModelRegistry: params.templateModelRegistry,
    modelCatalog: createConfiguredModelCatalogSnapshot(params),
    configuredRuntimeModels: params.configuredRuntimeModels,
    inlineProviderModels: params.workspaceFacts.inlineProviderModels,
  };
}

/** Startup can expose captured rows; full refresh overlays only configured membership. */
export function prepareCapturedRuntimeFacts(
  params: Parameters<typeof prepareConfiguredRuntimeFacts>[0],
): PreparedModelRuntimeCatalogFacts {
  const facts = prepareConfiguredRuntimeFacts(params);
  if (params.agentFacts.input.config.models?.mode === "replace") {
    return facts;
  }
  const entries = dedupeByKey(
    [
      ...facts.modelCatalog.entries,
      ...params.templateModelRegistry.getAll().map(modelCatalogRowToEntry),
    ],
    resolveModelCatalogIdentityKey,
  );
  return { ...facts, modelCatalog: { ...facts.modelCatalog, entries, routeVariants: entries } };
}

type PreparedConfiguredRegistryGroup = {
  agentFacts: PreparedModelRuntimeAgentFacts[];
  modelsJsonContents: string | null;
  oauthProviders: ReturnType<AuthStorage["getOAuthProviders"]>;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
};

export function captureModelsJsonContents(agentDir: string): string | null {
  try {
    return fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
export const fingerprintPreparedRuntimeFacts = (value: unknown): string =>
  sha256Base64Url(stableStringify(value));

function hasSameOAuthProviderGeneration(
  left: ReturnType<AuthStorage["getOAuthProviders"]>,
  right: ReturnType<AuthStorage["getOAuthProviders"]>,
): boolean {
  // Match executable hooks by identity so distinct AuthStorage closure generations never merge.
  return (
    left.length === right.length &&
    left.every((provider, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        provider.id === candidate.id &&
        provider.name === candidate.name &&
        provider.usesCallbackServer === candidate.usesCallbackServer &&
        provider.login === candidate.login &&
        provider.refreshToken === candidate.refreshToken &&
        provider.getApiKey === candidate.getApiKey &&
        provider.modifyModels === candidate.modifyModels
      );
    })
  );
}

function groupConfiguredRegistrySources(
  agentFacts: readonly PreparedModelRuntimeAgentFacts[],
): PreparedConfiguredRegistryGroup[] {
  const groups = new Map<string, PreparedConfiguredRegistryGroup[]>();
  for (const facts of agentFacts) {
    const modelsJsonContents = captureModelsJsonContents(facts.input.agentDir);
    const oauthProviders = facts.templateAuthStorage.getOAuthProviders();
    // Root files remain authored inventory even when static preparation returned an empty result.
    const pluginCatalogs = loadPersistedPluginModelCatalogsReadOnly(
      facts.input.agentDir,
      facts.configuredGeneratedCatalogPluginIds,
    );
    const key = fingerprintPreparedRuntimeFacts({
      config: facts.input.config,
      sourceModels: projectConfigOntoRuntimeSourceSnapshot(facts.input.config).models,
      credentials: facts.credentials,
      admittedProviderIds: [...facts.admittedProviderIds].toSorted(),
      modelsJsonContents,
      pluginCatalogs,
    });
    const candidates = groups.get(key) ?? [];
    const group = candidates.find((candidate) =>
      hasSameOAuthProviderGeneration(candidate.oauthProviders, oauthProviders),
    );
    if (group) {
      group.agentFacts.push(facts);
    } else {
      candidates.push({
        agentFacts: [facts],
        modelsJsonContents,
        oauthProviders,
        pluginCatalogs,
      });
      groups.set(key, candidates);
    }
  }
  return [...groups.values()].flat();
}

export function prepareConfiguredRuntimeFactsBatch(params: {
  agentFacts: readonly PreparedModelRuntimeAgentFacts[];
  pluginGeneration: PreparedModelRuntimePluginGeneration;
}): {
  catalogs: Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>;
  registryCount: number;
} {
  const catalogs = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>();
  let registryCount = 0;
  const staticProviderConfigs = resolvePreparedProviderStaticConfigs(
    params.pluginGeneration.preparedStaticProviderCatalog,
  );
  for (const group of groupConfiguredRegistrySources(params.agentFacts)) {
    const representative = group.agentFacts[0];
    if (!representative) {
      continue;
    }
    // Parse identical catalog/auth sources once, then fork request auth.
    const templateModelRegistry = discoverModelsFromCapturedSources(
      representative.templateAuthStorage,
      {
        config: representative.input.config,
        includePluginCatalogs: true,
        modelsJsonContents: group.modelsJsonContents,
        pluginCatalogs: group.pluginCatalogs,
        admittedProviderIds: representative.admittedProviderIds,
        staticProviderConfigs,
        pluginMetadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
        ...(representative.input.workspaceDir
          ? { workspaceDir: representative.input.workspaceDir }
          : {}),
      },
    );
    registryCount += 1;
    for (const facts of group.agentFacts) {
      const configuredRuntimeModels = completeConfiguredRuntimeModels(
        facts,
        params.pluginGeneration,
        templateModelRegistry,
      );
      catalogs.set(
        facts.input,
        prepareCapturedRuntimeFacts({
          agentFacts: facts,
          workspaceFacts: params.pluginGeneration,
          templateModelRegistry,
          configuredRuntimeModels,
        }),
      );
    }
  }
  return { catalogs, registryCount };
}
