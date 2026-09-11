import { afterEach, expect, it, vi } from "vitest";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { buildProviderAuthRecoveryHint } from "../provider-auth-recovery-hint.js";

afterEach(() => vi.unstubAllEnvs());

it("explains an existing unbound variable without asking the user to set it again", () => {
  vi.stubEnv("FIXTURE_API_KEY", "private-fixture-value");
  const config = {};
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: ["fixture-api", "other-api"].map((id) => ({
      id,
      providers: [id],
      setup: { providers: [{ id, envVars: ["FIXTURE_API_KEY"] }] },
    })),
  });
  const hint = withPluginMetadataSnapshotScope(
    metadata,
    () =>
      buildProviderAuthRecoveryHint({
        provider: "fixture-api",
        config,
        env: process.env,
        includeEnvVar: true,
      }),
    { config, trustConfigIdentity: true },
  );
  expect(hint).toContain('FIXTURE_API_KEY is set, but it is not bound to provider "fixture-api"');
  expect(hint).toContain("openclaw doctor --fix");
  expect(hint).toContain("models.providers.fixture-api.apiKey");
  expect(hint).not.toContain("set an API key env var");
  expect(hint).not.toContain("private-fixture-value");
});

it("does not recommend setting an already admitted variable", () => {
  vi.stubEnv("FIXTURE_API_KEY", "private-fixture-value");
  const config = {};
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "fixture-api",
        providers: ["fixture-api"],
        setup: { providers: [{ id: "fixture-api", envVars: ["FIXTURE_API_KEY"] }] },
      },
    ],
  });
  const hint = withPluginMetadataSnapshotScope(
    metadata,
    () =>
      buildProviderAuthRecoveryHint({
        provider: "fixture-api",
        config,
        env: process.env,
        includeEnvVar: true,
      }),
    { config, trustConfigIdentity: true },
  );
  expect(hint).not.toContain("set an API key env var");
  expect(hint).not.toContain("not bound");
});
