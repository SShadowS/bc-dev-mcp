/**
 * App lifecycle over HTTP: list, publish, uninstall and unpublish Business Central apps.
 * Publish uses the developer endpoint (dev/apps); everything else uses the Automation API
 * v2.0 `extensions` entity and its bound actions. Pure library: injected fetch and
 * authorization, typed returns, BcDevError on failure, no logging.
 *
 * SECURITY: never put the Authorization value or an authenticated URL into an error.
 */
import type { AuthorizationProvider } from "./authorization";
import { BcDevError } from "./agent-errors";
import type { ConnectionConfig } from "./types";
import { automationUrl } from "./urls";

export const DEFAULT_APP_LIFECYCLE_TIMEOUT_MS = 120_000;
export const MAX_APP_LIFECYCLE_TIMEOUT_MS = 600_000;
const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_BC_MESSAGE_LENGTH = 2000;

export interface AppRecord {
  appId: string;
  packageId: string;
  name: string;
  publisher: string;
  version: string;
  isInstalled: boolean;
  publishedAs: string;
}

export interface AppLifecycleContext {
  config: ConnectionConfig;
  authorization: AuthorizationProvider;
  fetchFn: typeof fetch;
  apiPort?: number;
  companyId?: string;
  timeoutMs?: number;
}

export interface AppListFilter {
  publisher?: string;
  appId?: string;
}

export interface AppListResult {
  companyId: string;
  apps: AppRecord[];
}

function invalid(message: string, details: Record<string, string | number | boolean | null> = {}): BcDevError {
  return new BcDevError("INVALID_ARGUMENT", message, "validation", false, details);
}

function protocol(message: string): BcDevError {
  return new BcDevError("PROTOCOL_ERROR", message, "protocol");
}

function requireGuid(value: string, field: string): string {
  if (!GUID.test(value.trim())) throw invalid(`${field} must be a GUID`, { [field]: value });
  return value.trim().toLowerCase();
}

function bcErrorOf(status: number, text: string): { bcErrorCode: string | null; bcMessage: string } {
  let bcErrorCode: string | null = null;
  let bcMessage = "";
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const error = body["error"];
    if (error !== null && typeof error === "object") {
      // WIRE: Automation API errors are {"error":{"code","message"}} (Cronus28 BC28.4, 2026-10-03).
      const e = error as Record<string, unknown>;
      bcErrorCode = typeof e["code"] === "string" ? e["code"] : null;
      bcMessage = typeof e["message"] === "string" ? e["message"] : "";
    } else if (typeof body["Message"] === "string") {
      // WIRE: a failed dev/apps publish is 422 {"Message","ErrorType"} (Cronus28 BC28.4, 2026-10-03).
      bcErrorCode = typeof body["ErrorType"] === "string" ? body["ErrorType"] : null;
      bcMessage = body["Message"];
    }
  } catch {
    // Not JSON: HTTP.sys and proxies answer with HTML or plain text. Handled below.
  }
  if (bcMessage.trim() === "") {
    bcMessage = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  bcMessage = bcMessage.trim() || `HTTP ${status}`;
  return { bcErrorCode, bcMessage: bcMessage.slice(0, MAX_BC_MESSAGE_LENGTH) };
}

function rejection(config: ConnectionConfig, operation: string, status: number, text: string): BcDevError {
  const { bcErrorCode, bcMessage } = bcErrorOf(status, text);
  const details = { httpStatus: status, bcErrorCode, bcMessage };
  if (status === 401 || status === 403) {
    const hint = config.authentication === "UserPassword"
      ? "verify BC_DEV_USER and BC_DEV_PASSWORD"
      : "verify the Azure CLI login, tenant, and Business Central account access";
    return new BcDevError("AUTHENTICATION_FAILED", `${operation}: Business Central rejected the credentials; ${hint}`, "auth", false, { httpStatus: status });
  }
  if (status === 404) {
    return new BcDevError("NOT_FOUND", `${operation}: Business Central returned 404: ${bcMessage}`, "server", false, details);
  }
  return new BcDevError(
    "SERVER_REJECTED",
    `${operation} was rejected by Business Central (HTTP ${status}): ${bcMessage}`,
    "server",
    status >= 500,
    details,
  );
}

