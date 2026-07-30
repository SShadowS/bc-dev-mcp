import type { ConnectionConfig } from "./types";
import type { AuthorizationProvider } from "./authorization";
import { DevEndpointError } from "./server-info";
import { baseClientUrl } from "./urls";

export interface SourceContentResult {
  content: string;
  isAlContent: boolean;
}

export function sourceContentUrl(c: ConnectionConfig, objectType: number, objectId: number): string {
  // WIRE: GET dev/sourcecontent?type=<int>&id=<int>[&tenant=] (dep-decomp SourceContentApiClient.GetSource),
  // requires DevApiFeature.GetSourceCode => dev API 2.0 (dep-decomp DevApiFeatureExtensions.cs).
  // Validated live on BC28 on-prem 2026-07-04 and SaaS Sandbox 2026-07-30.
  const params = new URLSearchParams({ type: String(objectType), id: String(objectId) });
  if (c.tenant) params.set("tenant", c.tenant);
  return `${baseClientUrl(c)}dev/sourcecontent?${params.toString()}`;
}

export async function fetchSourceContent(
  c: ConnectionConfig,
  authorization: AuthorizationProvider,
  objectType: number,
  objectId: number,
  fetchFn: typeof fetch = fetch,
): Promise<SourceContentResult> {
  const url = sourceContentUrl(c, objectType, objectId);
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Authorization: await authorization.getAuthorizationHeader() } });
  } catch (err) {
    throw new DevEndpointError(
      `Dev endpoint unreachable at ${url} — is the BC server running and the developer service port open? (${String(err)})`,
      "unreachable",
    );
  }
  if (response.status === 401 || response.status === 403) {
    const hint = c.authentication === "UserPassword"
      ? "verify BC_DEV_USER and BC_DEV_PASSWORD"
      : "verify the Azure CLI login, tenant, and Business Central account access";
    throw new DevEndpointError(`Dev endpoint rejected authentication; ${hint}`, "auth");
  }
  if (response.status === 404) {
    // WIRE: BC28 returns 404 from dev/sourcecontent for objects without deployed source (live E2E
    // 2026-07-16: codeunit 1 -> 404, published app object -> 200 + JSON). Indistinguishable from a
    // pre-2.0 server missing the route entirely, so both surface as the empty no-source result.
    return { content: "", isAlContent: false };
  }
  if (!response.ok) {
    throw new DevEndpointError(`dev/sourcecontent returned HTTP ${response.status}`, "http");
  }
  const body = await response.text();
  // WIRE: body observed live 2026-07-04 as SourceContent JSON {Content, IsALContent}; the official
  // client reads it as an opaque string, so tolerate a raw-text body too (treated as AL source).
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed !== null && typeof parsed === "object") {
      const content = pickString(parsed, "content") ?? "";
      const isAl = pickBoolean(parsed, "isALContent") ?? pickBoolean(parsed, "isAlContent") ?? content !== "";
      return { content, isAlContent: isAl };
    }
  } catch {
    // not JSON — fall through to raw text
  }
  return { content: body, isAlContent: body !== "" };
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const found = Object.keys(obj).find((k) => k.toLowerCase() === key.toLowerCase());
  return found !== undefined && typeof obj[found] === "string" ? (obj[found] as string) : undefined;
}

function pickBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const found = Object.keys(obj).find((k) => k.toLowerCase() === key.toLowerCase());
  return found !== undefined && typeof obj[found] === "boolean" ? (obj[found] as boolean) : undefined;
}
