import { definePage, type RouteLoaderOptions } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { UsageRouteData } from "./usage-page.ts";

function currentLocalDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function loadUsageRouteData(
  context: ApplicationContext,
  options: RouteLoaderOptions,
): Promise<UsageRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  const startDate = currentLocalDate();
  const query: UsageRouteData["query"] = {
    startDate,
    endDate: startDate,
    scope: "family",
    timeZone: "local",
    agentId: context.agentSelection.state.scopeId,
  };
  const pending: UsageRouteData = {
    gateway,
    gatewaySnapshot,
    query,
    result: null,
    costSummary: null,
    providerUsage: { state: "pending" },
    loadedAtMs: null,
    error: null,
  };
  if (gatewaySnapshot.phase !== "connected" || !gatewaySnapshot.client) {
    return pending;
  }

  return import("./route-loader.ts").then(
    ({ loadUsageRoute }) => loadUsageRoute(context, options, pending),
    (error: unknown) => ({ ...pending, error: formatUiError(error, "request failed") }),
  );
}

export const page = definePage({
  ...routePageSpec("usage"),
  loader: loadUsageRouteData,
  component: () =>
    import("./usage-page.ts").then(() => ({
      header: true,
      render: (data: UsageRouteData | undefined) =>
        html`<openclaw-usage-page .routeData=${data}></openclaw-usage-page>`,
    })),
});
