import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { EnvSubstitutionWarning } from "./env-substitution.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { coerceSecretRef, DEFAULT_SECRET_PROVIDER_ALIAS, type SecretRef } from "./types.secrets.js";

/** `null` means this value has not passed through authoritative config env substitution. */
export type ConfigResolutionFacts = ReadonlySet<string> | null;

const configResolutionFacts = new WeakMap<object, ReadonlySet<string>>();
export type ConfigProviderUseBindings = Readonly<Record<string, { apiKey?: SecretRef }>>;
const providerUseBindingsByConfig = new WeakMap<object, ConfigProviderUseBindings>();
type ConfigEnvSecretRefFact = Readonly<{
  ref: SecretRef;
  state: "pending" | "resolved";
}>;

const envSecretRefsByFacts = new WeakMap<
  ReadonlySet<string>,
  ReadonlyMap<string, ConfigEnvSecretRefFact>
>();

export function createConfigResolutionFacts(
  warnings: readonly EnvSubstitutionWarning[],
  pendingEnvSecretRefs: ReadonlyMap<string, string> = new Map(),
  envProvider: string | undefined = DEFAULT_SECRET_PROVIDER_ALIAS,
  resolvedEnvSecretRefs: ReadonlyMap<string, string> = new Map(),
): ReadonlySet<string> {
  const facts = new Set(warnings.map(({ configPath }) => configPath));
  const provider = envProvider?.trim() || DEFAULT_SECRET_PROVIDER_ALIAS;
  if (pendingEnvSecretRefs.size > 0 || resolvedEnvSecretRefs.size > 0) {
    const envSecretRefs = new Map<string, ConfigEnvSecretRefFact>();
    for (const [path, id] of pendingEnvSecretRefs) {
      envSecretRefs.set(path, {
        ref: { source: "env", provider, id },
        state: "pending",
      });
    }
    for (const [path, id] of resolvedEnvSecretRefs) {
      envSecretRefs.set(path, {
        ref: { source: "env", provider, id },
        state: "resolved",
      });
    }
    envSecretRefsByFacts.set(facts, envSecretRefs);
  }
  return facts;
}

export function setConfigResolutionFacts(target: unknown, facts: ConfigResolutionFacts): void {
  if (!target || typeof target !== "object") {
    return;
  }
  if (facts === null) {
    configResolutionFacts.delete(target);
    return;
  }
  configResolutionFacts.set(target, facts);
}

export function getConfigResolutionFacts(target: unknown): ConfigResolutionFacts {
  return target && typeof target === "object" ? (configResolutionFacts.get(target) ?? null) : null;
}

export function copyConfigResolutionFacts(source: unknown, target: unknown): void {
  setConfigResolutionFacts(target, getConfigResolutionFacts(source));
  setConfigProviderUseBindings(target, getConfigProviderUseBindings(source));
}

/** Approved startup bindings are runtime facts, never authored fields for config writers. */
export function setConfigProviderUseBindings(
  target: unknown,
  bindings: ConfigProviderUseBindings,
): void {
  if (!target || typeof target !== "object") {
    return;
  }
  if (Object.keys(bindings).length > 0) {
    providerUseBindingsByConfig.set(target, bindings);
  } else {
    providerUseBindingsByConfig.delete(target);
  }
}

export function getConfigProviderUseBindings(target: unknown): ConfigProviderUseBindings {
  return target && typeof target === "object"
    ? (providerUseBindingsByConfig.get(target) ?? {})
    : {};
}

/** Reloads preserve admitted upgrade bindings until an authored provider entry replaces them. */
export function retainConfigProviderUseBindings(
  previous: OpenClawConfig,
  next: OpenClawConfig,
): void {
  const authoredProviders = new Set(
    Object.keys(next.models?.providers ?? {}).map(normalizeProviderId),
  );
  setConfigProviderUseBindings(next, {
    ...Object.fromEntries(
      Object.entries(getConfigProviderUseBindings(previous)).filter(
        ([provider]) => !authoredProviders.has(provider),
      ),
    ),
    ...getConfigProviderUseBindings(next),
  });
}

/** Only the shared migration can add runtime declarations to an authored auth view. */
export function resolveConfigProviderUseBindings(config: OpenClawConfig): OpenClawConfig {
  const bindings = getConfigProviderUseBindings(config);
  if (Object.keys(bindings).length === 0) {
    return config;
  }
  const resolved = {
    ...config,
    models: {
      ...config.models,
      providers: {
        // Runtime provider overlays use sentinels; the recorded source bindings stay sparse.
        ...Object.fromEntries(
          Object.entries(bindings).map(([provider, binding]) => [
            provider,
            { baseUrl: "", models: [], ...binding },
          ]),
        ),
        ...config.models?.providers,
      },
    },
  };
  copyConfigResolutionFacts(config, resolved);
  return resolved;
}

export function cloneConfigWithResolutionFacts<T>(value: T): T {
  const cloned = structuredClone(value);
  copyConfigResolutionFacts(value, cloned);
  return cloned;
}

