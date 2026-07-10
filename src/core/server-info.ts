import type { ConnectionConfig } from "./types";
import { basicAuthHeader, metadataUrl } from "./urls";

export interface DevServerInfo {
  webApiVersion: string;
  runtimeVersion?: string;
  supportsTestRunning: boolean;
  supportsCoreSignalR: boolean;
}

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

export async function fetchServerInfo(c: ConnectionConfig, fetchFn: typeof fetch = fetch): Promise<DevServerInfo> {
  let response: Response;
  try {
    // WIRE: GET dev/metadata returns ServerInfo JSON (dep-decomp ServerInfoApiClient.cs)
    response = await fetchFn(metadataUrl(c), { headers: { Authorization: basicAuthHeader(c) } });
  } catch (err) {
    throw new DevEndpointError(
      `Dev endpoint unreachable at ${metadataUrl(c)} — is the BC server running and the developer service port open? (${String(err)})`,
      "unreachable",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new DevEndpointError("Dev endpoint rejected credentials (check BC_DEV_USER / BC_DEV_PASSWORD)", "auth");
  }
  if (response.status === 404) {
    // Pre-metadata servers are dev API 1.0 (dep-decomp ServerInfoApiClient.TryGetLegacyServerInfo)
    return { webApiVersion: "1.0", supportsTestRunning: false, supportsCoreSignalR: false };
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
  return {
    webApiVersion,
    runtimeVersion,
    // WIRE: DevApiFeature.TestRunning => 7.0, NetCoreSignalR => 6.0 (dep-decomp DevApiFeatureExtensions.cs)
    supportsTestRunning: major(webApiVersion) >= 7,
    supportsCoreSignalR: major(webApiVersion) >= 6,
  };
}
