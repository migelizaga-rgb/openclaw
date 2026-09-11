// Target-aware runtime recovery; startup discovery retains its inherited-environment guards.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { NodeRuntimeInstallCommand } from "../../../node-runtime-recovery.mjs";
import { parseNodeReleaseVersion } from "../../../node-version.mjs";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { readResponseWithLimit } from "../../infra/http-response-body.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { applyPathPrepend } from "../../infra/path-prepend.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import {
  withUpdateCommandExecutorChild,
  type UpdateCommandExecutor,
} from "./update-command-executor.js";
import {
  gatewayServiceCommandUsesRoot,
  resolvePackageRuntimePreflight,
  type PackageRuntimePreflight,
} from "./update-command-service-plan.js";

export type PackageRuntimeRecovery = {
  env: NodeJS.ProcessEnv;
  installCommand?: NodeRuntimeInstallCommand;
};

/** Only a live updater may provision; discovery never reads dotenv-selected paths. */
export function createPackageRuntimeRecovery(params: {
  root: string;
  opts: Pick<UpdateCommandOptions, "run" | "runtimeRecoveryEnv">;
  timeoutMs: number;
  executorFence?: UpdateRecoveryFence;
}): PackageRuntimeRecovery {
  const executor = params.opts.run?.executorFence ?? params.executorFence;
  return {
    env: params.opts.runtimeRecoveryEnv ?? {},
    ...(executor
      ? {
          installCommand: async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
            executor.assertCurrent();
            const result = await withUpdateCommandExecutorChild(
              executor,
              params.root,
              async (_grant, beforeInput) => {
                const result = await runCommandWithTimeout([command, ...args], {
                  baseEnv: {},
                  env,
                  cwd: params.root,
                  input: "",
                  beforeInput,
                  timeoutMs: params.timeoutMs,
                  killProcessTree: true,
                  requireProcessTreeExtinction: true,
                  maxOutputBytes: 64 * 1024,
                });
                // A fulfilled runner result can still be a failed/unsettled child.
                // Fail inside its owner interval, before handoff eligibility can be used.
                if (
                  result.code !== 0 ||
                  result.termination !== "exit" ||
                  result.signal !== null ||
                  result.killed ||
                  (result.cleanup !== "normal" && result.cleanup !== "cooperative") ||
                  result.outputLimitExceeded ||
                  result.outputErrorStream
                ) {
                  throw new Error(
                    "Private Node runtime provisioning did not complete successfully.",
                  );
                }
                return result;
              },
              { auxiliaryPreflight: true },
            );
            executor.assertCurrent();
            return result.termination === "exit" && !result.killed ? result.code : null;
          },
        }
      : {}),
  };
}

