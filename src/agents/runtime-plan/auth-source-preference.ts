/** Prepares credential source facts, retained preferences, and unavailable-source diagnostics. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ConfigProviderUseBindings } from "../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { isPendingOAuthRefreshFence } from "../auth-profiles/oauth-refresh-marker.js";
import {
  isStoredCredentialCompatibleWithAuthProvider,
  resolveAuthProfileEligibility,
} from "../auth-profiles/order.js";
import { resolveStoredCredentialReadOnlyAvailability } from "../auth-profiles/read-only-availability.js";
import { isSetupCredentialAccessActive } from "../auth-profiles/setup-access.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  isProfileInCooldown,
  readInlineProviderApiKeyUsage,
} from "../auth-profiles/usage-state.js";
import { resolveProviderDirectAuthPlanningEvidence } from "../model-auth-env.js";
import { ProviderAuthError } from "../model-auth-runtime-shared.js";
import { buildProviderAuthRecoveryHint } from "../provider-auth-recovery-hint.js";
import {
  buildProviderModelAuthDirectSource,
  type ProviderModelAuthDirectSource,
  type ProviderModelAuthProfileSource,
  type ProviderUseBinding,
} from "../provider-model-auth-source-plan.js";

export function resolveAutomaticDirectAuthFallback(params: {
  provider: string;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  directUseBinding?: ProviderUseBinding;
  environmentBinding?: Extract<ProviderUseBinding, { kind: "environment" }>;
  harnessAllowsAuthProfileForwarding: boolean;
  configuredAuthMode?: string;
  providerHasDirectMaterial: boolean;
  providerBindingNeedsNonProfileFallback: boolean;
  userPinnedProfileId?: string;
  defaultSource: ProviderModelAuthDirectSource;
}) {
  const binding = params.directUseBinding;
  const candidate =
    params.harnessAllowsAuthProfileForwarding && binding
      ? resolveProviderDirectAuthPlanningEvidence(params.provider, params.env, {
          config: params.config,
          workspaceDir: params.workspaceDir,
          metadataSnapshot: params.metadataSnapshot,
          ...(binding.kind === "environment"
            ? {
                aliasMap: {},
                candidateMap: { [normalizeProviderId(params.provider)]: [binding.envVar] },
                authEvidenceMap: {},
                setupProviderFallbackRefs: [],
              }
            : {}),
        })
      : null;
  // Native OpenAI accounts are harness-owned, not bearer material for a host request.
  const evidence =
    candidate?.kind === "setup-provider" && params.provider.trim().toLowerCase() === "openai"
      ? null
      : candidate;
  const directPlanningMode = evidence ? (params.configuredAuthMode ?? evidence.mode) : undefined;
  const ambient = evidence?.kind === "environment" && !params.providerHasDirectMaterial;
  const fallbackDirectSource = directPlanningMode
    ? buildProviderModelAuthDirectSource({
        mode: directPlanningMode,
        evidence: evidence?.kind === "environment" ? "environment" : "runtime",
        availability: evidence?.kind === "environment" ? true : undefined,
        authorization: ambient ? "ambient" : "declared",
        boundEnvVar:
          ambient && !params.userPinnedProfileId && !isSetupCredentialAccessActive()
            ? params.environmentBinding?.envVar
            : undefined,
      })
    : params.providerBindingNeedsNonProfileFallback
      ? params.defaultSource
      : undefined;
  return { fallbackDirectSource, directPlanningMode };
}

export function resolveAutomaticAuthSourcePreference(params: {
  provider: string;
  env: NodeJS.ProcessEnv;
  store?: AuthProfileStore;
  generatedBinding?: ConfigProviderUseBindings[string];
  directUseBinding?: ProviderUseBinding;
  environmentBinding?: Extract<ProviderUseBinding, { kind: "environment" }>;
  userPinnedProfileId?: string;
  preferredAuthProfileId?: string;
  preferredDirectSource?: ProviderModelAuthDirectSource;
  fallbackDirectSource?: ProviderModelAuthDirectSource;
  selectedAuthMode?: string;
  explicitOrder: boolean;
}) {
  const directInCooldown = Boolean(
    params.store &&
    (readInlineProviderApiKeyUsage(params.store, params.provider).unusableUntil ?? 0) > Date.now(),
  );
  const binding = params.generatedBinding;
  const generatedDirectSource =
    binding && !params.userPinnedProfileId
      ? buildProviderModelAuthDirectSource({
          mode: params.selectedAuthMode,
          evidence: binding.apiKey?.source === "env" ? "environment" : "runtime",
          availability: directInCooldown
            ? false
            : binding.apiKey?.source === "env"
              ? Boolean(params.env[binding.apiKey.id]?.trim())
              : undefined,
          authorization: "declared",
          boundEnvVar: binding.apiKey?.source === "env" ? binding.apiKey.id : undefined,
        })
      : undefined;
  const retainedDirectSource =
    !params.preferredAuthProfileId && !params.userPinnedProfileId
      ? (params.preferredDirectSource ?? generatedDirectSource)
      : undefined;
  const preferredDirectSource =
    retainedDirectSource &&
    params.directUseBinding &&
    (!retainedDirectSource.boundEnvVar ||
      retainedDirectSource.boundEnvVar === params.environmentBinding?.envVar ||
      retainedDirectSource.boundEnvVar === binding?.apiKey?.id)
      ? {
          ...retainedDirectSource,
          readiness:
            directInCooldown ||
            (retainedDirectSource.boundEnvVar &&
              !params.env[retainedDirectSource.boundEnvVar]?.trim())
              ? ("unavailable" as const)
              : retainedDirectSource.readiness,
        }
      : undefined;
  const retainedProfileId = params.explicitOrder ? undefined : params.preferredAuthProfileId;
  const fallbackSource = binding
    ? retainedProfileId && generatedDirectSource?.readiness !== "unavailable"
      ? generatedDirectSource
      : undefined
    : params.fallbackDirectSource;
  return { preferredDirectSource, retainedProfileId, fallbackSource };
}

export function createUnavailableAutomaticAuthError(params: {
  provider: string;
  authProvider: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  store?: AuthProfileStore;
  preferredAuthProfileId?: string;
}): ProviderAuthError {
  const profiles = Object.entries(params.store?.profiles ?? {})
    .filter(([, credential]) =>
      isStoredCredentialCompatibleWithAuthProvider({
        cfg: params.config,
        authAliasLookupParams: params,
        provider: params.authProvider,
        credential,
      }),
    )
    .map(([profileId]) => {
      const eligibility =
        params.store &&
        resolveAuthProfileEligibility({
          cfg: params.config,
          authAliasLookupParams: params,
          provider: params.authProvider,
          store: params.store,
          profileId,
        });
      return `"${profileId}"${eligibility?.reasonCode === "expired" ? " (expired)" : " (unavailable)"}`;
    });
  if (params.preferredAuthProfileId && !params.store?.profiles[params.preferredAuthProfileId]) {
    profiles.unshift(`"${params.preferredAuthProfileId}" (not saved)`);
  }
  const checkedProfiles = profiles.length
    ? `Checked profiles: ${profiles.join(", ")}.`
    : "No saved auth profiles are available.";
  return new ProviderAuthError(
    "missing-provider-auth",
    params.provider,
    `No usable authentication for provider "${params.provider}". ${checkedProfiles} ${buildProviderAuthRecoveryHint(params)}`,
  );
}

export function resolvePreparedAuthProfileSource(
  params: {
    authProfileStore?: AuthProfileStore;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    modelId: string;
  },
  profileId: string,
  options: { ignoreCooldown?: boolean } = {},
): ProviderModelAuthProfileSource {
  const credential = params.authProfileStore?.profiles[profileId];
  const configured = params.config?.auth?.profiles?.[profileId];
  const availability = credential
    ? resolveStoredCredentialReadOnlyAvailability({
        credential,
        cfg: params.config ?? {},
        env: params.env ?? process.env,
      })
    : undefined;
  const pendingOAuthRefresh =
    credential?.type === "oauth" && isPendingOAuthRefreshFence(credential);
  return {
    kind: "profile",
    profileId,
    provider: credential?.provider ?? configured?.provider,
    mode: credential?.type ?? configured?.mode,
    // Runtime materialization owns secret readiness; only proven-invalid facts are terminal here.
    readiness: availability === false && !pendingOAuthRefresh ? "unavailable" : "unknown",
    cooldown:
      !options.ignoreCooldown &&
      params.authProfileStore &&
      isProfileInCooldown(params.authProfileStore, profileId, undefined, params.modelId)
        ? "active"
        : "clear",
  };
}
