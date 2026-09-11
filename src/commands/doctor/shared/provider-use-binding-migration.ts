import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds } from "../../../agents/agent-scope-config.js";
import { resolveAgentDir } from "../../../agents/agent-scope.js";
import {
  listCandidateAuthProfileStores,
  loadCandidateAuthProfileStore,
} from "../../../agents/auth-profiles/candidate-stores.js";
import { captureAuthProfileOwnerScope } from "../../../agents/auth-profiles/path-resolve.js";
import { loadPersistedAuthProfileStoreAtDatabasePath } from "../../../agents/auth-profiles/persisted.js";
import { withAuthProfilePublicationLock } from "../../../agents/auth-profiles/publication.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import { resolveProviderAuthAliasMap } from "../../../agents/provider-auth-aliases.js";
import {
  isGenericProviderCredentialEnvVar,
  resolveProviderUseAdmission,
} from "../../../agents/provider-model-auth-source-plan.js";
import type { ConfigWriteOptions } from "../../../config/io.types.js";
import { isConfigIncludeOwnershipError } from "../../../config/io.write-errors.js";
import { GuardedConfigIncludeWriteError } from "../../../config/mutation-conflict.js";
import {
  resolveConfigProviderUseBindings,
  setConfigProviderUseBindings,
} from "../../../config/resolution-facts.js";
import { resolveResetPreservedSelection } from "../../../config/sessions/reset-preserved-selection.js";
import { scanDoctorSessionEntriesTolerant } from "../../../config/sessions/session-accessor.sqlite-canonical-inventory.js";
import type { ModelProviderConfigInput } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { parseEnvTemplateSecretRef, type SecretRef } from "../../../config/types.secrets.js";
import { validateConfigObjectRaw } from "../../../config/validation-core.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "../../../infra/state-migrations.receipts.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";
import {
  resolveProviderBindingEnvVarCandidates,
  type ProviderBindingEnvVarCandidates,
} from "../../../secrets/provider-env-vars.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { listExistingAgentDatabaseTargets } from "../../doctor-session-sqlite-readers.js";
import {
  collectConfiguredProviderUseSelections,
  type ConfiguredProviderUseSelection,
} from "./configured-provider-selection-ids.js";
import { selectedCanonicalModelRefsForRuntimePolicy } from "./legacy-runtime-model-policy.js";

const MIGRATION = "selected-shared-provider-bindings:v1";
const SELECTION_VERSION = 2;
const CHAIN_PROVIDERS = new Set(["amazon-bedrock", "amazon-bedrock-mantle", "google-vertex"]);
export type ProviderUseBindingMigrationBindings = Record<string, { apiKey?: SecretRef }>;
const DEFERRED =
  'Could not read provider upgrade state; shared-key bindings were left unchanged. Rerun "openclaw doctor --fix".';

/** Runtime projection shares Doctor's transform but neither writes config nor completes receipts. */
export function applyProviderUseBindingsToRuntime(
  params: Parameters<typeof prepareProviderUseBindingMigration>[0] & {
    runtimeConfig: OpenClawConfig;
  },
): { config: OpenClawConfig; warnings: string[] } {
  const migration = prepareProviderUseBindingMigration(params);
  setConfigProviderUseBindings(params.runtimeConfig, migration.bindings ?? {});
  const warnings = [...(migration.warnings ?? [])];
  const entries = Object.entries(migration.bindings ?? {}).map(([id, binding]) =>
    binding.apiKey
      ? `models.providers.${id}.apiKey = ${JSON.stringify(binding.apiKey)}`
      : `models.providers.${id} = {}`,
  );
  if (entries.length > 0) {
    warnings.push(
      `Selected provider bindings are active in memory only. Run "openclaw doctor --fix" or update the managed config ${params.configPath}: ${entries.join("; ")}.`,
    );
  }
  return { config: resolveConfigProviderUseBindings(params.runtimeConfig), warnings };
}

