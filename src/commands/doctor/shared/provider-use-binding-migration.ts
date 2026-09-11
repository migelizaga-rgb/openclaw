import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds } from "../../../agents/agent-scope-config.js";
import { resolveAgentDir } from "../../../agents/agent-scope.js";
import { loadAuthProfileStoreForRuntime } from "../../../agents/auth-profiles.js";
import {
  listCandidateAuthProfileStores,
  loadCandidateAuthProfileStore,
} from "../../../agents/auth-profiles/candidate-stores.js";
import { captureAuthProfileOwnerScope } from "../../../agents/auth-profiles/path-resolve.js";
import { loadPersistedAuthProfileStoreAtDatabasePath } from "../../../agents/auth-profiles/persisted.js";
import { withAuthProfilePublicationLock } from "../../../agents/auth-profiles/publication.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import { resolveSelectedModelProviderIds } from "../../../agents/model-selection-config.js";
import {
  isGenericProviderCredentialEnvVar,
  resolveProviderUseAdmission,
} from "../../../agents/provider-model-auth-source-plan.js";
import { GuardedConfigIncludeWriteError } from "../../../config/mutation-conflict.js";
import type { ConfigWriteOptions } from "../../../config/io.types.js";
import { resolveResetPreservedSelection } from "../../../config/sessions/reset-preserved-selection.js";
import { scanDoctorSessionEntriesTolerant } from "../../../config/sessions/session-accessor.js";
import type { ModelProviderConfigInput } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { parseEnvTemplateSecretRef, type SecretRef } from "../../../config/types.secrets.js";
import { validateConfigObjectRaw } from "../../../config/validation-core.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "../../../infra/state-migrations.receipts.js";
import {
  resolveProviderAuthLookupMaps,
  resolveProviderBindingEnvVarCandidates,
} from "../../../secrets/provider-env-vars.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { listExistingAgentDatabaseTargets } from "../../doctor-session-sqlite-readers.js";
import { selectedCanonicalModelRefsForRuntimePolicy } from "./legacy-runtime-model-policy.js";

const MIGRATION = "selected-shared-provider-bindings:v1";
const DEFERRED =
  'Could not read provider upgrade state; shared-key bindings were left unchanged. Rerun "openclaw doctor --fix".';