/** Select the newest patch in the lowest compatible even-numbered Node release line. */
export async function resolveTargetNodeRuntime(params: {
  engine: string;
  recovery: PackageRuntimeRecovery;
  timeoutMs?: number;
}): Promise<string | undefined> {
  // The bootstrap module owns package-relative installer assets. Bundling it into
  // dist changes import.meta.url and points those assets at nonexistent dist/scripts.
  const driverRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (!driverRoot) {
    return undefined;
  }
  const { findUsableNodeRuntime }: typeof import("../../../node-runtime-recovery.mjs") =
    await import(pathToFileURL(path.join(driverRoot, "node-runtime-recovery.mjs")).href);
  const acceptVersion = (version: string) =>
    nodeVersionSatisfiesEngine(version, params.engine) === true;
  const options = { ...params.recovery, acceptVersion };
  const available = await findUsableNodeRuntime(options);
  if (available) {
    return available.nodePath;
  }
  if (!params.recovery.installCommand) {
    return undefined;
  }
  // Fixed upstream metadata selects an exact checksum-verified installer target.
  // An unavailable release is not permission to install a merely newer runtime.
  let nodeVersion: string | undefined;
  try {
    const signal = AbortSignal.timeout(Math.min(params.timeoutMs ?? 30_000, 30_000));
    const response = await fetch("https://nodejs.org/dist/index.json", {
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      void response.body?.cancel();
      return undefined;
    }
    const releases: unknown = JSON.parse(
      (await readResponseWithLimit(response, 2 * 1024 * 1024, { signal })).toString("utf8"),
    );
    if (!Array.isArray(releases)) {
      return undefined;
    }
    nodeVersion = releases
      .flatMap((release: { version?: unknown }) => {
        const version =
          typeof release?.version === "string" ? parseNodeReleaseVersion(release.version) : null;
        if (!version || version.major < 24 || version.major % 2 !== 0) {
          return [];
        }
        const label = `${version.major}.${version.minor}.${version.patch}`;
        return acceptVersion(label) ? [{ ...version, label }] : [];
      })
      .toSorted((a, b) => a.major - b.major || b.minor - a.minor || b.patch - a.patch)[0]?.label;
  } catch {
    return undefined;
  }
  if (!nodeVersion) {
    return undefined;
  }
  return (await findUsableNodeRuntime({ ...options, allowInstall: true, nodeVersion }))?.nodePath;
}

function reportPackageRuntimeSelection(
  selection: PackageRuntimePreflight,
  opts: { json?: boolean; tag: string },
): void {
  if (!selection.replacedNodeRunner || opts.json) {
    return;
  }
  defaultRuntime.log(
    theme.warn(
      `Managed gateway service Node (${selection.replacedNodeRunner}) cannot run openclaw@${selection.targetVersion ?? opts.tag}.`,
    ),
  );
  defaultRuntime.log(
    theme.muted(
      `Using compatible Node (${selection.nodeRunner}) for the update and managed service refresh.`,
    ),
  );
}

/** The same target-runtime owner serves admitted updates and target-owned initialization. */
export async function preparePackageUpdateRuntime(params: {
  root: string;
  managedServiceRoot?: string;
  managedServiceNodeRunner?: string;
  packageUpdateNodeRunner?: string;
  packageInstallEnv?: NodeJS.ProcessEnv;
  packageRuntimeTarget?: { version: string; nodeEngine: string | null };
  shouldRestart: boolean;
  opts: UpdateCommandOptions;
  executor: UpdateCommandExecutor;
  timeoutMs: number;
  tag: string;
}) {
  const canRefreshManagedServiceNode =
    params.shouldRestart &&
    params.managedServiceNodeRunner !== undefined &&
    (await gatewayServiceCommandUsesRoot({ root: params.managedServiceRoot ?? params.root })) ===
      true;
  const fence = await params.executor.enter(params.root, {
    preflight: true,
    serviceRoot: params.managedServiceRoot,
  });
  if (params.opts.run) {
    params.opts.run.executorFence = fence;
  }
  const result = await resolvePackageRuntimePreflight({
    target: params.packageRuntimeTarget,
    timeoutMs: params.timeoutMs,
    nodeRunner: params.packageUpdateNodeRunner,
    fallbackNodeRunner: canRefreshManagedServiceNode ? resolveNodeRunner() : undefined,
    runtimeRecovery:
      !params.managedServiceNodeRunner || canRefreshManagedServiceNode
        ? createPackageRuntimeRecovery({
            root: params.root,
            opts: params.opts,
            timeoutMs: params.timeoutMs,
            executorFence: fence,
          })
        : undefined,
  });
  fence.assertCurrent();
  if (result.ok) {
    if (params.packageInstallEnv && result.value.nodeRunner) {
      // SAFETY: createGlobalInstallEnv filters undefined entries into a string-valued copy.
      applyPathPrepend(params.packageInstallEnv as Record<string, string>, [
        path.dirname(result.value.nodeRunner),
      ]);
    }
    reportPackageRuntimeSelection(result.value, { json: params.opts.json, tag: params.tag });
  }
  return result;
}