/** Preserve selected shared-key routes once; ordinary runtime selection never creates bindings. */
export function prepareProviderUseBindingMigration(params: {
  config: OpenClawConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): {
  config: OpenClawConfig;
  changes: string[];
  pending: boolean;
  warnings?: string[];
  unsetPaths?: string[][];
  bindings?: ProviderUseBindingMigrationBindings;
} {
  const { config, configPath, env } = params;
  const unchanged = { config, changes: [], pending: false };
  // Doctor retains invalid source values until its config validation step.
  const envProvider: unknown = config.secrets?.defaults?.env;
  if (envProvider !== undefined && typeof envProvider !== "string") {
    return unchanged;
  }
  const sourceKey = resolveLegacyMigrationSourceKey(MIGRATION, configPath);
  const sessionSelections: Array<{ agentId: string; model: string }> = [];
  let configuredSelections: ConfiguredProviderUseSelection[];
  let narrowReceipt = false;
  let direct: ProviderBindingEnvVarCandidates;
  let envCandidateMap: Readonly<Record<string, readonly string[]>>;
  let aliasMap: Readonly<Record<string, string>>;
  const authScopes = new Map<string, { agentDir: string; store: AuthProfileStore }>();
  const accountScopes: Array<{ owner: string; store: AuthProfileStore }> = [];
  // Receipts and session pins are external state. A failed read must not turn an
  // incomplete selection snapshot into a completed upgrade or prevent startup.
  try {
    const completed = withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readLegacyMigrationReceiptFromDatabase(db, sourceKey),
      { env },
    );
    if (completed) {
      let report: unknown;
      try {
        report = JSON.parse(completed.reportJson);
      } catch {
        report = undefined;
      }
      if (
        isRecord(report) &&
        typeof report.selectionVersion === "number" &&
        report.selectionVersion >= SELECTION_VERSION
      ) {
        return unchanged;
      }
      narrowReceipt = true;
    }
    configuredSelections = collectConfiguredProviderUseSelections({ config, env });
    const candidates = listCandidateAuthProfileStores({ cfg: config, env });
    const sharedStore = loadPersistedAuthProfileStoreAtDatabasePath(
      resolveOpenClawStateSqlitePath(env),
      "shared-state",
    );
    if (sharedStore) {
      accountScopes.push({ owner: "shared", store: sharedStore });
    }
    for (const candidate of candidates) {
      const store = loadCandidateAuthProfileStore(candidate);
      if (store) {
        accountScopes.push({ owner: candidate.agentId, store });
      }
    }
    let incompletePins = false;
    for (const target of listExistingAgentDatabaseTargets(config, env)) {
      scanDoctorSessionEntriesTolerant(
        { agentId: target.agentId, storePath: target.storePath, env },
        ({ entry, recoveredFromProjections }) => {
          if (recoveredFromProjections) {
            incompletePins = true;
            return;
          }
          const pin = resolveResetPreservedSelection({ entry });
          if (typeof pin.modelOverride === "string") {
            sessionSelections.push({
              agentId: target.agentId,
              model:
                pin.providerOverride && !pin.modelOverride.startsWith(`${pin.providerOverride}/`)
                  ? `${pin.providerOverride}/${pin.modelOverride}`
                  : pin.modelOverride,
            });
          }
        },
      );
    }
    if (incompletePins) {
      return { ...unchanged, warnings: [DEFERRED] };
    }
    for (const agentId of new Set([
      ...listAgentIds(config),
      ...configuredSelections.map((selection) => selection.agentId),
      ...sessionSelections.map((selection) => selection.agentId),
    ])) {
      const agentDir = resolveAgentDir(config, agentId, env);
      authScopes.set(agentId, {
        agentDir,
        store: {
          version: 1,
          profiles: Object.assign(
            {},
            ...accountScopes
              .filter((scope) => scope.owner === "shared" || scope.owner === agentId)
              .map((scope) => scope.store.profiles),
          ),
        },
      });
    }
    direct = resolveProviderBindingEnvVarCandidates({
      config,
      env,
      manifestPlugins: params.manifestRegistry?.plugins,
    });
    aliasMap = resolveProviderAuthAliasMap({
      config,
      env,
      includeUntrustedWorkspacePlugins: false,
      ...(params.manifestRegistry
        ? { metadataSnapshot: { plugins: params.manifestRegistry.plugins } }
        : {}),
    });
    const envCandidates: Record<string, readonly string[]> = Object.fromEntries(
      Object.entries(direct).map(([provider, declarations]) => [
        provider,
        declarations.flatMap((declaration) => declaration.envVars),
      ]),
    );
    for (const [alias, provider] of Object.entries(aliasMap)) {
      envCandidates[alias] ??= envCandidates[provider] ?? [];
    }
    envCandidateMap = envCandidates;
  } catch {
    return { ...unchanged, warnings: [DEFERRED] };
  }
  if (config.models !== undefined && !isRecord(config.models)) {
    return unchanged;
  }
  if (config.models?.providers !== undefined && !isRecord(config.models.providers)) {
    return unchanged;
  }
  const selectedProviders = new Map<string, Set<string>>();
  for (const agentId of authScopes.keys()) {
    selectedProviders.set(
      agentId,
      new Set(
        configuredSelections
          .filter(
            (selection) =>
              selection.agentId === agentId &&
              (!narrowReceipt ||
                !selection.previouslyCovered ||
                CHAIN_PROVIDERS.has(selection.provider)),
          )
          .map((selection) => selection.provider),
      ),
    );
  }
  const manifestVariables = new Set(
    Object.values(direct).flatMap((declarations) =>
      declarations.flatMap((declaration) => declaration.envVars),
    ),
  );
  const admissions = new Map(
    [...authScopes].map(([agentId, { store }]) => [
      agentId,
      resolveProviderUseAdmission({
        config,
        includeRuntimeBindings: false,
        env,
        providerEnvVars: direct,
        profiles: store.profiles,
      }),
    ]),
  );
  const providers: Record<string, ModelProviderConfigInput> = {};
  const bindings: ProviderUseBindingMigrationBindings = {};
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const [identity, candidates] of Object.entries({
    ...Object.fromEntries([...CHAIN_PROVIDERS].map((provider) => [provider, []])),
    ...envCandidateMap,
  })) {
    const provider = normalizeProviderId(identity);
    const chain = CHAIN_PROVIDERS.has(provider);
    const selectedAgents = [...selectedProviders]
      .filter(
        ([agentId, selected]) =>
          selected.has(provider) ||
          ((!narrowReceipt || chain) &&
            sessionSelections.some(
              (selection) =>
                selection.agentId === agentId &&
                selectedCanonicalModelRefsForRuntimePolicy(selection.model, provider).length > 0,
            )),
      )
      .map(([agentId]) => agentId);
    if (
      (!chain && !Object.hasOwn(direct, identity) && !Object.hasOwn(aliasMap, identity)) ||
      selectedAgents.length === 0
    ) {
      continue;
    }
    const sharedVariables = candidates.filter(
      (name) =>
        manifestVariables.has(name) &&
        !isGenericProviderCredentialEnvVar(name) &&
        Object.entries(envCandidateMap).some(
          ([sibling, names]) => normalizeProviderId(sibling) !== provider && names.includes(name),
        ),
    );
    if (!chain && sharedVariables.length === 0) {
      continue;
    }
    const missingAgents = selectedAgents.filter(
      (agentId) => !admissions.get(agentId)?.has(provider),
    );
    if (missingAgents.length === 0) {
      continue;
    }
    const credentialProvider = aliasMap[provider] ?? provider;
    const accountOwners = new Set<string>();
    const conflictingProfiles = new Set<string>();
    for (const { owner, store } of accountScopes) {
      for (const [profileId, profile] of Object.entries(store.profiles)) {
        const storedProvider = normalizeProviderId(profile.provider);
        if (
          storedProvider === provider ||
          [provider, storedProvider].every(
            (id) => id === "amazon-bedrock" || id === "amazon-bedrock-mantle",
          ) ||
          (aliasMap[storedProvider] ?? storedProvider) === credentialProvider ||
          (envCandidateMap[storedProvider] ?? []).some(
            (name) => manifestVariables.has(name) && candidates.includes(name),
          )
        ) {
          accountOwners.add(owner);
          conflictingProfiles.add(profileId);
        }
      }
    }
    if (conflictingProfiles.size > 0) {
      warnings.push(
        `Provider ${provider} was not migrated for agents ${missingAgents.join(", ")}: a global binding could replace an existing account for agents ${[...accountOwners].join(", ")} (profiles ${[...conflictingProfiles].join(", ")}). Bind the provider explicitly to the saved account, then rerun "openclaw doctor --fix".`,
      );
      continue;
    }
    const variable = sharedVariables.find((name) => env[name]?.trim());
    if (!chain && !variable) {
      warnings.push(
        `Could not evaluate the shared-key upgrade for provider ${provider}: ${sharedVariables.join(", ")} is not set. Rerun "openclaw doctor --fix" from the service environment or with a candidate variable set.`,
      );
      continue;
    }
    const apiKey =
      !chain && variable ? parseEnvTemplateSecretRef(`\${${variable}}`, envProvider) : null;
    if (!chain && !apiKey) {
      continue;
    }
    const binding = apiKey ? { apiKey } : {};
    providers[provider] = binding;
    bindings[provider] = binding;
    changes.push(
      chain
        ? `Declared selected provider ${provider} for its configured credential chain.`
        : `Bound selected provider ${provider} to ${variable} with an env SecretRef.`,
    );
  }
  if (changes.length === 0) {
    return {
      ...unchanged,
      pending: warnings.length === 0,
      ...(warnings.length ? { warnings } : {}),
    };
  }
  const validated = validateConfigObjectRaw({ models: { providers } }, { env });
  if (!validated.ok) {
    return {
      ...unchanged,
      warnings: ["Could not validate shared-key provider bindings; config was left unchanged."],
    };
  }
  return {
    config: {
      ...config,
      models: {
        ...config.models,
        providers: { ...config.models?.providers, ...validated.config.models?.providers },
      },
    },
    changes,
    bindings,
    pending: warnings.length === 0,
    ...(warnings.length ? { warnings } : {}),
    // Doctor consumes materialized config; its writer preserves the sparse source overlay.
    unsetPaths: Object.keys(providers).flatMap((provider) =>
      ["baseUrl", "models"].map((field) => ["models", "providers", provider, field]),
    ),
  };
}

