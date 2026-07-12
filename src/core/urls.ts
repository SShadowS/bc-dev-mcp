import type { ConnectionConfig } from "./types";

const DEFAULT_DEV_PORT = 7049; // WIRE: UriHelper.GetPort fallback (dep-decomp UriHelper.cs)
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
