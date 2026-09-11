// Preserve the fixture's module setup before its runtime consumers.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { invalidatePreparedModelRuntimeOwnersForAuthMutation } from "./prepared-model-runtime-auth-publication.js";
import {
  getPreparedModelRuntimePreferredAuthSource,
  recordPreparedModelRuntimeAuthSource,
} from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import {
  ownerKey,
  resolvePreparedModelRuntimeOwnerBySnapshot,
} from "./prepared-model-runtime.owner.js";
import type { ProviderModelAuthSource } from "./provider-model-auth-source-plan.js";

const environment: ProviderModelAuthSource = {
  kind: "direct",
  mode: "api-key",
  readiness: "ready",
  evidence: "environment",
  authorization: "declared",
  boundEnvVar: "OPENAI_API_KEY",
};
const profile: ProviderModelAuthSource = {
  kind: "profile",
  provider: "openai",
  profileId: "openai:new",
  mode: "api_key",
  readiness: "ready",
  cooldown: "clear",
};
const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

async function publish(config: OpenClawConfig = {}) {
  mocks.configuredAgentIds = ["pro", "other"];
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const snapshot = getPreparedModelRuntimeSnapshot({
    config,
    agentId: "pro",
    agentDir: state.agentDir("pro"),
  });
  assert(snapshot);
  return snapshot;
}

function publishAccountChange(
  snapshot: Awaited<ReturnType<typeof publish>>,
  agentDir = snapshot.agentDir,
) {
  const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
  assert(owner);
  invalidatePreparedModelRuntimeOwnersForAuthMutation(new Map([[ownerKey(owner.input), owner]]), {
    agentDir,
    affectsInheritedStores: false,
    profileSetChanged: true,
  });
}

describe("successful auth source retention through runtime publication", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "runtime-auth-source-retention" });
    await resetPreparedModelRuntimeHarness(state);
  });
  afterEach(async ({ task }) => {
    await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
  });

  it("retains the serving environment source through an auth-only refresh", async () => {
    const first = await publish();
    recordPreparedModelRuntimeAuthSource(first, "openai", "model", environment);
    expect(getPreparedModelRuntimePreferredAuthSource(first, "openai", "model")).toBeUndefined();
    publishAccountChange(first);
    const next = await publish({
      agents: { defaults: { heartbeat: { agentId: "pro" }, systemAgent: { agentId: "pro" } } },
      auth: { profiles: { "openai:new": { provider: "openai", mode: "api_key" } } },
    });
    expect(getPreparedModelRuntimePreferredAuthSource(next, "openai", "model")).toEqual(
      environment,
    );
    expect(
      getPreparedModelRuntimePreferredAuthSource(next, "openai", "another-model"),
    ).toBeUndefined();
  });

  it("does not retain a source because another agent saved an account", async () => {
    const snapshot = await publish();
    recordPreparedModelRuntimeAuthSource(snapshot, "openai", "model", environment);
    publishAccountChange(snapshot, state.agentDir("other"));
    expect(getPreparedModelRuntimePreferredAuthSource(snapshot, "openai", "model")).toBeUndefined();
  });

  it("updates the current source only after success and delivers a deferred notice once", async () => {
    const snapshot = await publish();
    recordPreparedModelRuntimeAuthSource(snapshot, "openai", "model", environment);
    publishAccountChange(snapshot);
    const next = await publish();
    expect(recordPreparedModelRuntimeAuthSource(next, "openai", "model", profile, false)).toBe(
      false,
    );
    expect(getPreparedModelRuntimePreferredAuthSource(next, "openai", "model")).toEqual(profile);
    expect(recordPreparedModelRuntimeAuthSource(snapshot, "openai", "model", environment)).toBe(
      false,
    );
    expect(getPreparedModelRuntimePreferredAuthSource(next, "openai", "model")).toEqual(profile);
    expect(recordPreparedModelRuntimeAuthSource(next, "openai", "model", profile)).toBe(true);
    expect(recordPreparedModelRuntimeAuthSource(next, "openai", "model", profile)).toBe(false);
  });

  it.each<OpenClawConfig>([
    { agents: { entries: { other: { model: "openai/another-model" } } } },
    { agents: { defaults: { models: { "openai/browsable": {} } } } },
    {
      models: {
        providers: {
          other: { apiKey: "explicit-key", baseUrl: "https://example.com/v1", models: [] },
        },
      },
    },
  ])("preserves the serving source through unrelated configuration edits: %j", async (config) => {
    const snapshot = await publish();
    recordPreparedModelRuntimeAuthSource(snapshot, "openai", "model", environment);
    publishAccountChange(snapshot);
    const next = await publish(config);
    expect(getPreparedModelRuntimePreferredAuthSource(next, "openai", "model")).toEqual(
      environment,
    );
  });
});