/** Carry only approved migration work into Doctor's delayed config writer. */
export function resolveProviderUseBindingWriteMetadata(
  migration: Awaited<ReturnType<typeof prepareProviderUseBindingMigration>>,
  options: { shouldWriteConfig: boolean; shouldRepair: boolean; blocksWrite?: boolean },
) {
  return {
    ...(options.shouldWriteConfig && migration.bindings
      ? { providerUseBindings: migration.bindings }
      : {}),
    ...(options.shouldWriteConfig && migration.unsetPaths
      ? { unsetPaths: migration.unsetPaths }
      : {}),
    ...(migration.pending &&
    options.blocksWrite !== true &&
    (options.shouldWriteConfig || (options.shouldRepair && migration.changes.length === 0))
      ? { providerUseBindingMigrationPending: true }
      : {}),
  };
}

/** Recheck proposed bindings after interactive or asynchronous repairs, before persistence. */
export function revalidateProviderUseBindingMigration(params: {
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
  bindings: Readonly<ProviderUseBindingMigrationBindings>;
}) {
  const config = structuredClone(params.config);
  for (const [provider, binding] of Object.entries(params.bindings)) {
    const persisted = params.sourceConfig?.models?.providers?.[provider];
    if (
      persisted &&
      config.models?.providers &&
      isDeepStrictEqual(config.models.providers[provider]?.apiKey, binding.apiKey)
    ) {
      config.models.providers[provider] = structuredClone(persisted);
    }
  }
  const analysis = structuredClone(config);
  const proposed = Object.entries(params.bindings).filter(
    ([provider, binding]) =>
      !params.sourceConfig?.models?.providers?.[provider] &&
      Object.hasOwn(config.models?.providers ?? {}, provider) &&
      isDeepStrictEqual(config.models?.providers?.[provider]?.apiKey, binding.apiKey),
  );
  for (const [provider] of proposed) {
    delete analysis.models?.providers?.[provider];
  }
  const checked = prepareProviderUseBindingMigration({ ...params, config: analysis });
  const bindings: ProviderUseBindingMigrationBindings = {};
  for (const [provider, binding] of proposed) {
    if (isDeepStrictEqual(checked.bindings?.[provider], binding)) {
      bindings[provider] = binding;
      continue;
    }
    removeGeneratedProviderCredential(config, provider, params.sourceConfig);
  }
  const deferred = Object.keys(checked.bindings ?? {}).filter(
    (provider) => !Object.hasOwn(bindings, provider),
  );
  return {
    config,
    bindings,
    pending:
      checked.pending && Object.keys(bindings).length === proposed.length && deferred.length === 0,
    warnings: [
      ...(checked.warnings ?? []),
      ...(deferred.length
        ? [
            `Selected providers ${deferred.join(", ")} still need binding; rerun "openclaw doctor --fix".`,
          ]
        : []),
    ],
    changes: Object.entries(bindings).map(([provider, binding]) =>
      binding.apiKey
        ? `Bound selected provider ${provider} to ${binding.apiKey.id} with an env SecretRef.`
        : `Declared selected provider ${provider} for its configured credential chain.`,
    ),
  };
}

