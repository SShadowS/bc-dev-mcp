import type { ConnectionConfig } from "./types";

export const DEFAULT_DEV_PORT = 7049; // WIRE: UriHelper.GetPort fallback (dep-decomp UriHelper.cs)
const CLOUD_API_ROOT = "https://api.businesscentral.dynamics.com/v2.0/";

export function baseClientUrl(c: ConnectionConfig): string {
  if (c.environmentType !== "OnPrem") {
    // WIRE: confirmed live against BC SaaS Sandbox 2026-07-10.
    return `${CLOUD_API_ROOT}${encodeURIComponent(c.environmentName)}/`;
  }
  const u = new URL(c.server);
  const port = c.port ?? (u.port ? Number(u.port) : DEFAULT_DEV_PORT);
  return `${u.protocol}//${u.hostname}:${port}/${encodeURIComponent(c.serverInstance)}/`;
}

export function metadataUrl(c: ConnectionConfig): string {
  const qs = c.tenant ? `?tenant=${encodeURIComponent(c.tenant)}` : "";
  // WIRE: "dev/metadata" route (dep-decomp ServerInfoApiClient.cs)
  return `${baseClientUrl(c)}dev/metadata${qs}`;
}

export function hubUrl(c: ConnectionConfig, hub: "TestRunnerHub" | "DebuggerHub"): string {
  // WIRE: "/TestRunnerHub" and "/DebuggerHub" under <base>/dev (lmt-decomp HubBasedTestRunnerService.cs, esp-decomp HubBasedDebuggerService.cs)
  return `${baseClientUrl(c)}dev/${hub}`;
}

// WIRE: DeploymentConstants.SnapshotServicesPort (dep-decomp DeploymentConstants.cs); default when launch config port absent.
export const DEFAULT_SNAPSHOT_PORT = 7083;

// WIRE: snapshot REST base <proto>//<host>:<snapshotPort>/<instance>/snapshotdebugger/<verb>; tenant query always sent.
export function snapshotUrl(
  c: ConnectionConfig,
  verb: string,
  snapshotPort: number,
  extraQuery: Record<string, string> = {},
): string {
  const base =
    c.environmentType === "OnPrem"
      ? (() => {
          const u = new URL(c.server);
          return `${u.protocol}//${u.hostname}:${snapshotPort}/${encodeURIComponent(c.serverInstance)}/snapshotdebugger/${verb}`;
        })()
      : // WIRE: SaaS snapshot route confirmed by live metadata request 2026-07-10; no separate port.
        `${baseClientUrl(c)}snapshotdebugger/${verb}`;
  const params = new URLSearchParams(extraQuery);
  params.set("tenant", c.tenant ?? "default");
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// WIRE: on-prem Automation API answers on the BC API services port, 7048 by default
// (Cronus28 BC28.4, 2026-10-03). Launch configurations do not carry it.
export const DEFAULT_API_PORT = 7048;

export type SchemaUpdateMode = "synchronize" | "recreate" | "forcesync";
export type DependencyPublishingOption = "default" | "ignore" | "strict";

function odataQuery(query: Record<string, string>): string {
  const entries = Object.entries(query);
  // OData system options need a literal "$" and %20 for spaces; URLSearchParams would
  // emit %24 and "+". encodeURIComponent leaves the quote characters of a literal intact.
  return entries.length === 0
    ? ""
    : `?${entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
}

export function automationUrl(
  c: ConnectionConfig,
  path: string,
  apiPort: number = DEFAULT_API_PORT,
  query: Record<string, string> = {},
): string {
  if (c.environmentType !== "OnPrem") {
    // SaaS: the Entra token carries the tenant, so no tenant query. Not yet verified live;
    // listed as an open box in scripts/e2e.md.
    return `${baseClientUrl(c)}api/microsoft/automation/v2.0/${path}${odataQuery(query)}`;
  }
  const u = new URL(c.server);
  // WIRE: <proto>//<host>:<apiPort>/<instance>/api/microsoft/automation/v2.0/<path>?tenant=<t>
  // (Cronus28 BC28.4, 2026-10-03).
  return `${u.protocol}//${u.hostname}:${apiPort}/${encodeURIComponent(c.serverInstance)}/api/microsoft/automation/v2.0/${path}${odataQuery({ ...query, tenant: c.tenant ?? "default" })}`;
}

export function devAppsUrl(
  c: ConnectionConfig,
  schemaUpdateMode: SchemaUpdateMode,
  dependencyPublishingOption: DependencyPublishingOption,
): string {
  // WIRE: dev/apps takes tenant, SchemaUpdateMode and DependencyPublishingOption with lower-case
  // enum values (dep-decomp AppsApiClient.cs PublishPackageFile); 200 on Cronus28 2026-10-03.
  const params = new URLSearchParams({
    tenant: c.tenant ?? "default",
    SchemaUpdateMode: schemaUpdateMode,
    DependencyPublishingOption: dependencyPublishingOption,
  });
  return `${baseClientUrl(c)}dev/apps?${params.toString()}`;
}
