import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { getConfigProviderUseBindings } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import { isOAuthRefreshFence } from "./auth-profiles/oauth-refresh-marker.js";
import { hasOAuthIdentity } from "./auth-profiles/oauth-shared.js";
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import type { ProviderModelAuthSource } from "./provider-model-auth-source-plan.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

type AuthSourceState = {
  current: Map<string, ProviderModelAuthSource>;
  preferred: Map<string, ProviderModelAuthSource>;
  pendingNotice: Map<string, string>;
  retainOnSuccess: boolean;
  readOnly: boolean;
};
const authSourcesByOwner = new WeakMap<object, AuthSourceState>();
const authSourcesBySnapshot = new WeakMap<object, AuthSourceState>();

function authSourceKey(provider: string, modelId: string): string {
  return JSON.stringify([normalizeProviderId(provider), modelId]);
}

/** Account publication retains successful automatic choices, not credential material. */
export function prepareModelRuntimeAuthSources(
  owner: object,
  previous: { agentDir: string; config: OpenClawConfig; readOnly?: boolean } | undefined,
  next: { agentDir: string; config: OpenClawConfig; readOnly?: boolean },
): void {
  if (
    previous?.agentDir === next.agentDir &&
    previous.readOnly === next.readOnly &&
    authSourcesByOwner.has(owner)
  ) {
    return;
  }
  authSourcesByOwner.set(owner, {
    current: new Map(),
    preferred: new Map(),
    pendingNotice: new Map(),
    retainOnSuccess: false,
    readOnly: next.readOnly === true,
  });
}

export function retainModelRuntimeAuthSourcesAfterMutation(owner: object): void {
  const state = authSourcesByOwner.get(owner);
  if (state) {
    state.preferred = new Map(state.current);
    state.retainOnSuccess = true;
  }
}

export function bindModelRuntimeAuthSources(owner: object, snapshot: object): void {
  const state = authSourcesByOwner.get(owner);
  if (state) {
    authSourcesBySnapshot.set(snapshot, state);
  }
}

export function getPreparedModelRuntimePreferredAuthSource(
  snapshot: object | undefined,
  provider: string,
  modelId: string,
): ProviderModelAuthSource | undefined {
  return snapshot
    ? authSourcesBySnapshot.get(snapshot)?.preferred.get(authSourceKey(provider, modelId))
    : undefined;
}

/** Only successful automatic runs can change the current source or publish its notice. */
export function recordPreparedModelRuntimeAuthSource(
  snapshot: { config: OpenClawConfig; isCurrent: () => boolean },
  provider: string,
  modelId: string,
  source: ProviderModelAuthSource,
  notify = true,
): boolean {
  const state = authSourcesBySnapshot.get(snapshot);
  if (!state || state.readOnly || !snapshot.isCurrent()) {
    return false;
  }
  const key = authSourceKey(provider, modelId);
  const previous = state.preferred.get(key);
  const generatedBinding = getConfigProviderUseBindings(snapshot.config)[
    normalizeProviderId(provider)
  ];
  if (
    source.kind === "profile" &&
    ((previous && (previous.kind !== "profile" || previous.profileId !== source.profileId)) ||
      (!previous && generatedBinding))
  ) {
    state.pendingNotice.set(key, source.profileId);
  }
  state.current.set(key, source);
  if (previous || generatedBinding || state.retainOnSuccess) {
    state.preferred.set(key, source);
  }
  if (source.kind !== "profile" || state.pendingNotice.get(key) !== source.profileId) {
    state.pendingNotice.delete(key);
    return false;
  }
  if (!notify) {
    return false;
  }
  state.pendingNotice.delete(key);
  return true;
}

export type PreparedModelRuntimeAuth = Readonly<{
  authStore: AuthProfileStore;
  authModes: PreparedAgentCredentialModes;
}>;

export type PreparedModelCatalogAuth = PreparedModelRuntimeAuth &
  Readonly<{
    providerAuthLabels: ModelCatalogAuthLabels;
    /** Unobserved discovery credentials cannot authorize account-inventory retention. */
    credentials?: Readonly<AuthStorageData>;
  }>;

export type PreparedModelRuntimeAuthScope = Readonly<{
  providerIds: readonly string[];
  profileIds?: readonly string[];
}>;

