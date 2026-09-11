/**
 * Prepares route-aware auth forwarding for agent-runtime calls.
 * Callers supply an already loaded credential snapshot; this module never
 * resolves secrets or loads a provider runtime.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveMergedModelProviderConfig } from "../../config/model-provider-config.js";
import { getConfigProviderUseBindings } from "../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRouteOverridePresence } from "../../plugin-sdk/provider-model-types.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderBindingEnvVarCandidates } from "../../secrets/provider-env-vars.js";
import {
  prependAuthProfilePin,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrderWithMetadata,
} from "../auth-profiles/order.js";
import { createSelectedAuthProfileUnavailableError } from "../auth-profiles/selection-error.js";
import { isSetupCredentialAccessActive } from "../auth-profiles/setup-access.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isProfileInCooldown } from "../auth-profiles/usage-state.js";
import {
  resolveProviderConfigSecretInput,
  hasUsableCustomProviderApiKey,
  resolveProviderEntryApiKeyProfileReference,
  shouldPreferExplicitConfigApiKeyAuth,
} from "../model-auth-provider-config.js";
import { resolveModelProviderAuthConfig } from "../model-auth-provider-route.js";
import { ProviderAuthError } from "../model-auth-runtime-shared.js";
import { resolveOpenAIModelRoutes, selectOpenAIModelRouteAuth } from "../openai-model-routes.js";
import { resolveProviderAuthAliasMap } from "../provider-auth-aliases.js";
import {
  buildProviderModelAuthDirectSource,
  buildProviderModelAuthSourcePlan,
  classifyProviderModelAuthSource,
  resolveProviderEnvironmentAdmission,
  resolveProviderUseAdmission,
  type ProviderModelAuthDirectSource,
} from "../provider-model-auth-source-plan.js";
import { selectProviderModelAuthSources } from "../provider-model-route-auth.js";
import {
  resolvePreparedAuthProfileSource,
  resolveAutomaticAuthSourcePreference,
  resolveAutomaticDirectAuthFallback,
  createUnavailableAutomaticAuthError,
} from "./auth-source-preference.js";
import { buildAgentRuntimeAuthPlan } from "./auth.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

type PrepareAgentRuntimeAuthPlanParams = {
  provider: string;
  modelId: string;
  modelApi?: string | null;
  modelBaseUrl?: unknown;
  requestTransportOverrides?: ProviderRouteOverridePresence;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  authProfileStore?: AuthProfileStore;
  sessionAuthProfileId?: string;
  sessionAuthProfileSource?: "auto" | "user" | "user-link";
  allowAuthProfileFallback?: boolean;
  harnessId?: string;
  harnessRuntime?: string;
  harnessAuthBootstrap?: "harness";
  allowHarnessAuthProfileForwarding?: boolean;
  allowTransientCooldownProbe?: boolean;
  preferredDirectSource?: ProviderModelAuthDirectSource;
  preferredAuthProfileId?: string;
  resolveProviderPreferredProfileId?(context: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    provider: string;
    modelId: string;
    preferredProfileId?: string;
    lockedProfileId?: string;
    profileOrder: string[];
    authStore: AuthProfileStore;
  }): string | undefined;
};

export type PreparedAgentRuntimeAuthAttempt =
  | {
      kind: "profile";
      plan: AgentRuntimeAuthPlan;
      profileId: string;
      allowAuthProfileFallback?: never;
      requiresPriorProfileAttempt?: never;
    }
  | {
      kind: "direct";
      plan: AgentRuntimeAuthPlan;
      profileId?: never;
      /** Direct lookup cannot re-enter automatic profile discovery. */
      allowAuthProfileFallback: false;
      /** Fail closed when every prepared profile became cooldown-blocked before dispatch. */
      requiresPriorProfileAttempt: boolean;
    }
  | {
      kind: "implicit";
      plan: AgentRuntimeAuthPlan;
      profileId?: never;
      allowAuthProfileFallback?: never;
      requiresPriorProfileAttempt?: never;
    };

