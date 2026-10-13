import type { ConnectionConfig } from "./types";
import type { AuthorizationProvider } from "./authorization";
import { baseClientUrl, metadataUrl } from "./urls";

export interface DevServerInfo {
  webApiVersion: string;
  runtimeVersion?: string;
  debuggerVersion?: string;
  supportsTestRunning: boolean;
  supportsCoreSignalR: boolean;
  supportsSourceDownload: boolean;
}

export const DEFAULT_DEV_ENDPOINT_TIMEOUT_MS = 15_000;

export class DevEndpointError extends Error {
  constructor(
    message: string,
    public readonly kind: "unreachable" | "auth" | "http",
  ) {
    super(message);
    this.name = "DevEndpointError";
  }
}

function major(version: string): number {
  return Number(version.split(".")[0] ?? 0);
}

function pick(obj: Record<string, unknown>, key: string): string | undefined {
  const found = Object.keys(obj).find((k) => k.toLowerCase() === key.toLowerCase());
  if (found === undefined) return undefined;
  const value = obj[found];
  return value === null || value === undefined ? undefined : String(value);
}

function authError(c: ConnectionConfig): DevEndpointError {
  const hint = c.authentication === "UserPassword"
    ? "verify BC_DEV_USER and BC_DEV_PASSWORD"
    : "verify the Azure CLI login, tenant, and Business Central account access";
  return new DevEndpointError(`Dev endpoint rejected authentication; ${hint}`, "auth");
}

/**
 * Throws an "auth" DevEndpointError when the dev endpoint rejects the credentials. Needed because
 * dev/metadata answers without checking them on-prem, so fetchServerInfo alone cannot tell.
 */
export async function verifyDevAuthentication(
  c: ConnectionConfig,
  authorization: AuthorizationProvider,
  fetchFn: typeof fetch = fetch,
  timeoutMs = DEFAULT_DEV_ENDPOINT_TIMEOUT_MS,
): Promise<void> {
  // ponytail: on-prem only; the SaaS answer for a parameterless sourcecontent GET is unverified live.
  if (c.environmentType !== "OnPrem") return;
  // WIRE: on-prem dev/metadata is not auth-gated: BC28 (Cronus28) and BC29 (Cronus29) both return 200
  // for a wrong password, no credentials or an unknown tenant (live 2026-10-13). GET dev/sourcecontent
  // without type/id is gated on both and read-only: 401 for rejected credentials (wrong password,
  // unknown user, none, unknown tenant), 404 problem+json once authenticated (live 2026-10-13).
  const url = `${baseClientUrl(c)}dev/sourcecontent?${new URLSearchParams({ tenant: c.tenant ?? "default" })}`;
  const authHeader = await authorization.getAuthorizationHeader();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Authorization: authHeader }, signal: controller.signal });
  } catch (err) {
    throw new DevEndpointError(
      controller.signal.aborted
        ? `Dev endpoint authentication check timed out after ${timeoutMs} ms`
        : `Dev endpoint authentication check failed — is the developer service reachable? (${String(err)})`,
      "unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }
  await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) throw authError(c);
}

export async function fetchServerInfo(
  c: ConnectionConfig,
  authorization: AuthorizationProvider,
  fetchFn: typeof fetch = fetch,
  timeoutMs = DEFAULT_DEV_ENDPOINT_TIMEOUT_MS,
): Promise<DevServerInfo> {
  const authHeader = await authorization.getAuthorizationHeader();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    // WIRE: GET dev/metadata returns ServerInfo JSON (dep-decomp ServerInfoApiClient.cs)
    response = await fetchFn(metadataUrl(c), { headers: { Authorization: authHeader }, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new DevEndpointError(`Dev endpoint metadata request timed out after ${timeoutMs} ms`, "unreachable");
    }
    throw new DevEndpointError(
      `Dev endpoint unreachable at ${metadataUrl(c)} — is the BC server running and the developer service port open? (${String(err)})`,
      "unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 401 || response.status === 403) throw authError(c);
  if (response.status === 404) {
    // Pre-metadata servers are dev API 1.0 (dep-decomp ServerInfoApiClient.TryGetLegacyServerInfo)
    return { webApiVersion: "1.0", supportsTestRunning: false, supportsCoreSignalR: false, supportsSourceDownload: false };
  }
  if (!response.ok) {
    throw new DevEndpointError(`Dev endpoint returned HTTP ${response.status}`, "http");
  }
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new DevEndpointError("Dev endpoint returned a non-JSON response for dev/metadata", "http");
  }
  const webApiVersion = pick(body, "webApiVersion") ?? "0.0";
  const runtimeVersion = pick(body, "runtimeVersion");
  // WIRE: ServerInfo.DebuggerVersion gates hub debugger capabilities independently of WebApiVersion
  // (dep-decomp ServerInfo.cs; esp-decomp HubBasedDebuggerService uses it for GetSourceContent/GetWatchNode overloads)
  const debuggerVersion = pick(body, "debuggerVersion");
  return {
    webApiVersion,
    runtimeVersion,
    debuggerVersion,
    // WIRE: DevApiFeature.TestRunning => 7.0, NetCoreSignalR => 6.0, GetSourceCode => 2.0 (dep-decomp DevApiFeatureExtensions.cs)
    supportsTestRunning: major(webApiVersion) >= 7,
    supportsCoreSignalR: major(webApiVersion) >= 6,
    supportsSourceDownload: major(webApiVersion) >= 2,
  };
}
