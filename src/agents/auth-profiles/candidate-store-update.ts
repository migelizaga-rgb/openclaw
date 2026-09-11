import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { CandidateAuthProfileStore } from "./candidate-stores.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { resolveAuthProfileStoreOwner } from "./sqlite.js";
import { saveAuthProfileStoreWithPreparedOwner } from "./store-runtime.js";
import type { AuthProfileStore } from "./types.js";

/**
 * Update one exact candidate database in a single synchronous SQLite
 * transaction. Callers serialize candidates externally; this never holds two
 * database transactions at once. Keep runtime writers outside read-only discovery.
 */
export function updateCandidateAuthProfileStore(params: {
  candidate: CandidateAuthProfileStore;
  preserveProfileState?: boolean;
  profileId: string;
  updater: (store: AuthProfileStore) => boolean;
}): { changed: boolean; store: AuthProfileStore } {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const store = loadPersistedAuthProfileStore(params.candidate.agentDir, { database }) ?? {
        version: AUTH_STORE_VERSION,
        profiles: {},
      };
      const changed = params.updater(store);
      if (changed) {
        const profileIds = [params.profileId];
        saveAuthProfileStoreWithPreparedOwner(
          store,
          params.candidate.agentDir,
          {
            filterExternalAuthProfiles: false,
            syncExternalCli: false,
            ...(params.preserveProfileState
              ? {
                  preserveOrderProfileIds: profileIds,
                  preserveStateProfileIds: profileIds,
                }
              : {}),
          },
          database,
          resolveAuthProfileStoreOwner(database, params.candidate.env),
        );
      }
      return { changed, store };
    },
    {
      agentId: params.candidate.agentId,
      env: params.candidate.env,
      path: params.candidate.databasePath,
    },
  );
}
