import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import * as authProfiles from "../../auth-profiles.js";
import * as runtimeAuth from "../../prepared-model-runtime-auth.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

vi.mock("../../auth-profiles.js", () => ({
  markAuthProfileSuccess: vi.fn(async () => undefined),
}));

const notice =
  "Using openai account openai:new because the previous credential is no longer available.";

function successfulInput(text = "The task is complete.") {
  const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: [text],
    currentAttemptAssistant: assistant,
    lastAssistant: assistant,
  });
  return makeTerminalInput({
    attempt,
    attemptAssistant: assistant,
    payloadsWithToolMedia: [{ text }],
    finalAssistantRawText: text,
    preparedModelRuntime: { config: {}, isCurrent: () => true },
    preparedAuthPlan: {
      credentialSource: { kind: "profile" },
      selectedAuthMode: "api-key",
      retainAutomaticAuthSource: true,
    },
    authProfileId: "openai:new",
    attemptAuthProfileStore: {
      version: 1,
      profiles: { "openai:new": { type: "api_key", provider: "openai", key: "fake-new-key" } },
    },
    apiKeyInfo: { apiKey: "fake-new-key", source: "profile:openai:new", mode: "api-key" },
  });
}

describe("successful terminal account notice", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("records the first successful fallback before bookkeeping retires its generation", async () => {
    const input = successfulInput();
    let current = true;
    const snapshot = { config: {}, isCurrent: () => current };
    const owner = {};
    input.preparedModelRuntime = snapshot;
    runtimeAuth.prepareModelRuntimeAuthSources(owner, undefined, {
      config: snapshot.config,
      agentDir: "/tmp/terminal-auth-owner",
    });
    runtimeAuth.bindModelRuntimeAuthSources(owner, snapshot);
    runtimeAuth.recordPreparedModelRuntimeAuthSource(snapshot, "openai", input.modelId, {
      kind: "direct",
      mode: "api-key",
      readiness: "ready",
      evidence: "environment",
      authorization: "declared",
      boundEnvVar: "OPENAI_API_KEY",
    });
    runtimeAuth.retainModelRuntimeAuthSourcesAfterMutation(owner);
    const bookkeeping = vi
      .spyOn(authProfiles, "markAuthProfileSuccess")
      .mockImplementation(async () => {
        current = false;
      });

    const result = await resolveEmbeddedRunTerminal(input);

    expect(bookkeeping).toHaveBeenCalledOnce();
    expect(snapshot.isCurrent()).toBe(false);
    expect(result).toMatchObject({
      action: "complete",
      result: { payloads: [{ text: "The task is complete." }, { text: notice }] },
    });
    expect(
      runtimeAuth.getPreparedModelRuntimePreferredAuthSource(snapshot, "openai", input.modelId),
    ).toMatchObject({
      kind: "profile",
      profileId: "openai:new",
    });
    expect(
      runtimeAuth.recordPreparedModelRuntimeAuthSource(snapshot, "openai", input.modelId, {
        kind: "profile",
        profileId: "openai:stale",
        readiness: "ready",
        cooldown: "clear",
      }),
    ).toBe(false);
    expect(
      runtimeAuth.getPreparedModelRuntimePreferredAuthSource(snapshot, "openai", input.modelId),
    ).toMatchObject({
      kind: "profile",
      profileId: "openai:new",
    });
  });

  it("delivers the owner's one-time transition after the successful reply and retains media", async () => {
    const record = vi
      .spyOn(runtimeAuth, "recordPreparedModelRuntimeAuthSource")
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const input = successfulInput();
    input.payloadsWithToolMedia = [{ text: "The task is complete.", mediaUrl: "/tmp/result.png" }];
    const first = await resolveEmbeddedRunTerminal(input);
    expect(first).toMatchObject({
      action: "complete",
      result: { payloads: [...input.payloadsWithToolMedia, { text: notice }] },
    });
    expect(input.payloadsWithToolMedia).toEqual([
      { text: "The task is complete.", mediaUrl: "/tmp/result.png" },
    ]);
    if (first.action !== "complete") {
      throw new Error("Expected completed terminal reply");
    }
    const deliveredNotice = first.result.payloads?.at(-1);
    expect(deliveredNotice && getReplyPayloadMetadata(deliveredNotice)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
    expect(record).toHaveBeenCalledWith(
      input.preparedModelRuntime,
      "openai",
      input.modelId,
      {
        kind: "profile",
        profileId: "openai:new",
        provider: "openai",
        mode: "api-key",
        readiness: "ready",
        cooldown: "clear",
      },
      true,
    );
    const second = await resolveEmbeddedRunTerminal(successfulInput());
    expect(second).toMatchObject({
      action: "complete",
      result: { payloads: [{ text: "The task is complete." }] },
    });
  });

  it("records direct environment provenance from the active plan, not the display label", async () => {
    const record = vi
      .spyOn(runtimeAuth, "recordPreparedModelRuntimeAuthSource")
      .mockReturnValue(false);
    const input = successfulInput();
    input.authProfileId = undefined;
    input.apiKeyInfo = { apiKey: "fake-env-key", source: "operator credential", mode: "api-key" };
    input.preparedAuthPlan = {
      credentialSource: { kind: "direct", evidence: "environment", authorization: "declared" },
      boundEnvVar: "OPENAI_API_KEY",
      selectedAuthMode: "api-key",
      retainAutomaticAuthSource: true,
    };
    const result = await resolveEmbeddedRunTerminal(input);
    expect(record).toHaveBeenCalledWith(
      input.preparedModelRuntime,
      "openai",
      input.modelId,
      {
        kind: "direct",
        evidence: "environment",
        authorization: "declared",
        boundEnvVar: "OPENAI_API_KEY",
        mode: "api-key",
        readiness: "ready",
      },
      true,
    );
    expect(result).toMatchObject({
      action: "complete",
      result: { payloads: input.payloadsWithToolMedia },
    });
  });

  it("keeps explicit silence and defers its notice at the source owner", async () => {
    const record = vi
      .spyOn(runtimeAuth, "recordPreparedModelRuntimeAuthSource")
      .mockReturnValue(false);
    const input = successfulInput(SILENT_REPLY_TOKEN);
    input.payloadsWithToolMedia = [];
    input.runParams.allowEmptyAssistantReplyAsSilent = true;
    const result = await resolveEmbeddedRunTerminal(input);
    expect(record).toHaveBeenCalledWith(
      input.preparedModelRuntime,
      "openai",
      input.modelId,
      expect.objectContaining({ profileId: "openai:new" }),
      false,
    );
    expect(result).toMatchObject({
      action: "complete",
      result: { payloads: [{ text: SILENT_REPLY_TOKEN }] },
    });
  });

  it.each(["read-only", "explicit choice", "failed"] as const)(
    "does not change the serving account for a %s run",
    async (kind) => {
      const record = vi
        .spyOn(runtimeAuth, "recordPreparedModelRuntimeAuthSource")
        .mockReturnValue(false);
      const input = successfulInput();
      if (kind === "read-only") {
        input.runParams.authProfileStateMode = "read-only";
      } else if (kind === "explicit choice") {
        input.preparedAuthPlan = {
          credentialSource: { kind: "profile" },
          retainAutomaticAuthSource: false,
        };
      } else {
        const error = new Error("Provider request failed");
        input.attempt = makeEmbeddedRunnerAttempt({
          terminal: { kind: "failed", source: "prompt", error },
        });
        input.terminalState = resolveEmbeddedRunAttemptTerminalState({
          attempt: input.attempt,
          assistant: undefined,
        });
      }
      await resolveEmbeddedRunTerminal(input);
      expect(record).not.toHaveBeenCalled();
    },
  );
});
