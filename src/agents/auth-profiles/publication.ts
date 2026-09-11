/** Publication locks shared by credential transactions and config binding commits. */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { acquireFileLockSyncWithRetry } from "../../infra/file-lock-sync.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { captureAuthProfileOwnerScope } from "./path-resolve.js";

const publicationLog = createSubsystemLogger("auth/profile-publication");
const pendingPublicationLockReleases = resolveGlobalSingleton(
  Symbol.for("openclaw.authProfilePublicationLockReleases"),
  () => new Map<string, Set<() => void>>(),
);

/** Serialize config bindings and credential publication across a stable state owner. */
export function withAuthProfilePublicationLock<T>(env: NodeJS.ProcessEnv, publish: () => T): T {
  const release = acquireAuthProfilePublicationLock(env);
  try {
    return publish();
  } finally {
    release();
  }
}

function acquireAuthProfilePublicationLock(env: NodeJS.ProcessEnv): () => void {
  // Keep the lock in the owner root so release leaves no staged migration artifacts.
  const directory = captureAuthProfileOwnerScope(env).stateDir;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(fs.realpathSync(directory), "auth-profile-publication");
  const pending = pendingPublicationLockReleases.get(lockPath);
  for (const release of pending ?? []) {
    // A previous durable write succeeded. Cleanup must succeed before a new writer enters.
    release();
    pending?.delete(release);
  }
  pendingPublicationLockReleases.delete(lockPath);
  const release = acquireFileLockSyncWithRetry(lockPath, "auth-profile-publication");
  return () => {
    try {
      release();
    } catch (error) {
      const retained = pendingPublicationLockReleases.get(lockPath) ?? new Set<() => void>();
      retained.add(release);
      pendingPublicationLockReleases.set(lockPath, retained);
      publicationLog.warn(
        `Auth publication lock cleanup failed; retained for retry: ${String(error)}`,
      );
    }
  };
}

export function withAuthProfileStorePublication(
  database: DatabaseSync,
  env: NodeJS.ProcessEnv,
  write: () => void,
): void {
  const release = acquireAuthProfilePublicationLock(env);
  // Keep the fence through outer COMMIT/ROLLBACK, including a supplied agent transaction.
  const deferred = stageSqliteTransactionState(database, {
    stage: () => {},
    commit: release,
    rollback: release,
  });
  try {
    if (database.isTransaction && !deferred) {
      throw new Error("Auth publication requires the managed transaction lifecycle.");
    }
    write();
  } finally {
    if (!deferred) {
      release();
    }
  }
}
