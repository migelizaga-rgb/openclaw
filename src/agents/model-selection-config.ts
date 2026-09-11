/** Pure configured-model selection helpers safe for config validation. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-ref-shared.js";
import { resolveConfiguredModelFallbacks } from "./model-selection-resolve.js";
import {
  buildModelAliasIndex,
  normalizeModelSelection,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection-shared.js";

/** Selected primary/fallback identities exclude models listed only for browsing. */
export function resolveSelectedModelProviderIds(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Set<string> {
  const selection = {
    ...params,
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  };
  const primary = resolveDefaultModelForAgent(selection);
  const providers = new Set<string>();
  const rawPrimary = params.agentId
    ? resolveAgentEffectiveModelPrimary(params.cfg, params.agentId)
    : resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model);
  if (rawPrimary) {
    providers.add(normalizeProviderId(primary.provider));
  }
  const aliasIndex = buildModelAliasIndex({ ...selection, defaultProvider: primary.provider });
  for (const raw of resolveConfiguredModelFallbacks(selection)) {
    if (typeof raw !== "string") {
      continue;
    }
    const resolved = resolveModelRefFromString({
      ...selection,
      raw,
      defaultProvider: primary.provider,
      aliasIndex,
    });
    if (resolved) {
      providers.add(normalizeProviderId(resolved.ref.provider));
    }
  }
  return providers;
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