export type PreparedAgentRuntimeAuth = {
  plan: AgentRuntimeAuthPlan;
  /** Ordered physical attempts; every route/profile tuple was selected by this planner. */
  attempts: readonly PreparedAgentRuntimeAuthAttempt[];
};

/** Prevents a direct fallback from bypassing a prepared profile tier. */
export function canRunPreparedAgentRuntimeAuthAttempt(params: {
  attempt: PreparedAgentRuntimeAuthAttempt;
  priorProfileAttempted: boolean;
}): boolean {
  return (
    params.attempt.kind !== "direct" ||
    !params.attempt.requiresPriorProfileAttempt ||
    params.priorProfileAttempted
  );
}

/** Rechecks automatic cooldowns immediately before a prepared profile attempt. */
export function preparedAgentRuntimeProfileAttemptHasCandidate(params: {
  attempt: PreparedAgentRuntimeAuthAttempt;
  store: AuthProfileStore;
  modelId: string;
}): boolean {
  if (params.attempt.kind !== "profile") {
    return false;
  }
  const profileIds = params.attempt.plan.forwardedAuthProfileCandidateIds ?? [
    params.attempt.profileId,
  ];
  return profileIds.some(
    (profileId) => !isProfileInCooldown(params.store, profileId, undefined, params.modelId),
  );
}

/** True when a prepared auth tuple can be reused for this exact compaction target. */
export function agentRuntimeAuthPlanMatchesTarget(
  plan: AgentRuntimeAuthPlan,
  target: { provider: string; modelId: string },
): boolean {
  const route = plan.modelRoute;
  const provider = route?.provider ?? plan.providerForAuth;
  const modelId = route?.modelId ?? plan.modelId;
  return (
    modelId !== undefined &&
    provider.trim().toLowerCase() === target.provider.trim().toLowerCase() &&
    modelId === target.modelId
  );
}

/** Applies terminal provider-entry credential policy before route selection. */
function resolvePreparedProviderEntryApiKeyProfileReference(
  params: PrepareAgentRuntimeAuthPlanParams & { store: AuthProfileStore },
) {
  const reference = resolveProviderEntryApiKeyProfileReference({
    cfg: params.config,
    authAliasLookupParams: params,
    provider: params.provider,
    store: params.store,
  });
  if (reference.kind !== "profile") {
    return reference;
  }
  const eligibility = resolveAuthProfileEligibility({
    cfg: params.config,
    authAliasLookupParams: params,
    store: params.store,
    provider: params.provider,
    profileId: reference.profileId,
  });
  if (!eligibility.eligible) {
    throw new Error(
      `Per-entry apiKey profile "${reference.profileId}" has no usable credentials for ${params.provider}.`,
    );
  }
  if (isProfileInCooldown(params.store, reference.profileId, undefined, params.modelId)) {
    throw new Error(
      `Auth profile "${reference.profileId}" is temporarily unavailable for ${params.provider}/${params.modelId}.`,
    );
  }
  return reference;
}