function removeGeneratedProviderCredential(
  config: OpenClawConfig,
  provider: string,
  sourceConfig?: OpenClawConfig,
): void {
  const entry = config.models?.providers?.[provider];
  if (entry) {
    delete entry.apiKey;
    const authoredFields = Object.entries(entry).filter(
      ([key, value]) =>
        !(key === "baseUrl" && value === "") &&
        !(key === "models" && Array.isArray(value) && value.length === 0),
    );
    if (authoredFields.length === 0) {
      delete config.models?.providers?.[provider];
    }
  }
  if (
    config.models?.providers &&
    Object.keys(config.models.providers).length === 0 &&
    !sourceConfig?.models?.providers
  ) {
    delete config.models.providers;
    if (Object.keys(config.models).length === 0 && !sourceConfig?.models) {
      delete config.models;
    }
  }
}

type CheckedProviderBindings = ReturnType<typeof revalidateProviderUseBindingMigration>;
class ProviderUseBindingPublicationChanged extends Error {
  constructor(readonly checked: CheckedProviderBindings) {
    super("Provider credentials changed before binding publication.");
  }
}

/** Account writes and the config rename share one synchronous publication fence. */
export async function writeProviderUseBindingMigration(
  params: Parameters<typeof revalidateProviderUseBindingMigration>[0],
  write: (
    checked: CheckedProviderBindings,
    withCommit?: ConfigWriteOptions["withCommit"],
  ) => Promise<void>,
): Promise<CheckedProviderBindings> {
  const owner = captureAuthProfileOwnerScope(params.env);
  const scopedParams = () => ({
    ...params,
    env: {
      ...params.env,
      OPENCLAW_STATE_DIR: owner.stateDir,
      OPENCLAW_AGENT_DIR: owner.sharedMainDir,
    },
  });
  let checked = revalidateProviderUseBindingMigration(scopedParams());
  try {
    await write(
      checked,
      Object.keys(checked.bindings).length === 0
        ? undefined
        : (publish) => {
            let entered = false;
            try {
              const currentParams = scopedParams();
              withAuthProfilePublicationLock(currentParams.env, () => {
                entered = true;
                const current = revalidateProviderUseBindingMigration({
                  ...currentParams,
                  config: checked.config,
                  bindings: checked.bindings,
                });
                if (
                  !isDeepStrictEqual(current.config, checked.config) ||
                  !isDeepStrictEqual(current.bindings, checked.bindings) ||
                  (checked.pending && !current.pending)
                ) {
                  throw new ProviderUseBindingPublicationChanged(current);
                }
                publish();
              });
            } catch (error) {
              if (entered) {
                throw error;
              }
              // An unavailable external lock cannot certify a migration or prevent startup.
              throw new ProviderUseBindingPublicationChanged(checked);
            }
          },
    );
  } catch (error) {
    if (error instanceof ProviderUseBindingPublicationChanged) {
      checked = error.checked;
    } else if (
      error instanceof GuardedConfigIncludeWriteError ||
      isConfigIncludeOwnershipError(error)
    ) {
      const selections = Object.entries(checked.bindings)
        .map(([provider, binding]) => `${provider} (${binding.apiKey?.id ?? "credential chain"})`)
        .join(", ");
      const includePaths =
        error instanceof GuardedConfigIncludeWriteError
          ? error.includePath
          : (error.includeTargets?.join(", ") ?? error.ownedConfigPath);
      checked.warnings.push(
        `Provider bindings ${selections} were not written to included config ${includePaths}. Bind them explicitly in that file.`,
      );
    } else {
      throw error;
    }
    // Publish independent repairs, but do not retry newly stale credential authority.
    for (const provider of Object.keys(checked.bindings)) {
      removeGeneratedProviderCredential(checked.config, provider, params.sourceConfig);
    }
    checked.bindings = {};
    checked.pending = false;
    checked.changes = [];
    checked.warnings.push(
      'Could not verify stored accounts before saving provider bindings; shared-key bindings were deferred. Rerun "openclaw doctor --fix".',
    );
    await write(checked);
  }
  return checked;
}

/** A successful Doctor write closes the upgrade window, including an empty selection. */
export function completeProviderUseBindingMigration(
  configPath: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const sourceKey = resolveLegacyMigrationSourceKey(MIGRATION, configPath);
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const completed = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
        if (completed) {
          let report: unknown;
          try {
            report = JSON.parse(completed.reportJson);
          } catch {
            report = undefined;
          }
          if (
            isRecord(report) &&
            typeof report.selectionVersion === "number" &&
            report.selectionVersion >= SELECTION_VERSION
          ) {
            return;
          }
        }
        recordLegacyMigrationReceipt(db, {
          sourceKey,
          migrationKind: MIGRATION,
          sourcePath: configPath,
          targetTable: "migration_sources",
          sourceSha256: null,
          sourceSizeBytes: null,
          sourceRecordCount: null,
          runId: sourceKey,
          now: Date.now(),
          reportJson: JSON.stringify({
            completed: true,
            target: "models.providers",
            selectionVersion: SELECTION_VERSION,
          }),
          upsert: completed !== null,
        });
      },
      { env },
    );
    return [];
  } catch {
    return ['Could not record the shared-key provider upgrade; rerun "openclaw doctor --fix".'];
  }
}
