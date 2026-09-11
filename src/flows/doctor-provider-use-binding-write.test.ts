import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import { prepareProviderUseBindingMigration } from "../commands/doctor/shared/provider-use-binding-migration.js";
import { readConfigFileSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runWriteConfigHealth } from "./doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: (config: OpenClawConfig) => config,
}));
let state: OpenClawTestState;
afterEach(async () => {
  await state?.cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(
  [false, true].flatMap((repairEndpoint) =>
    ["before-write", "temporary-file", "temporary-file-other-root"].map((timing) => ({
      repairEndpoint,
      timing,
    })),
  ),
)(
  "retracts an env binding when an account appears at $timing (endpoint repair: $repairEndpoint)",
  async ({ repairEndpoint, timing }) => {
    state = await createOpenClawTestState({
      label: "doctor-provider-binding-write",
      env: {
        BYTEPLUS_API_KEY: "fixture-env-account",
        OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions/", import.meta.url)),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      },
    });
    const config: OpenClawConfig = {
      agents: { defaults: { model: "byteplus-plan/ark-code-latest" }, entries: { main: {} } },
    };
    await state.writeConfig(config);
    const original = await fs.readFile(state.configPath, "utf8");
    const prepared = await prepareProviderUseBindingMigration({
      config,
      configPath: state.configPath,
      env: state.env,
    });
    const bindings: Record<string, SecretRef> = {
      "byteplus-plan": { source: "env", provider: "default", id: "BYTEPLUS_API_KEY" },
    };
    expect(prepared.config.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(
      bindings["byteplus-plan"],
    );
    const endpoint = "https://example.com/repaired-provider";
    const cfg = structuredClone(prepared.config);
    if (repairEndpoint && cfg.models?.providers?.["byteplus-plan"]) {
      cfg.models.providers["byteplus-plan"].baseUrl = endpoint;
    }
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const options = { repair: true, nonInteractive: true };
    const ctx: DoctorHealthFlowContext = {
      runtime,
      options,
      prompter: createDoctorPrompter({ runtime, options }),
      cfg,
      cfgForPersistence: structuredClone(prepared.config),
      configPath: state.configPath,
      sourceConfigValid: true,
      env: timing === "temporary-file-other-root" ? undefined : state.env,
      configResult: {
        cfg,
        shouldWriteConfig: true,
        providerUseBindings: bindings,
        providerUseBindingMigrationPending: prepared.pending,
        unsetPaths: prepared.unsetPaths,
      },
    };
    const saveAccount = () =>
      state.writeAuthProfiles({
        version: 1,
        profiles: {
          "byteplus:saved": { type: "api_key", provider: "byteplus", key: "fixture-saved-account" },
        },
      });
    if (timing === "before-write") {
      await saveAccount();
    } else {
      const writeFile = fs.writeFile;
      let saved = false;
      vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, fileOptions) => {
        await writeFile(file, data, fileOptions);
        if (
          !saved &&
          typeof data === "string" &&
          data.includes('"byteplus-plan"') &&
          data.includes('"BYTEPLUS_API_KEY"')
        ) {
          saved = true;
          await saveAccount();
          if (timing === "temporary-file-other-root") {
            process.env.OPENCLAW_STATE_DIR = path.join(state.stateDir, "other-root");
          }
        }
      });
    }

    await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });

    expect(ctx.cfg.models?.providers?.["byteplus-plan"]?.apiKey).toBeUndefined();
    expect(ctx.configResult.providerUseBindingMigrationPending).toBe(false);
    const written = await fs.readFile(state.configPath, "utf8");
    if (repairEndpoint) {
      expect(JSON.parse(written).models.providers["byteplus-plan"]).toEqual({ baseUrl: endpoint });
    } else {
      expect(written).toBe(original);
    }
    expect(note.mock.calls).toContainEqual([
      expect.stringContaining("byteplus:saved"),
      "Doctor warnings",
    ]);
    expect(note.mock.calls.flat().join("\n")).not.toContain("Bound selected provider");
    expect(note.mock.calls.flat().join("\n")).not.toContain("fixture-saved-account");
    const repeated = await prepareProviderUseBindingMigration({
      config,
      configPath: state.configPath,
      env: state.env,
    });
    expect(repeated.warnings?.join("\n")).toContain("byteplus:saved");
  },
);

it.each(["models", "providers"] as const)(
  "defers a selected provider binding owned by a %s include without changing either file",
  async (includeOwner) => {
    state = await createOpenClawTestState({
      label: "doctor-provider-binding-include",
      env: {
        BYTEPLUS_API_KEY: "fixture-env-account",
        OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions/", import.meta.url)),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      },
    });
    const includeName = `${includeOwner}-owned.json`;
    const includePath = path.join(path.dirname(state.configPath), includeName);
    const includeContents = `${JSON.stringify(includeOwner === "models" ? { providers: {} } : {}, null, 2)}\n`;
    await fs.mkdir(path.dirname(includePath), { recursive: true });
    await fs.writeFile(includePath, includeContents);
    await state.writeConfig({
      agents: { defaults: { model: "byteplus-plan/ark-code-latest" }, entries: { main: {} } },
      models:
        includeOwner === "models"
          ? { $include: `./${includeName}` }
          : { providers: { $include: `./${includeName}` } },
    });
    const rootContents = await fs.readFile(state.configPath, "utf8");
    const snapshot = await readConfigFileSnapshot({ observe: false });
    expect(snapshot.valid).toBe(true);
    const prepared = prepareProviderUseBindingMigration({
      config: snapshot.sourceConfig,
      configPath: state.configPath,
      env: state.env,
    });
    expect(prepared.bindings).toEqual({
      "byteplus-plan": { source: "env", provider: "default", id: "BYTEPLUS_API_KEY" },
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const options = { repair: true, nonInteractive: true };
    const ctx: DoctorHealthFlowContext = {
      runtime,
      options,
      prompter: createDoctorPrompter({ runtime, options }),
      cfg: prepared.config,
      cfgForPersistence: structuredClone(prepared.config),
      configPath: state.configPath,
      sourceConfigValid: true,
      env: state.env,
      configResult: {
        cfg: prepared.config,
        shouldWriteConfig: true,
        providerUseBindings: prepared.bindings,
        providerUseBindingMigrationPending: prepared.pending,
        unsetPaths: prepared.unsetPaths,
      },
    };

    await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });

    expect(await fs.readFile(state.configPath, "utf8")).toBe(rootContents);
    expect(await fs.readFile(includePath, "utf8")).toBe(includeContents);
    expect(ctx.cfg.models?.providers?.["byteplus-plan"]).toBeUndefined();
    expect(ctx.configResult.providerUseBindingMigrationPending).toBe(false);
    const output = note.mock.calls.flat().join("\n");
    expect(output).toContain("byteplus-plan");
    expect(output).toContain("BYTEPLUS_API_KEY");
    expect(output).toContain(includeName);
    expect(output).not.toContain("Bound selected provider");
    expect(output).not.toContain("fixture-env-account");
    const repeated = prepareProviderUseBindingMigration({
      config: snapshot.sourceConfig,
      configPath: state.configPath,
      env: state.env,
    });
    expect(repeated.bindings).toEqual(prepared.bindings);
  },
);