/** Selects concrete provider routes and ordered credentials as one immutable preparation. */
export function prepareAgentRuntimeAuth(
  input: PrepareAgentRuntimeAuthPlanParams,
): PreparedAgentRuntimeAuth {
  const params = { ...input, config: resolveModelProviderAuthConfig(input) };
  const providerEnvVars = resolveProviderBindingEnvVarCandidates(input);
  // Route projection may add a provider entry; only authored config grants use.
  const providerUseAdmission = resolveProviderUseAdmission({
    config: input.config,
    env: input.env,
    providerEnvVars,
    profiles: input.authProfileStore?.profiles,
    requestedProviders: [input.provider],
    storedCredentialAuthAliases: resolveProviderAuthAliasMap({ ...params, storedCredential: true }),
  });
  const requestedProfileId = params.sessionAuthProfileId?.trim() || undefined;
  const userPinnedProfileId =
    params.sessionAuthProfileSource === "user" || params.sessionAuthProfileSource === "user-link"
      ? requestedProfileId
      : undefined;
  const generatedBinding = userPinnedProfileId
    ? undefined
    : getConfigProviderUseBindings(input.config)[normalizeProviderId(input.provider)];
  const harnessOwnsOpenAIAuth =
    params.harnessId?.trim().toLowerCase() === "codex" ||
    params.harnessRuntime?.trim().toLowerCase() === "codex";
  const harnessAuthOwnerId = params.harnessId?.trim() || params.harnessRuntime?.trim();
  const runtimeAuthOwner =
    harnessOwnsOpenAIAuth && params.harnessAuthBootstrap === "harness" && harnessAuthOwnerId
      ? { id: harnessAuthOwnerId }
      : undefined;
  const harnessAllowsAuthProfileForwarding = params.allowHarnessAuthProfileForwarding !== false;
  if (userPinnedProfileId && !harnessAllowsAuthProfileForwarding) {
    throw new Error(
      `Auth profile "${userPinnedProfileId}" cannot be forwarded to the selected agent harness. Configure that harness's native account instead.`,
    );
  }
  const store = params.authProfileStore;
  const authProfileSelectionProvider = harnessOwnsOpenAIAuth ? "openai" : params.provider;
  const providerUseBinding =
    providerUseAdmission.get(normalizeProviderId(input.provider)) ??
    (harnessOwnsOpenAIAuth ? providerUseAdmission.get("openai") : undefined);
  const environmentBinding = resolveProviderEnvironmentAdmission({
    env: input.env,
    providerEnvVars,
  }).bindings.get(normalizeProviderId(authProfileSelectionProvider));
  const directUseBinding =
    providerUseBinding?.kind === "profile"
      ? isSetupCredentialAccessActive()
        ? undefined
        : environmentBinding
      : providerUseBinding;
  if (userPinnedProfileId) {
    const eligibility = store
      ? resolveAuthProfileEligibility({
          cfg: params.config,
          authAliasLookupParams: params,
          store,
          provider: authProfileSelectionProvider,
          profileId: userPinnedProfileId,
          includePendingOAuthRefresh: true,
        })
      : { eligible: false };
    if (!eligibility.eligible) {
      if (
        !store?.profiles[userPinnedProfileId] &&
        params.config?.auth?.profiles?.[userPinnedProfileId]?.mode !== "aws-sdk"
      ) {
        throw createSelectedAuthProfileUnavailableError({
          profileId: userPinnedProfileId,
          provider: authProfileSelectionProvider,
          modelId: params.modelId,
        });
      }
      throw new Error(
        `Auth profile "${userPinnedProfileId}" is not configured for ${authProfileSelectionProvider}.`,
      );
    }
  }

  if (!providerUseBinding && !runtimeAuthOwner) {
    throw new ProviderAuthError(
      "missing-provider-auth",
      params.provider,
      `Provider "${params.provider}" is not configured for model use. Add a provider entry or authenticate this provider.`,
    );
  }

  const configuredProvider = resolveMergedModelProviderConfig(params.config, params.provider);
  const configuredAuthMode =
    userPinnedProfileId || !harnessAllowsAuthProfileForwarding
      ? undefined
      : configuredProvider?.auth;
  const configuredAwsSdkAuth = configuredAuthMode === "aws-sdk";
  const providerApiKeySecretRef =
    harnessAllowsAuthProfileForwarding && !userPinnedProfileId
      ? resolveProviderConfigSecretInput(params.config, params.provider).ref
      : undefined;
  const providerHasApiKeySecretRef = Boolean(providerApiKeySecretRef);
  const providerBinding =
    harnessAllowsAuthProfileForwarding && !userPinnedProfileId && store && !configuredAwsSdkAuth
      ? resolvePreparedProviderEntryApiKeyProfileReference({
          ...params,
          store,
        })
      : { kind: "none" as const };
  if (providerBinding.kind === "profile-incompatible") {
    throw new Error(
      `Per-entry apiKey "${providerBinding.profileId}" is not a compatible bearer profile for ${params.provider}.`,
    );
  }
  const boundProfileId = providerBinding.kind === "profile" ? providerBinding.profileId : undefined;
  const providerHasUsableMarker =
    providerBinding.kind === "marker" &&
    hasUsableCustomProviderApiKey(params.config, params.provider, params.env);
  const providerHasDirectMaterial =
    !configuredAwsSdkAuth &&
    (providerBinding.kind === "literal" || providerHasUsableMarker || providerHasApiKeySecretRef);
  const explicitConfigApiKeyAuth = shouldPreferExplicitConfigApiKeyAuth(
    params.config,
    params.provider,
  );
  const providerBindingSuppressesProfiles =
    !generatedBinding &&
    ((providerBinding.kind === "literal" && explicitConfigApiKeyAuth) ||
      providerHasUsableMarker ||
      providerHasApiKeySecretRef);
  const providerBindingNeedsNonProfileFallback =
    providerHasDirectMaterial && !providerBindingSuppressesProfiles;
  // Explicit auth owns the physical route; apiKey is only its bearer material.
  const selectedConfiguredAuthMode =
    configuredAuthMode ?? (providerHasDirectMaterial ? "api-key" : undefined);
  const selectedProfileId =
    boundProfileId ?? (params.allowAuthProfileFallback === false ? userPinnedProfileId : undefined);
  const resolvedAutomaticOrder =
    !harnessAllowsAuthProfileForwarding ||
    selectedProfileId ||
    providerBindingSuppressesProfiles ||
    configuredAwsSdkAuth ||
    !store
      ? {
          profileIds: selectedProfileId ? [selectedProfileId] : [],
          hasExplicitOrder: false,
        }
      : resolveAuthProfileOrderWithMetadata({
          cfg: params.config,
          authAliasLookupParams: params,
          store,
          provider: authProfileSelectionProvider,
          preferredProfile: requestedProfileId,
          forModel: params.modelId,
          readinessMode: "read-only",
          includePendingOAuthRefresh: true,
        });
  const automaticOrderResolution = prependAuthProfilePin(
    providerUseBinding?.kind === "profile" &&
      normalizeProviderId(store?.profiles[providerUseBinding.profileId]?.provider ?? "") ===
        normalizeProviderId(authProfileSelectionProvider)
      ? {
          ...resolvedAutomaticOrder,
          profileIds: resolvedAutomaticOrder.profileIds.filter(
            (id) =>
              normalizeProviderId(store?.profiles[id]?.provider ?? "") ===
              normalizeProviderId(authProfileSelectionProvider),
          ),
        }
      : resolvedAutomaticOrder,
    userPinnedProfileId,
  );
  const providerPreferredProfileId =
    harnessAllowsAuthProfileForwarding &&
    !selectedProfileId &&
    !userPinnedProfileId &&
    !providerBindingSuppressesProfiles &&
    !configuredAwsSdkAuth &&
    store
      ? params.resolveProviderPreferredProfileId?.({
          config: params.config,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          provider: params.provider,
          modelId: params.modelId,
          preferredProfileId: requestedProfileId,
          lockedProfileId: undefined,
          profileOrder: automaticOrderResolution.profileIds,
          authStore: store,
        })
      : undefined;
  const resolvedOrderedProfileIds =
    providerPreferredProfileId &&
    automaticOrderResolution.profileIds.includes(providerPreferredProfileId)
      ? [
          providerPreferredProfileId,
          ...automaticOrderResolution.profileIds.filter(
            (profileId) => profileId !== providerPreferredProfileId,
          ),
        ]
      : automaticOrderResolution.profileIds;
  const directSource = (
    mode: string | undefined,
    evidence: ProviderModelAuthDirectSource["evidence"] = providerBinding.kind === "marker" &&
    providerHasUsableMarker
      ? providerBinding.evidence
      : providerApiKeySecretRef?.source === "env"
        ? "environment"
        : "provider-config",
    availability?: boolean,
    authorization: ProviderModelAuthDirectSource["authorization"] = "declared",
    boundEnvVar?: string,
  ) =>
    buildProviderModelAuthDirectSource({
      mode,
      evidence,
      availability,
      authorization,
      boundEnvVar,
    });
  const { fallbackDirectSource, directPlanningMode } = resolveAutomaticDirectAuthFallback({
    ...params,
    provider: authProfileSelectionProvider,
    env: params.env ?? process.env,
    directUseBinding,
    environmentBinding,
    harnessAllowsAuthProfileForwarding,
    configuredAuthMode,
    providerHasDirectMaterial,
    providerBindingNeedsNonProfileFallback,
    userPinnedProfileId,
    defaultSource: directSource(selectedConfiguredAuthMode),
  });
  const { preferredDirectSource, retainedProfileId, fallbackSource } =
    resolveAutomaticAuthSourcePreference({
      ...params,
      env: params.env ?? process.env,
      store,
      generatedBinding,
      directUseBinding,
      environmentBinding,
      userPinnedProfileId,
      fallbackDirectSource,
      selectedAuthMode: selectedConfiguredAuthMode ?? directPlanningMode,
      explicitOrder: automaticOrderResolution.hasExplicitOrder,
    });
  const automaticRouteAuthMode =
    generatedBinding ||
    (fallbackDirectSource && configuredAuthMode && !providerBindingSuppressesProfiles)
      ? undefined
      : selectedConfiguredAuthMode;
  const ownership = selectedProfileId
    ? {
        reason:
          selectedProfileId === userPinnedProfileId
            ? ("runtime-binding" as const)
            : ("provider-binding" as const),
        source: resolvePreparedAuthProfileSource(params, selectedProfileId, {
          ignoreCooldown: true,
        }),
      }
    : configuredAwsSdkAuth
      ? {
          reason: "configured-auth" as const,
          source: directSource("aws-sdk", "aws-sdk"),
        }
      : providerBindingSuppressesProfiles
        ? {
            reason: "configured-auth" as const,
            source: directSource(selectedConfiguredAuthMode),
          }
        : undefined;
  const sourcePlan = buildProviderModelAuthSourcePlan({
    ...(ownership ? { ownership } : {}),
    profiles: resolvedOrderedProfileIds.map((profileId) =>
      resolvePreparedAuthProfileSource(params, profileId),
    ),
    ...(userPinnedProfileId || retainedProfileId || providerPreferredProfileId
      ? {
          preferredProfileId:
            userPinnedProfileId ?? retainedProfileId ?? providerPreferredProfileId,
        }
      : {}),
    explicitOrder: automaticOrderResolution.hasExplicitOrder,
    ...(fallbackSource ? { fallback: fallbackSource } : {}),
    ...(preferredDirectSource ? { preferredDirectSource } : {}),
    allowCooldown: params.allowTransientCooldownProbe,
  });
  const retainAutomaticAuthSource =
    sourcePlan.kind === "automatic" &&
    !sourcePlan.profiles.explicitOrder &&
    !userPinnedProfileId &&
    (!providerHasDirectMaterial || Boolean(generatedBinding)) &&
    !configuredAuthMode;
  const sourceDecision = selectProviderModelAuthSources({
    provider: authProfileSelectionProvider,
    plan: sourcePlan,
  });
  if (
    (providerUseBinding?.kind === "profile" ||
      generatedBinding ||
      params.preferredAuthProfileId ||
      params.preferredDirectSource) &&
    sourcePlan.kind === "automatic" &&
    !sourcePlan.profiles.explicitOrder &&
    (sourceDecision.kind === "rejected" || sourceDecision.attempts.length === 0)
  ) {
    throw createUnavailableAutomaticAuthError({
      ...params,
      authProvider: authProfileSelectionProvider,
      store,
    });
  }
  const resolution = resolveOpenAIModelRoutes({
    provider: params.provider,
    modelId: params.modelId,
    api: params.modelApi,
    baseUrl: params.modelBaseUrl,
    config: params.config,
    env: params.env,
    requestTransportOverrides: params.requestTransportOverrides,
  });
  if (!resolution || resolution.kind === "indeterminate") {
    if (sourceDecision.kind === "rejected") {
      if (sourceDecision.reason === "all-cooldown" && sourceDecision.source) {
        throw new Error(
          `Auth profile "${sourceDecision.source.profileId}" is temporarily unavailable for ${params.provider}/${params.modelId}.`,
        );
      }
      throw new Error(sourceDecision.message);
    }
    const buildGenericPlan = (
      attempt: (typeof sourceDecision.attempts)[number] | undefined,
      candidateIndex: number,
    ) => {
      const profile = attempt?.kind === "profile" ? attempt.source : undefined;
      const candidateIds = sourceDecision.attempts
        .slice(candidateIndex)
        .flatMap((candidate) => (candidate.kind === "profile" ? [candidate.source.profileId] : []));
      return {
        ...buildAgentRuntimeAuthPlan({
          provider: params.provider,
          modelId: params.modelId,
          boundEnvVar: attempt?.kind === "direct" ? attempt.source.boundEnvVar : undefined,
          authProfileProvider: profile?.provider,
          authProfileMode:
            profile?.mode ??
            (attempt?.kind === "direct" ? attempt.source.mode : selectedConfiguredAuthMode),
          sessionAuthProfileId: profile?.profileId,
          sessionAuthProfileSource: profile
            ? profile.profileId === userPinnedProfileId
              ? "user"
              : "auto"
            : undefined,
          sessionAuthProfileCandidateIds:
            profile && candidateIds.length > 0 ? candidateIds : undefined,
          credentialSource: attempt
            ? classifyProviderModelAuthSource(attempt.source)
            : { kind: "none" },
          config: params.config,
          env: params.env,
          workspaceDir: params.workspaceDir,
          metadataSnapshot: params.metadataSnapshot,
          harnessId: params.harnessId,
          harnessRuntime: params.harnessRuntime,
          allowHarnessAuthProfileForwarding: harnessAllowsAuthProfileForwarding,
        }),
        ...(retainAutomaticAuthSource ? { retainAutomaticAuthSource: true } : {}),
      };
    };
    const attempts: PreparedAgentRuntimeAuthAttempt[] = sourceDecision.attempts.map(
      (attempt, index) => {
        const plan = buildGenericPlan(attempt, index);
        return attempt.kind === "profile"
          ? { kind: "profile", plan, profileId: attempt.source.profileId }
          : {
              kind: "direct",
              plan,
              allowAuthProfileFallback: attempt.allowAuthProfileFallback,
              requiresPriorProfileAttempt: sourceDecision.attempts
                .slice(0, index)
                .some((candidate) => candidate.kind === "profile"),
            };
      },
    );
    const plan = attempts[0]?.plan ?? buildGenericPlan(undefined, 0);
    if (
      selectedProfileId &&
      harnessOwnsOpenAIAuth &&
      plan.forwardedAuthProfileId !== selectedProfileId
    ) {
      throw new Error(
        `Auth profile "${selectedProfileId}" cannot be forwarded to the codex runtime.`,
      );
    }
    return {
      plan,
      attempts: attempts.length > 0 ? attempts : [{ kind: "implicit", plan }],
    };
  }
  if (resolution.kind === "incompatible") {
    throw new Error(resolution.message);
  }
  const toPreparedRoute = (route: (typeof resolution.routes)[number]) => ({
    provider: params.provider,
    modelId: params.modelId,
    api: route.api,
    baseUrl: route.baseUrl,
    authRequirement: route.authRequirement,
    requestTransportOverrides: route.requestTransportOverrides,
    runtimePolicy: route.runtimePolicy,
  });
  const routeAuthDecision = selectOpenAIModelRouteAuth({
    resolution,
    sourcePlan,
    configuredAuthMode: automaticRouteAuthMode,
    ...(runtimeAuthOwner ? { runtimeAuthOwner } : {}),
    ...(runtimeAuthOwner && configuredProvider === undefined
      ? { allowNativeAuthOnSingleRoute: true }
      : {}),
  });
  if (routeAuthDecision.kind === "deferred") {
    const plan = buildAgentRuntimeAuthPlan({
      provider: params.provider,
      modelId: params.modelId,
      boundEnvVar:
        providerUseBinding?.kind === "environment" ? providerUseBinding.envVar : undefined,
      config: params.config,
      env: params.env,
      workspaceDir: params.workspaceDir,
      metadataSnapshot: params.metadataSnapshot,
      harnessId: params.harnessId,
      harnessRuntime: params.harnessRuntime,
      allowHarnessAuthProfileForwarding: harnessAllowsAuthProfileForwarding,
      deferredRouteSupport: routeAuthDecision.routeSupport,
    });
    return { plan, attempts: [{ kind: "implicit", plan }] };
  }
  if (routeAuthDecision.kind !== "selected") {
    if (
      routeAuthDecision.kind === "rejected" &&
      routeAuthDecision.reason === "all-cooldown" &&
      routeAuthDecision.source
    ) {
      throw new Error(
        `Auth profile "${routeAuthDecision.source.profileId}" is temporarily unavailable for ${params.provider}/${params.modelId}.`,
      );
    }
    throw new Error(routeAuthDecision.message);
  }
  const buildRoutedPlan = (attempt: (typeof routeAuthDecision.attempts)[number] | undefined) => {
    const profile = attempt?.kind === "profile" ? attempt.source : undefined;
    const route = attempt?.route ?? routeAuthDecision.selection.route;
    return {
      ...buildAgentRuntimeAuthPlan({
        provider: params.provider,
        modelId: params.modelId,
        boundEnvVar: attempt?.kind === "direct" ? attempt.source.boundEnvVar : undefined,
        authProfileProvider: profile?.provider,
        authProfileMode:
          profile?.mode ??
          (attempt?.kind === "direct" ? attempt.source.mode : selectedConfiguredAuthMode),
        sessionAuthProfileId: profile?.profileId,
        sessionAuthProfileSource: profile
          ? profile.profileId === userPinnedProfileId
            ? "user"
            : "auto"
          : undefined,
        sessionAuthProfileCandidateIds:
          attempt?.kind === "profile" ? [...attempt.sameRouteProfileIds] : undefined,
        credentialSource: attempt
          ? classifyProviderModelAuthSource(attempt.source)
          : { kind: "none" },
        modelRoute: toPreparedRoute(route),
        config: params.config,
        env: params.env,
        workspaceDir: params.workspaceDir,
        metadataSnapshot: params.metadataSnapshot,
        harnessId: params.harnessId,
        harnessRuntime: params.harnessRuntime,
        allowHarnessAuthProfileForwarding: harnessAllowsAuthProfileForwarding,
      }),
      ...(retainAutomaticAuthSource ? { retainAutomaticAuthSource: true } : {}),
    };
  };
  const attempts: PreparedAgentRuntimeAuthAttempt[] = routeAuthDecision.attempts.map(
    (attempt, index) => {
      const plan = buildRoutedPlan(attempt);
      return attempt.kind === "profile"
        ? { kind: "profile", plan, profileId: attempt.source.profileId }
        : {
            kind: "direct",
            plan,
            allowAuthProfileFallback: attempt.allowAuthProfileFallback,
            requiresPriorProfileAttempt: routeAuthDecision.attempts
              .slice(0, index)
              .some((candidate) => candidate.kind === "profile"),
          };
    },
  );
  const plan = attempts[0]?.plan ?? buildRoutedPlan(undefined);
  for (const attempt of attempts) {
    if (
      attempt.profileId &&
      harnessOwnsOpenAIAuth &&
      attempt.plan.forwardedAuthProfileId !== attempt.profileId
    ) {
      throw new Error(
        `Auth profile "${attempt.profileId}" cannot be forwarded to the codex runtime.`,
      );
    }
  }
  return {
    plan,
    attempts: attempts.length > 0 ? attempts : [{ kind: "implicit", plan }],
  };
}
