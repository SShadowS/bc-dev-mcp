import type { ConnectionConfig } from "./types";

const DEFAULT_DEV_PORT = 7049; // WIRE: UriHelper.GetPort fallback (dep-decomp UriHelper.cs)

export function baseClientUrl(c: ConnectionConfig): string {
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

export function basicAuthHeader(c: ConnectionConfig): string {
  return "Basic " + Buffer.from(`${c.username}:${c.password}`).toString("base64");
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
  const u = new URL(c.server);
  const base = `${u.protocol}//${u.hostname}:${snapshotPort}/${encodeURIComponent(c.serverInstance)}/snapshotdebugger/${verb}`;
  const params = new URLSearchParams(extraQuery);
  params.set("tenant", c.tenant ?? "default");
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
