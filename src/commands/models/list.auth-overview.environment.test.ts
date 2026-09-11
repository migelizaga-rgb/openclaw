import { expect, it } from "vitest";
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
        selectedEnvironmentVariable: "FIXTURE_API_KEY",
      });
      expect(overview.effective.kind).toBe("env");
      expect(overview.env?.source).toBe("env: FIXTURE_API_KEY");
      expect(overview.profiles.count).toBe(1);
      expect(overview.profiles.labels[0]).toContain("fixture-api:expired");
    },
  );
});
