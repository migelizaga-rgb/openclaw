import { expect, it } from "vitest";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
} from "../../agents/model-auth-availability.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveProviderAuthOverview } from "./list.auth-overview.js";

it("reports the working admitted environment source while retaining the unusable saved account", () => {
  withEnv(
    { FIXTURE_API_KEY: "working-environment-key", OTHER_API_KEY: "unselected-environment-key" },
    () => {
      const overview = resolveProviderAuthOverview({
        provider: "fixture-api",
        cfg: {},
        store: {
          version: 1,
          profiles: {
            "fixture-api:expired": {
              type: "token",
              provider: "fixture-api",
              token: "expired-account",
              expires: 1,
            },
          },
        },
        modelsPath: "/unused/models.json",
        aliasMap: {},
        envCandidateMap: { "fixture-api": ["OTHER_API_KEY", "FIXTURE_API_KEY"] },
        authEvidenceMap: {},
        evaluation: {
          availability: true,
          evidence: "environment",
          environmentVariable: "FIXTURE_API_KEY",
          routeResolution: null,
        },
      });
      expect(overview.effective.kind).toBe("env");
      expect(overview.env?.source).toBe("env: FIXTURE_API_KEY");
      expect(overview.profiles.count).toBe(1);
      expect(overview.profiles.labels[0]).toContain("fixture-api:expired");
    },
  );
});

it.each([
  {
    name: "saved profile",
    evaluation: {
      availability: true,
      evidence: "profile",
      selectedProfileId: "fixture-api:saved",
      routeResolution: null,
    },
    expected: "profiles",
  },
  {
    name: "unavailable route",
    evaluation: { availability: false, routeResolution: null },
    expected: "missing",
  },
] satisfies Array<{ name: string; evaluation: ModelAuthAvailabilityEvaluation; expected: string }>)(
  "keeps the routing owner's $name decision when environment credentials are also present",
  ({ evaluation, expected }) => {
    withEnv({ FIXTURE_API_KEY: "working-environment-key" }, () => {
      const overview = resolveProviderAuthOverview({
        provider: "fixture-api",
        cfg: {},
        store: {
          version: 1,
          profiles: {
            "fixture-api:saved": { type: "token", provider: "fixture-api", token: "saved-account" },
          },
        },
        modelsPath: "/unused/models.json",
        aliasMap: {},
        envCandidateMap: { "fixture-api": ["FIXTURE_API_KEY"] },
        authEvidenceMap: {},
        evaluation,
      });
      expect(overview.effective.kind).toBe(expected);
      expect(overview.env?.source).toBe("env: FIXTURE_API_KEY");
      expect(overview.profiles.count).toBe(1);
    });
  },
);

it.each([
  "OPENAI_API_KEY",
  "${OPENAI_API_KEY}",
  { source: "env", provider: "default", id: "OPENAI_API_KEY" },
] as const)(
  "reports the exact authored env source for %j without borrowing a candidate key",
  (apiKey) => {
    withEnv(
      { OPENAI_API_KEY: "chosen-config-account", OTHER_API_KEY: "unselected-candidate-account" },
      () => {
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              "fixture-api": {
                apiKey,
                api: "openai-completions",
                baseUrl: "https://fixture.invalid/v1",
                models: [],
              },
            },
          },
        };
        const store = { version: 1, profiles: {} };
        const evaluation = createModelAuthAvailabilityResolver({
          cfg,
          authStore: store,
          env: process.env,
        }).evaluateProviderAuth("fixture-api");
        expect(evaluation).toMatchObject({
          availability: true,
          environmentVariable: "OPENAI_API_KEY",
          routeResolution: null,
        });
        const overview = resolveProviderAuthOverview({
          provider: "fixture-api",
          cfg,
          store,
          modelsPath: "/unused/models.json",
          aliasMap: {},
          envCandidateMap: { "fixture-api": ["OTHER_API_KEY"] },
          authEvidenceMap: {},
          evaluation,
        });
        expect(overview.effective.kind).toBe("env");
        expect(overview.env?.source).toBe("env: OPENAI_API_KEY");
        expect(JSON.stringify(overview)).not.toContain("chosen-config-account");
        expect(JSON.stringify(overview)).not.toContain("unselected-candidate-account");
      },
    );
  },
);

it("shows a ready local provider without requiring a plugin credential record", () => {
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        "fixture-local": {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:8080/v1",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 4096,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
  };
  const store = { version: 1, profiles: {} };
  const evaluation = createModelAuthAvailabilityResolver({
    cfg,
    authStore: store,
    env: {},
  }).evaluateProviderAuth("fixture-local");
  expect(evaluation).toMatchObject({
    availability: true,
    evidence: "synthetic",
    routeResolution: null,
  });
  const overview = resolveProviderAuthOverview({
    provider: "fixture-local",
    cfg,
    store,
    modelsPath: "/unused/models.json",
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
    evaluation,
  });
  expect(overview.effective).toEqual({ kind: "synthetic", detail: "provider-managed" });
  expect(overview.syntheticAuth).toBeUndefined();
});
