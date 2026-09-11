/** Tests provider env-var candidate and auth evidence lookup. */
import { describe, expect, it } from "vitest";
import {
  resolveProviderEnvironmentAdmission,
  resolveProviderUseAdmission,
} from "../agents/provider-model-auth-source-plan.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  getProviderEnvVars,
  listKnownProviderAuthEnvVarNames,
  listKnownSecretEnvVarNames,
  omitEnvKeysCaseInsensitive,
  resolveProviderAuthEnvVarCandidates,
  resolveProviderBindingEnvVarCandidates,
} from "./provider-env-vars.js";

describe("provider env vars", () => {
  it("excludes non-model setup claims while retaining their authentication variables", () => {
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "openrouter",
          providers: ["openrouter"],
          setup: { providers: [{ id: "openrouter", envVars: ["OPENROUTER_API_KEY"] }] },
        },
        {
          id: "perplexity",
          setup: { providers: [{ id: "perplexity", envVars: ["OPENROUTER_API_KEY"] }] },
        },
        { id: "media", setup: { providers: [{ id: "media", envVars: ["MEDIA_API_KEY"] }] } },
      ],
    });
    const params = { metadataSnapshot, config: {} };
    const providerEnvVars = resolveProviderBindingEnvVarCandidates(params);
    expect(providerEnvVars).toEqual({
      openrouter: [{ pluginId: "openrouter", envVars: ["OPENROUTER_API_KEY"] }],
    });
    expect(resolveProviderAuthEnvVarCandidates(params)).toMatchObject({
      perplexity: ["OPENROUTER_API_KEY"],
      media: ["MEDIA_API_KEY"],
    });
    expect([
      ...resolveProviderUseAdmission({
        providerEnvVars,
        env: { OPENROUTER_API_KEY: "fake-router-key", MEDIA_API_KEY: "fake-media-key" },
      }).keys(),
    ]).toEqual(["openrouter"]);
  });

  it("admits only directly declared model identities in one plugin's credential family", () => {
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "family",
          origin: "bundled",
          providers: ["family", "family-plan", "family-unselected"],
          providerAuthAliases: { "family-alias": "family" },
          setup: {
            providers: [
              { id: "family", envVars: ["FAMILY_API_KEY"] },
              { id: "family-plan", envVars: ["FAMILY_API_KEY"] },
              { id: "family-media", envVars: ["FAMILY_API_KEY"] },
            ],
          },
        },
      ],
    });
    const providerEnvVars = resolveProviderBindingEnvVarCandidates({
      metadataSnapshot,
      config: {},
    });
    const result = resolveProviderEnvironmentAdmission({
      providerEnvVars,
      env: { FAMILY_API_KEY: "fake-key" },
    });
    expect([...result.bindings.keys()]).toEqual(["family", "family-plan"]);
    expect(result.conflicts).toEqual([]);
    expect(providerEnvVars["family-media"]).toBeUndefined();
    expect(providerEnvVars["family-alias"]).toBeUndefined();
  });

  it("reports rival plugin claims without letting one key bind either plugin", () => {
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "first-plugin",
          providers: ["first"],
          setup: { providers: [{ id: "first", envVars: ["SHARED_API_KEY"] }] },
        },
        {
          id: "second-plugin",
          providers: ["second"],
          setup: { providers: [{ id: "second", envVars: ["SHARED_API_KEY"] }] },
        },
      ],
    });
    const providerEnvVars = resolveProviderBindingEnvVarCandidates({ metadataSnapshot });
    const result = resolveProviderEnvironmentAdmission({
      providerEnvVars,
      env: { SHARED_API_KEY: "fake-private-value" },
    });
    expect(result.bindings.size).toBe(0);
    expect(result.conflicts).toEqual([
      {
        envVar: "SHARED_API_KEY",
        pluginIds: ["first-plugin", "second-plugin"],
        providers: ["first", "second"],
      },
    ]);
    expect(
      resolveProviderUseAdmission({
        config: {
          models: { providers: { first: { baseUrl: "https://first.example", models: [] } } },
        },
        providerEnvVars,
        env: { SHARED_API_KEY: "fake-private-value" },
      }),
    ).toEqual(new Map([["first", { kind: "provider-config" }]]));
  });

  it("keeps each family provider's declared variable precedence", () => {
    const result = resolveProviderEnvironmentAdmission({
      env: { PARENT_KEY: "parent-account", PLAN_KEY: "plan-account" },
      providerEnvVars: {
        family: [{ pluginId: "family", envVars: ["PARENT_KEY", "PLAN_KEY"] }],
        "family-plan": [{ pluginId: "family", envVars: ["PLAN_KEY", "PARENT_KEY"] }],
      },
    });
    expect(result.bindings).toEqual(
      new Map([
        ["family", { kind: "environment", envVar: "PARENT_KEY" }],
        ["family-plan", { kind: "environment", envVar: "PLAN_KEY" }],
      ]),
    );
  });

  it.each(["disabled", "denied"])(
    "ignores an explicitly %s model plugin's ownership claim",
    (policy) => {
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "active",
            origin: "bundled",
            providers: ["active"],
            setup: { providers: [{ id: "active", envVars: ["OWNER_API_KEY"] }] },
          },
          {
            id: "inactive",
            origin: "bundled",
            providers: ["inactive"],
            setup: { providers: [{ id: "inactive", envVars: ["OWNER_API_KEY"] }] },
          },
        ],
      });
      const providerEnvVars = resolveProviderBindingEnvVarCandidates({
        metadataSnapshot,
        config: {
          plugins:
            policy === "disabled"
              ? { entries: { inactive: { enabled: false } } }
              : { deny: ["inactive"] },
        },
      });
      expect([
        ...resolveProviderEnvironmentAdmission({
          providerEnvVars,
          env: { OWNER_API_KEY: "fake-key" },
        }).bindings.keys(),
      ]).toEqual(["active"]);
    },
  );

  it("keeps workspace ownership claims behind the existing trust policy", () => {
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "official",
          origin: "bundled",
          providers: ["official"],
          setup: { providers: [{ id: "official", envVars: ["OWNER_API_KEY"] }] },
        },
        {
          id: "workspace",
          origin: "workspace",
          providers: ["workspace"],
          setup: { providers: [{ id: "workspace", envVars: ["OWNER_API_KEY"] }] },
        },
      ],
    });
    const env = { OWNER_API_KEY: "fake-key" };
    expect([
      ...resolveProviderEnvironmentAdmission({
        env,
        providerEnvVars: resolveProviderBindingEnvVarCandidates({ metadataSnapshot }),
      }).bindings.keys(),
    ]).toEqual(["official"]);
    expect(
      resolveProviderEnvironmentAdmission({
        env,
        providerEnvVars: resolveProviderBindingEnvVarCandidates({
          metadataSnapshot,
          config: { plugins: { allow: ["workspace"] } },
        }),
      }).conflicts,
    ).toEqual([
      {
        envVar: "OWNER_API_KEY",
        pluginIds: ["official", "workspace"],
        providers: ["official", "workspace"],
      },
    ]);
  });

  it("does not use a Kimi subscription key as a Moonshot model credential", () => {
    expect(getProviderEnvVars("moonshot")).toEqual(["MOONSHOT_API_KEY"]);
  });

  it("keeps provider credentials in auth and secret inventories", () => {
    const sharedSecretNames = [
      "ANTHROPIC_OAUTH_TOKEN",
      "BRAVE_API_KEY",
      "DEEPGRAM_API_KEY",
      "FIRECRAWL_API_KEY",
      "GROQ_API_KEY",
      "PERPLEXITY_API_KEY",
      "OPENROUTER_API_KEY",
      "TAVILY_API_KEY",
    ];
    const providerAuthNames = listKnownProviderAuthEnvVarNames();
    const secretNames = listKnownSecretEnvVarNames();
    for (const name of sharedSecretNames) {
      expect(providerAuthNames).toContain(name);
      expect(secretNames).toContain(name);
    }
    expect(providerAuthNames).toContain("MINIMAX_CODE_PLAN_KEY");
    expect(providerAuthNames).toContain("MINIMAX_CODING_API_KEY");
    expect(providerAuthNames).toContain("OPENAI_ADMIN_KEY");
    expect(providerAuthNames).toContain("ANTHROPIC_ADMIN_KEY");
    expect(providerAuthNames).toContain("ANTHROPIC_ADMIN_API_KEY");
    expect(secretNames).toContain("OPENAI_ADMIN_KEY");
    expect(secretNames).toContain("ANTHROPIC_ADMIN_KEY");
    expect(secretNames).toContain("ANTHROPIC_ADMIN_API_KEY");
    expect(listKnownSecretEnvVarNames()).not.toContain("OPENCLAW_API_KEY");
  });

  it.each(["GH_TOKEN", "GITHUB_TOKEN"])("audits %s without activating a provider", (name) => {
    expect(listKnownSecretEnvVarNames()).toContain(name);
    expect(listKnownProviderAuthEnvVarNames()).not.toContain(name);
    expect(getProviderEnvVars("github-copilot")).not.toContain(name);
  });

  it("omits env keys case-insensitively", () => {
    const env = omitEnvKeysCaseInsensitive(
      {
        OpenAI_Api_Key: "openai-secret",
        Github_Token: "gh-secret",
        OPENCLAW_API_KEY: "keep-me",
      },
      ["OPENAI_API_KEY", "GITHUB_TOKEN"],
    );

    expect(env.OpenAI_Api_Key).toBeUndefined();
    expect(env.Github_Token).toBeUndefined();
    expect(env.OPENCLAW_API_KEY).toBe("keep-me");
  });

  it("ignores prototype-chain keys when resolving provider env vars", () => {
    expect(getProviderEnvVars("__proto__")).toStrictEqual([]);
    expect(getProviderEnvVars("constructor")).toStrictEqual([]);
    expect(getProviderEnvVars("openai")).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
    expect(getProviderEnvVars("anthropic")).toEqual(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    expect(getProviderEnvVars("fal")).toEqual(["FAL_KEY", "FAL_API_KEY"]);
  });
});