/** Inventory follows identified accounts; credential use still follows the current auth owner. */
export function hasSamePreparedModelCatalogAuth(
  previous: Pick<PreparedModelCatalogAuth, "authStore" | "credentials"> | undefined,
  next: Pick<PreparedModelCatalogAuth, "authStore" | "credentials">,
  includesProvider: (provider: string) => boolean = () => true,
): boolean {
  if (!previous?.credentials || !next.credentials) {
    return false;
  }
  const identity = (authStore: AuthProfileStore, credentials: Readonly<AuthStorageData>) => {
    const profiles = Object.entries(authStore.profiles).filter(([, profile]) =>
      includesProvider(profile.provider),
    );
    const identifiedOAuth = profiles.filter(
      ([, profile]) =>
        profile.type === "oauth" && hasOAuthIdentity(profile) && !isOAuthRefreshFence(profile),
    );
    return {
      profiles: Object.fromEntries(
        profiles.map(([id, profile]) => {
          if (profile.type !== "oauth" || !identifiedOAuth.some(([key]) => key === id)) {
            return [id, profile];
          }
          const {
            access: _access,
            refresh: _refresh,
            expires: _expires,
            idToken: _idToken,
            ...account
          } = profile;
          return [id, account];
        }),
      ),
      credentials: Object.fromEntries(
        Object.entries(credentials)
          .filter(([provider]) => includesProvider(provider))
          .map(([provider, credential]) => {
            if (credential.type !== "oauth") {
              return [provider, credential];
            }
            const profileIds = identifiedOAuth
              .flatMap(([id, profile]) =>
                profile.type === "oauth" &&
                normalizeProviderId(profile.provider) === normalizeProviderId(provider) &&
                profile.access === credential.access &&
                profile.refresh === credential.refresh &&
                profile.expires === credential.expires
                  ? [id]
                  : [],
              )
              .toSorted();
            return [provider, profileIds.length ? { profileIds } : credential];
          }),
      ),
    };
  };
  return isDeepStrictEqual(
    identity(previous.authStore, previous.credentials),
    identity(next.authStore, next.credentials),
  );
}

/** Private auth facts owned by an immutable prepared model generation. */
const authStoreBySnapshot = new WeakMap<object, AuthProfileStore>();
const authLabelsBySnapshot = new WeakMap<object, ModelCatalogAuthLabels>();
const materializationsBySnapshot = new WeakMap<object, readonly RuntimeAuthMaterialization[]>();
const authLoaderBySnapshot = new WeakMap<
  object,
  (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>
>();
const authByFullCatalog = new WeakMap<object, PreparedModelCatalogAuth>();

// Secret-bearing state stays lifecycle-owned without becoming part of the public snapshot shape.
export function setPreparedModelRuntimeAuthStore(
  snapshot: object,
  authStore: AuthProfileStore,
): void {
  authStoreBySnapshot.set(snapshot, authStore);
}

export function getPreparedModelRuntimeAuthStore(snapshot: object): AuthProfileStore | undefined {
  return authStoreBySnapshot.get(snapshot);
}

export function setPreparedModelRuntimeAuthLabels(
  snapshot: object,
  labels: ModelCatalogAuthLabels,
): void {
  authLabelsBySnapshot.set(snapshot, labels);
}

export function getPreparedModelRuntimeAuthLabels(snapshot: object): ModelCatalogAuthLabels {
  const labels = authLabelsBySnapshot.get(snapshot);
  if (!labels) {
    throw new Error("Prepared model runtime omitted auth display labels");
  }
  return labels;
}

export function setPreparedModelFullCatalogAuth(
  snapshot: object,
  auth: PreparedModelCatalogAuth,
): void {
  authByFullCatalog.set(snapshot, auth);
}

export function getPreparedModelFullCatalogAuth(snapshot: object) {
  return authByFullCatalog.get(snapshot);
}

export function setPreparedModelRuntimeAuthLoader(
  snapshot: object,
  loader: (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>,
): void {
  authLoaderBySnapshot.set(snapshot, loader);
}

export async function loadPreparedModelRuntimeAuth(
  snapshot: object & { authModes?: PreparedAgentCredentialModes },
  scope: PreparedModelRuntimeAuthScope,
): Promise<PreparedModelRuntimeAuth | undefined> {
  const loader = authLoaderBySnapshot.get(snapshot);
  if (loader) {
    return await loader(scope);
  }
  const authStore = authStoreBySnapshot.get(snapshot);
  return authStore ? { authStore, authModes: snapshot.authModes ?? {} } : undefined;
}

export function setPreparedModelRuntimeAuthMaterializations(
  snapshot: object,
  materializations: readonly RuntimeAuthMaterialization[],
): void {
  materializationsBySnapshot.set(snapshot, materializations);
}

export function getPreparedModelRuntimeAuthMaterializations(
  snapshot: object,
): readonly RuntimeAuthMaterialization[] {
  return materializationsBySnapshot.get(snapshot) ?? [];
}

export function copyPreparedModelRuntimeAuthBindings(source: object, target: object): void {
  const sources = authSourcesBySnapshot.get(source);
  if (sources) {
    authSourcesBySnapshot.set(target, sources);
  }
  const authStore = authStoreBySnapshot.get(source);
  const labels = authLabelsBySnapshot.get(source);
  const authLoader = authLoaderBySnapshot.get(source);
  const materializations = materializationsBySnapshot.get(source);
  if (authStore) {
    authStoreBySnapshot.set(target, authStore);
  }
  if (labels) {
    authLabelsBySnapshot.set(target, labels);
  }
  if (authLoader) {
    authLoaderBySnapshot.set(target, authLoader);
  }
  if (materializations) {
    materializationsBySnapshot.set(target, materializations);
  }
}
