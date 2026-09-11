/** Prepares host credential attempts for one isolated native-harness completion. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import type { AgentHarness } from "./harness/types.js";
import { ensureAuthProfileStore } from "./model-auth.js";
import { getPreparedModelRuntimePreferredAuthSource } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";

export async function prepareIsolatedHarnessAuth(params: {
  provider: string;
  modelId: string;
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  authProfileId?: string;
  preparedModelRuntime: PreparedModelRuntimeSnapshot;
  harness: Pick<AgentHarness, "id" | "authBootstrap">;
  assertCurrent: () => void;
  unavailable: (message: string) => Error;
}) {
  const resolution = await resolveModelAsync(
    params.provider,
    params.modelId,
    params.agentDir,
    params.config,
    {
      ...params.preparedModelRuntime.createStores(),
      preparedModelRuntime: params.preparedModelRuntime,
      workspaceDir: params.workspaceDir,
      authProfileId: params.authProfileId,
      skipAgentDiscovery: true,
      allowBundledStaticCatalogFallback: true,
      preferBundledStaticCatalogTransport: true,
    },
  );
  const model = resolution.model;
  if (!model) {
    throw params.unavailable(
      resolution.error ?? `Unknown isolated completion model ${params.provider}/${params.modelId}.`,
    );
  }
  params.assertCurrent();
  const store = ensureAuthProfileStore(params.agentDir, {
    profileId: params.authProfileId,
    readOnly: true,
    allowKeychainPrompt: false,
    config: params.config,
  });
  const preferred = getPreparedModelRuntimePreferredAuthSource(
    params.preparedModelRuntime,
    params.provider,
    params.modelId,
  );
  const { attempts } = prepareAgentRuntimeAuth({
    provider: model.provider,
    modelId: model.id,
    modelApi: model.api,
    modelBaseUrl: model.baseUrl,
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: process.env,
    authProfileStore: store,
    preferredDirectSource: preferred?.kind === "direct" ? preferred : undefined,
    preferredAuthProfileId: preferred?.kind === "profile" ? preferred.profileId : undefined,
    sessionAuthProfileId: params.authProfileId,
    sessionAuthProfileSource: params.authProfileId ? "user" : undefined,
    harnessId: params.harness.id,
    harnessRuntime: params.harness.id,
    harnessAuthBootstrap: params.harness.authBootstrap,
  });
  return { model, store, attempts };
}
