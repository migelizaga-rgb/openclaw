/** Pure configured-model selection helpers safe for config validation. */
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSelectedModelFallbacksOverride } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAgentEntriesWithSource } from "./agent-scope-config.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-ref-shared.js";
import {
  buildModelAliasIndex,
  normalizeModelSelection,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection-shared.js";

function hasSelectedOverride(entry: unknown, fields: readonly string[]): boolean {
  let current = entry;
  for (const field of fields) {
    if (current === undefined || current === null) {
      return false;
    }
    if (typeof current !== "object" || Array.isArray(current)) {
      return true;
    }
    current = asNullableRecord(current)?.[field];
  }
  return current !== undefined;
}

/** Executable selectors in one agent scope; an omitted agent reads defaults and globals. */
export function collectSelectedModelProviders(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): { provider: string; model: string; profileId?: string; path: string; mainModel: boolean }[] {
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const local = agentId
    ? listAgentEntriesWithSource(params.cfg).find(
        ({ entry }) => normalizeAgentId(entry.id) === agentId,
      )
    : undefined;
  const localPrefix = agentId
    ? local?.source.kind === "list"
      ? `agents.list.${local.source.index}.`
      : `agents.entries.${local?.source.kind === "entries" ? local.source.key : agentId}.`
    : undefined;
  const selection = {
    ...params,
    agentId,
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  };
  const primary = resolveDefaultModelForAgent(selection);
  const providers: ReturnType<typeof collectSelectedModelProviders> = [];
  const aliasIndex = buildModelAliasIndex({ ...selection, defaultProvider: primary.provider });
  for (const ref of collectConfiguredModelRefs(params.cfg)) {
    let suffix: string | undefined;
    if (ref.path.startsWith("agents.defaults.")) {
      suffix = ref.path.slice("agents.defaults.".length);
      const fallbackSelector = suffix.startsWith("model.fallbacks.")
        ? local?.entry.model
        : suffix.startsWith("subagents.model.fallbacks.")
          ? local?.entry.subagents?.model
          : undefined;
      if (
        resolveSelectedModelFallbacksOverride(fallbackSelector) !== undefined ||
        hasSelectedOverride(local?.entry, suffix.split("."))
      ) {
        continue;
      }
    } else if (localPrefix && ref.path.startsWith(localPrefix)) {
      suffix = ref.path.slice(localPrefix.length);
    } else if (ref.path.startsWith("agents.")) {
      continue;
    } else if (hasSelectedOverride(local?.entry, ref.path.split("."))) {
      continue;
    }
    if (suffix?.startsWith("models.")) {
      continue;
    }
    const resolved = resolveModelRefFromString({
      ...selection,
      raw: ref.value,
      defaultProvider: primary.provider,
      aliasIndex,
    });
    if (resolved) {
      const resolvedModel = splitTrailingAuthProfile(resolved.ref.model);
      const profileId = splitTrailingAuthProfile(ref.value).profile ?? resolvedModel.profile;
      providers.push({
        provider: normalizeProviderId(resolved.ref.provider),
        model: resolvedModel.model,
        ...(profileId ? { profileId } : {}),
        path: ref.path,
        mainModel: suffix === "model" || suffix?.startsWith("model.") === true,
      });
    }
  }
  return providers;
}

/** Model aliases listed only for browsing do not select a provider. */
export function resolveSelectedModelProviderIds(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Set<string> {
  return new Set(collectSelectedModelProviders(params).map(({ provider }) => provider));
}

export function resolveDefaultModelForAgent(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef {
  return resolveConfiguredModelRef({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
}

export function resolveSubagentConfiguredModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  includeAgentPrimary?: boolean;
}): string | undefined {
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  return (
    normalizeModelSelection(agentConfig?.subagents?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ??
    (params.includeAgentPrimary === false ? undefined : normalizeModelSelection(agentConfig?.model))
  );
}
