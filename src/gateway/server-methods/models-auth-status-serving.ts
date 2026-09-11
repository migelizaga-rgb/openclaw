import {
  createModelCatalogDecisions,
  resolveCatalogDecisionRuntimeStatus,
} from "../../agents/model-catalog-decisions.js";
import { collectSelectedModelProviders } from "../../agents/model-selection-config.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { PreparedGatewayModelCatalogSnapshot } from "../server-model-catalog-auth.js";
import type { ModelAuthServingSnapshot, ModelServingAuth } from "./models-auth-status.types.js";

/** Projects serving decisions without exporting credential-bearing route objects. */
export async function buildModelAuthServingSnapshot(
  owner: PreparedGatewayModelCatalogSnapshot,
): Promise<ModelAuthServingSnapshot> {
  const assertCurrent = (isCurrent = owner.isCurrent) => {
    if (!isCurrent()) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "Model authentication changed while reading serving status. Retry the request.",
      );
    }
  };
  assertCurrent();
  const configured = collectSelectedModelProviders({ cfg: owner.config, agentId: owner.agentId });
  const keyOf = ({ provider, model }: { provider: string; model: string }) =>
    JSON.stringify([provider, model]);
  const pinned = new Set(configured.filter((selection) => selection.profileId).map(keyOf));
  const selections = new Map(
    configured
      .filter((selection) => selection.mainModel && !pinned.has(keyOf(selection)))
      .map((selection) => [keyOf(selection), selection]),
  );
  if (selections.size === 0) {
    return { agentId: owner.agentId, agentDir: owner.agentDir, models: [] };
  }
  const decisions = createModelCatalogDecisions({
    cfg: owner.config,
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    snapshot: owner,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: owner.authStore,
    preparedRuntimeAuthModes: owner.authModes,
    preparedRuntimeAuthMaterializations: owner.authMaterializations,
    preparedSyntheticAuthComplete: owner.catalogComplete,
    preferredAuthSource: owner.preferredAuthSource,
    pluginRegistry: owner.pluginRegistry,
    observationConfig: owner.observationConfig,
    isCurrent: owner.isCurrent,
  });
  const models: ModelServingAuth[] = [];
  for (const { provider, model } of selections.values()) {
    const entry = owner.entries.find((row) => row.provider === provider && row.id === model) ?? {
      provider,
      id: model,
      name: model,
    };
    const variants = owner.routeVariants.filter(
      (row) => row.provider === provider && row.id === model,
    );
    const host = await decisions.evaluateEntry(entry, variants.length ? variants : undefined);
    const evaluated = decisions.evaluateNative(entry, host);
    const runtime = resolveCatalogDecisionRuntimeStatus({
      cfg: owner.config,
      agentId: owner.agentId,
      entry,
      evaluation: evaluated,
      pluginRegistry: owner.pluginRegistry,
    });
    assertCurrent(decisions.isCurrent);
    models.push({
      provider,
      model,
      availability: evaluated.availability,
      availabilityAuthoritative: evaluated.availabilityAuthoritative,
      unavailableReason: evaluated.unavailableReason,
      unavailableUntil: evaluated.unavailableUntil,
      authRequirement: evaluated.selectedRoute?.authRequirement,
      selectedProfileId: evaluated.selectedProfileId,
      selectedAuthMode: evaluated.selectedAuthMode,
      evidence: evaluated.evidence,
      environmentVariable: evaluated.environmentVariable,
      runtimeAuth: evaluated.runtimeAuth
        ? { id: evaluated.runtimeAuth.id, source: evaluated.runtimeAuth.source }
        : undefined,
      requestedRuntimeId: runtime.runtime?.id ?? evaluated.requestedRuntimeId,
      runtimeAvailability: runtime.runtimeAvailability,
      routeIncompatibility:
        evaluated.routeResolution?.kind === "incompatible"
          ? { code: evaluated.routeResolution.code, message: evaluated.routeResolution.message }
          : undefined,
      runtimeIncompatibility: runtime.runtimeIncompatibility,
    });
  }
  return { agentId: owner.agentId, agentDir: owner.agentDir, models };
}