/** Preserve selected shared-key routes once; ordinary runtime selection never creates bindings. */
export function prepareProviderUseBindingMigration(params: {
  config: OpenClawConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
}): {
  config: OpenClawConfig;
  changes: string[];
  pending: boolean;
  warnings?: string[];
  unsetPaths?: string[][];
  bindings?: Record<string, SecretRef>;
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
  let direct: Record<string, readonly string[]>;
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
      return unchanged;
    }
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
      ...sessionSelections.map((selection) => selection.agentId),
    ])) {
      const agentDir = resolveAgentDir(config, agentId, env);
      authScopes.set(agentId, {
        agentDir,
        store: loadAuthProfileStoreForRuntime(
          agentDir,
          {
            config,
            readOnly: true,
            allowKeychainPrompt: false,
          },
          env,
        ),
      });
    }
    direct = resolveProviderBindingEnvVarCandidates({ config, env });
    ({ envCandidateMap, aliasMap } = resolveProviderAuthLookupMaps({
      config,
      env,
      includeUntrustedWorkspacePlugins: false,
    }));
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
    selectedProviders.set(agentId, resolveSelectedModelProviderIds({ cfg: config, agentId }));
  }
  const manifestVariables = new Set(Object.values(direct).flat());
  const admissions = new Map(
    [...authScopes].map(([agentId, { store }]) => [
      agentId,
      resolveProviderUseAdmission({
        config,
        env,
        providerEnvVars: direct,
        profiles: store.profiles,
      }),
    ]),
  );
  const providers: Record<string, ModelProviderConfigInput> = {};
  const bindings: Record<string, SecretRef> = {};
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const [identity, candidates] of Object.entries(envCandidateMap)) {
    const provider = normalizeProviderId(identity);
    const selectedAgents = [...selectedProviders]
      .filter(
        ([agentId, selected]) =>
          selected.has(provider) ||
          sessionSelections.some(
            (selection) =>
              selection.agentId === agentId &&
              selectedCanonicalModelRefsForRuntimePolicy(selection.model, provider).length > 0,
          ),
      )
      .map(([agentId]) => agentId);
    if (
      (!Object.hasOwn(direct, identity) && !Object.hasOwn(aliasMap, identity)) ||
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
    if (sharedVariables.length === 0) {
      continue;
    }
    const variable = sharedVariables.find((name) => env[name]?.trim());
    if (!variable) {
      warnings.push(
        `Could not evaluate the shared-key upgrade for provider ${provider}: ${sharedVariables.join(", ")} is not set. Rerun "openclaw doctor --fix" from the service environment or with a candidate variable set.`,
      );
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
        `Provider ${provider} was not migrated for agents ${missingAgents.join(", ")}: a global env binding could replace an existing account for agents ${[...accountOwners].join(", ")} (profiles ${[...conflictingProfiles].join(", ")}). Bind the provider explicitly to the saved account, then rerun "openclaw doctor --fix".`,
      );
      continue;
    }
    const apiKey = variable ? parseEnvTemplateSecretRef(`\${${variable}}`, envProvider) : null;
    if (!apiKey) {
      continue;
    }
    providers[provider] = { apiKey };
    bindings[provider] = apiKey;
    changes.push(`Bound selected provider ${provider} to ${variable} with an env SecretRef.`);
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
  bindings: Readonly<Record<string, SecretRef>>;
}) {
  const config = structuredClone(params.config);
  for (const [provider, apiKey] of Object.entries(params.bindings)) {
    const persisted = params.sourceConfig?.models?.providers?.[provider];
    if (
      persisted &&
      config.models?.providers &&
      isDeepStrictEqual(config.models.providers[provider]?.apiKey, apiKey)
    ) {
      config.models.providers[provider] = structuredClone(persisted);
    }
  }
  const analysis = structuredClone(config);
  const proposed = Object.entries(params.bindings).filter(
    ([provider, apiKey]) =>
      !params.sourceConfig?.models?.providers?.[provider] &&
      isDeepStrictEqual(config.models?.providers?.[provider]?.apiKey, apiKey),
  );
  for (const [provider] of proposed) {
    delete analysis.models?.providers?.[provider];
  }
  const checked = prepareProviderUseBindingMigration({ ...params, config: analysis });
  const bindings: Record<string, SecretRef> = {};
  for (const [provider, apiKey] of proposed) {
    if (isDeepStrictEqual(checked.bindings?.[provider], apiKey)) {
      bindings[provider] = apiKey;
      continue;
    }
    removeGeneratedProviderCredential(config, provider);
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
    changes: Object.entries(bindings).map(
      ([provider, apiKey]) =>
        `Bound selected provider ${provider} to ${apiKey.id} with an env SecretRef.`,
    ),
  };
}

function removeGeneratedProviderCredential(config: OpenClawConfig, provider: string): void {
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
  if (config.models?.providers && Object.keys(config.models.providers).length === 0) {
    delete config.models.providers;
    if (Object.keys(config.models).length === 0) {
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
    await write(checked, Object.keys(checked.bindings).length === 0 ? undefined : (publish) => {
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
    });
  } catch (error) {
    if (error instanceof ProviderUseBindingPublicationChanged) {
      checked = error.checked;
    } else if (error instanceof GuardedConfigIncludeWriteError) {
      checked.warnings.push("Provider bindings in included config require an explicit edit to the included file.");
    } else {
      throw error;
    }
    // Publish independent repairs, but do not retry newly stale credential authority.
    for (const provider of Object.keys(checked.bindings)) {
      removeGeneratedProviderCredential(checked.config, provider);
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
        if (readLegacyMigrationReceiptFromDatabase(db, sourceKey)) {
          return;
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
          reportJson: JSON.stringify({ completed: true, target: "models.providers" }),
        });
      },
      { env },
    );
    return [];
  } catch {
    return ['Could not record the shared-key provider upgrade; rerun "openclaw doctor --fix".'];
  }
}
