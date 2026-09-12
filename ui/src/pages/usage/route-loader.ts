import type { RouteLoaderOptions } from "@openclaw/uirouter";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { providerUsageFromSnapshotResult, requestUsageSnapshot } from "./request-usage-snapshot.ts";
import type { UsageRouteData } from "./types.ts";

function errorMessage(error: unknown): string {
  if (isMissingOperatorReadScopeError(error)) {
    return formatMissingOperatorReadScopeMessage("usage");
  }
  return formatUiError(error, "request failed");
}

export async function loadUsageRoute(
  context: ApplicationContext,
  options: RouteLoaderOptions,
  pending: UsageRouteData,
): Promise<UsageRouteData> {
  const { gateway, gatewaySnapshot, query } = pending;
  try {
    // Loading can outlive the route, selected scope, or Gateway transport.
    // Preserve the admission snapshot and never start requests for a retired owner.
    const current = gateway.snapshot;
    if (
      !options.shouldRun() ||
      current.phase !== "connected" ||
      !current.client ||
      current.client !== gatewaySnapshot.client ||
      current.hello !== gatewaySnapshot.hello ||
      context.agentSelection.state.scopeId !== query.agentId
    ) {
      return pending;
    }
    const snapshot = await requestUsageSnapshot(
      current.client,
      { ...query, agentId: query.agentId ?? undefined },
      options.signal,
    );
    if (snapshot.ok) {
      return {
        ...pending,
        result: snapshot.value.result,
        costSummary: snapshot.value.costSummary,
        providerUsage: snapshot.value.providerUsage,
        loadedAtMs: Date.now(),
      };
    }
    return {
      ...pending,
      providerUsage: providerUsageFromSnapshotResult(snapshot),
      error: errorMessage(snapshot.error.cause),
    };
  } catch (error) {
    return { ...pending, error: errorMessage(error) };
  }
}