export function copyConfigResolutionFactsExcept(
  source: unknown,
  target: unknown,
  paths: readonly string[],
): void {
  const bindings = getConfigProviderUseBindings(source);
  const removesBinding = (provider: string) =>
    paths.some(
      (path) =>
        path === "models" ||
        path === "models.providers" ||
        path === `models.providers.${provider}` ||
        path.startsWith(`models.providers.${provider}.`),
    );
  setConfigProviderUseBindings(
    target,
    Object.fromEntries(Object.entries(bindings).filter(([provider]) => !removesBinding(provider))),
  );
  const facts = getConfigResolutionFacts(source);
  if (facts === null) {
    setConfigResolutionFacts(target, null);
    return;
  }
  const envSecretRefs = envSecretRefsByFacts.get(facts);
  if (
    paths.length === 0 ||
    !paths.some((path) => facts.has(path) || envSecretRefs?.has(path) === true)
  ) {
    setConfigResolutionFacts(target, facts);
    return;
  }
  const remaining = new Set(facts);
  paths.forEach((path) => remaining.delete(path));
  if (envSecretRefs) {
    const remainingEnvSecretRefs = new Map(envSecretRefs);
    paths.forEach((path) => remainingEnvSecretRefs.delete(path));
    if (remainingEnvSecretRefs.size > 0) {
      envSecretRefsByFacts.set(remaining, remainingEnvSecretRefs);
    }
  }
  setConfigResolutionFacts(target, remaining);
}

type SerializedConfigResolutionFacts = Readonly<{
  unresolvedPaths: readonly string[];
  envSecretRefs: readonly (readonly [string, ConfigEnvSecretRefFact])[];
  providerUseBindings?: ConfigProviderUseBindings;
  envSubstitutionKnown?: boolean;
}> | null;

/** Captures loader provenance as deterministic data for a prepared worker generation. */
export function serializeConfigResolutionFacts(target: unknown): SerializedConfigResolutionFacts {
  const facts = getConfigResolutionFacts(target);
  const bindings = getConfigProviderUseBindings(target);
  return facts === null && Object.keys(bindings).length === 0
    ? null
    : {
        unresolvedPaths: [...(facts ?? [])].toSorted(),
        envSecretRefs: [...(facts ? (envSecretRefsByFacts.get(facts) ?? []) : [])].toSorted(
          ([left], [right]) => left.localeCompare(right),
        ),
        ...(Object.keys(bindings).length > 0 ? { providerUseBindings: bindings } : {}),
        ...(facts === null ? { envSubstitutionKnown: false } : {}),
      };
}

/** Restores known-empty facts too: absence would reparse decoded literals as references. */
export function restoreConfigResolutionFacts(
  target: unknown,
  data: SerializedConfigResolutionFacts,
): void {
  if (data === null) {
    setConfigResolutionFacts(target, null);
    setConfigProviderUseBindings(target, {});
    return;
  }
  const facts = new Set(data.unresolvedPaths);
  if (data.envSecretRefs.length > 0) {
    envSecretRefsByFacts.set(facts, new Map(data.envSecretRefs));
  }
  setConfigProviderUseBindings(target, data.providerUseBindings ?? {});
  setConfigResolutionFacts(target, data.envSubstitutionKnown === false ? null : facts);
}

export function hasUnresolvedConfigPath(target: unknown, path: string): boolean {
  return getConfigResolutionFacts(target)?.has(path) === true;
}

/** Returns only a still-pending reference recorded from the authored config source. */
export function getAuthoredConfigSecretRef(target: unknown, path: string): SecretRef | null {
  const facts = getConfigResolutionFacts(target);
  const fact = facts ? envSecretRefsByFacts.get(facts)?.get(path) : undefined;
  return fact?.state === "pending" ? fact.ref : null;
}

/** Returns the env source of a value that config substitution already materialized. */
export function getResolvedConfigEnvSecretRef(target: unknown, path: string): SecretRef | null {
  const facts = getConfigResolutionFacts(target);
  const fact = facts ? envSecretRefsByFacts.get(facts)?.get(path) : undefined;
  return fact?.state === "resolved" ? fact.ref : null;
}

/** Reads inline references from authored facts and structured references from their values. */
export function resolveConfigSecretRef(params: {
  config: unknown;
  path: string;
  value: unknown;
  defaults?: Parameters<typeof coerceSecretRef>[1];
}): SecretRef | null {
  return typeof params.value === "string" && getConfigResolutionFacts(params.config) !== null
    ? getAuthoredConfigSecretRef(params.config, params.path)
    : coerceSecretRef(params.value, params.defaults);
}

export function hasUnresolvedConfigPathInSubtree(target: unknown, path: string): boolean {
  const facts = getConfigResolutionFacts(target);
  if (facts === null) {
    return false;
  }
  for (const candidate of facts) {
    if (
      candidate === path ||
      candidate.startsWith(`${path}.`) ||
      candidate.startsWith(`${path}[`)
    ) {
      return true;
    }
  }
  return false;
}