async function bcRequest(
  ctx: AppLifecycleContext,
  url: string,
  method: "GET" | "POST",
  operation: string,
  body?: BodyInit,
): Promise<string> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_APP_LIFECYCLE_TIMEOUT_MS;
  const headers: Record<string, string> = {
    Authorization: await ctx.authorization.getAuthorizationHeader(),
    Accept: "application/json",
  };
  let requestBody = body;
  if (method === "POST" && body === undefined) {
    // WIRE: a bodyless POST without a length is refused by HTTP.sys with 411 (Cronus28,
    // 2026-10-03). An empty string body makes fetch send Content-Length: 0.
    requestBody = "";
    headers["Content-Type"] = "application/json";
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await ctx.fetchFn(url, { method, headers, body: requestBody, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw rejection(ctx.config, operation, response.status, text);
    return text;
  } catch (error) {
    if (error instanceof BcDevError) throw error;
    if (timedOut) {
      throw new BcDevError("TIMEOUT", `${operation} timed out after ${timeoutMs} ms`, "network", true, { timeoutMs }, { cause: error });
    }
    throw new BcDevError("ENDPOINT_UNREACHABLE", `${operation}: Business Central endpoint is unreachable`, "network", true, {}, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(ctx: AppLifecycleContext, url: string, operation: string): Promise<unknown> {
  const text = await bcRequest(ctx, url, "GET", operation);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw protocol(`${operation}: Business Central returned a body that is not JSON`);
  }
}

function valueRows(body: unknown, operation: string): unknown[] {
  const value = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["value"] : undefined;
  if (!Array.isArray(value)) throw protocol(`${operation}: Business Central returned no OData value array`);
  return value;
}

function toAppRecord(row: unknown): AppRecord {
  const r = (row !== null && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const parts = [r["versionMajor"], r["versionMinor"], r["versionBuild"], r["versionRevision"]];
  if (
    typeof r["id"] !== "string" || !GUID.test(r["id"]) ||
    typeof r["packageId"] !== "string" || !GUID.test(r["packageId"]) ||
    typeof r["displayName"] !== "string" ||
    typeof r["publisher"] !== "string" ||
    typeof r["isInstalled"] !== "boolean" ||
    typeof r["publishedAs"] !== "string" ||
    parts.some((part) => typeof part !== "number" || !Number.isSafeInteger(part) || part < 0)
  ) {
    throw protocol("Business Central returned an extensions row with an unexpected shape");
  }
  return {
    appId: r["id"].toLowerCase(),
    packageId: r["packageId"].toLowerCase(),
    name: r["displayName"],
    publisher: r["publisher"],
    version: parts.join("."),
    isInstalled: r["isInstalled"],
    // WIRE: publishedAs arrives as " Dev" with a leading space (Cronus28 BC28.4, 2026-10-03).
    publishedAs: r["publishedAs"].trim(),
  };
}

async function resolveCompanyId(ctx: AppLifecycleContext): Promise<string> {
  if (ctx.companyId !== undefined) return requireGuid(ctx.companyId, "companyId");
  const operation = "List Business Central companies";
  const rows = valueRows(await getJson(ctx, automationUrl(ctx.config, "companies", ctx.apiPort, { $select: "id" }), operation), operation);
  if (rows.length === 0) {
    throw new BcDevError("NOT_FOUND", "Business Central returned no company for the Automation API; pass companyId explicitly", "server");
  }
  const id = (rows[0] as Record<string, unknown> | null)?.["id"];
  if (typeof id !== "string" || !GUID.test(id)) throw protocol(`${operation}: Business Central returned a company without a GUID id`);
  return id.toLowerCase();
}

export async function listApps(ctx: AppLifecycleContext, filter: AppListFilter = {}): Promise<AppListResult> {
  const appId = filter.appId === undefined ? undefined : requireGuid(filter.appId, "appId");
  const companyId = await resolveCompanyId(ctx);
  const query: Record<string, string> = {};
  if (filter.publisher !== undefined) {
    // OData string literal: a single quote is escaped by doubling it.
    query["$filter"] = `publisher eq '${filter.publisher.replace(/'/g, "''")}'`;
  }
  const operation = "List Business Central extensions";
  const body = await getJson(ctx, automationUrl(ctx.config, `companies(${companyId})/extensions`, ctx.apiPort, query), operation);
  const apps = valueRows(body, operation)
    .map(toAppRecord)
    // appId is filtered here, not with $filter, so no unverified OData GUID-literal syntax is needed.
    .filter((app) => appId === undefined || app.appId === appId);
  return { companyId, apps };
}

export interface UninstallAppResult {
  status: "uninstalled" | "alreadyUninstalled";
  app: AppRecord;
  dataDeleted: boolean;
  alsoUninstalled: AppRecord[] | null;
  warning?: string;
}

export interface UnpublishAppResult {
  status: "unpublished";
  app: AppRecord;
}

function requireVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(value.trim())) {
    throw invalid("version must be a four-part numeric version such as 1.0.0.0", { version: value });
  }
  return value.trim().split(".").map(Number).join(".");
}

function notPublished(appId: string): BcDevError {
  return new BcDevError("NOT_FOUND", `No published app has appId ${appId}`, "server", false, { appId });
}

function actionUrl(ctx: AppLifecycleContext, companyId: string, packageId: string, action: string): string {
  // WIRE: bound actions Microsoft.NAV.install|uninstall|uninstallAndDeleteExtensionData|unpublish
  // on extensions(<packageId>) take only the binding parameter; 204 on success
  // (Cronus28 BC28.4 $metadata and live calls, 2026-10-03).
  return automationUrl(ctx.config, `companies(${companyId})/extensions(${packageId})/Microsoft.NAV.${action}`, ctx.apiPort);
}

export async function uninstallApp(
  ctx: AppLifecycleContext,
  options: { appId: string; deleteData?: boolean },
): Promise<UninstallAppResult> {
  const appId = requireGuid(options.appId, "appId");
  const deleteData = options.deleteData ?? false;
  const before = await listApps(ctx);
  const scoped: AppLifecycleContext = { ...ctx, companyId: before.companyId };
  const rows = before.apps.filter((app) => app.appId === appId);
  if (rows.length === 0) throw notPublished(appId);
  const target = rows.find((app) => app.isInstalled);
  if (!target) return { status: "alreadyUninstalled", app: rows[0]!, dataDeleted: false, alsoUninstalled: [] };

  const action = deleteData ? "uninstallAndDeleteExtensionData" : "uninstall";
  await bcRequest(scoped, actionUrl(ctx, before.companyId, target.packageId, action), "POST", `Uninstall ${target.name}`);

  // WIRE: uninstall also uninstalls installed dependents and says nothing about it in the
  // 204 response (Cronus28 BC28.4, 2026-10-03). The before/after diff is the only report.
  let after: AppRecord[];
  try {
    after = (await listApps(scoped)).apps;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return {
      status: "uninstalled",
      app: { ...target, isInstalled: false },
      dataDeleted: deleteData,
      alsoUninstalled: null,
      warning: `Uninstall succeeded, but listing extensions afterwards failed (${reason}); call bcdev_app_list to see which dependent apps Business Central also uninstalled.`,
    };
  }
  const afterByPackage = new Map(after.map((app) => [app.packageId, app]));
  const alsoUninstalled = before.apps
    .filter((app) => app.isInstalled && app.packageId !== target.packageId && afterByPackage.get(app.packageId)?.isInstalled === false)
    .map((app) => ({ ...app, isInstalled: false }));
  return {
    status: "uninstalled",
    app: afterByPackage.get(target.packageId) ?? { ...target, isInstalled: false },
    dataDeleted: deleteData,
    alsoUninstalled,
  };
}

export async function unpublishApp(
  ctx: AppLifecycleContext,
  options: { appId: string; version?: string },
): Promise<UnpublishAppResult> {
  const appId = requireGuid(options.appId, "appId");
  const version = options.version === undefined ? undefined : requireVersion(options.version);
  const listed = await listApps(ctx, { appId });
  const publishedVersions = listed.apps.map((app) => app.version).join(", ");
  const matches = version === undefined ? listed.apps : listed.apps.filter((app) => app.version === version);
  if (matches.length === 0) {
    if (version === undefined) throw notPublished(appId);
    throw new BcDevError(
      "NOT_FOUND",
      `App ${appId} is not published at version ${version}${publishedVersions ? ` (published: ${publishedVersions})` : ""}`,
      "server",
      false,
      { appId, version, publishedVersions },
    );
  }
  if (matches.length > 1) {
    throw invalid(`App ${appId} is published at several versions (${publishedVersions}); pass version to choose one`, {
      appId,
      publishedVersions,
    });
  }
  const target = matches[0]!;
  // WIRE: BC refuses unpublish while installed (400 Application_DialogException) and while a
  // dependent is still published (400 naming the dependents); both pass through as
  // SERVER_REJECTED (Cronus28 BC28.4, 2026-10-03).
  await bcRequest(
    { ...ctx, companyId: listed.companyId },
    actionUrl(ctx, listed.companyId, target.packageId, "unpublish"),
    "POST",
    `Unpublish ${target.name} ${target.version}`,
  );
  return { status: "unpublished", app: target };
}
