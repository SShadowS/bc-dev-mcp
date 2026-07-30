import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuthorizationProvider } from "./authorization";
import { BcDevError } from "./agent-errors";
import { extractEntry } from "./snapshot/zip";
import type { ConnectionConfig } from "./types";
import { baseClientUrl } from "./urls";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const MAX_VERSION_PART = 2_147_483_647;
const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface PackageSelector {
  publisher: string;
  appName: string;
  version: string;
  appId?: string;
}

interface NormalizedPackageSelector extends PackageSelector {
  versionParts: readonly [number, number, number, number];
}

export interface PackageDownloadOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export interface PackageDownloadResult {
  status: "downloaded" | "replaced" | "unchanged";
  packagePath: string;
  publisher: string;
  appName: string;
  appId: string;
  requestedVersion: string;
  resolvedVersion: string;
  bytes: number;
  sha256: string;
}

interface PackageIdentity {
  publisher: string;
  appName: string;
  appId: string;
  version: string;
  versionParts: readonly [number, number, number, number];
}

function invalid(message: string): BcDevError {
  return new BcDevError("INVALID_ARGUMENT", message, "validation");
}

function nonblank(value: unknown, field: "publisher" | "appName"): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid(`${field} must be a nonblank string`);
  const trimmed = value.trim();
  if (/[\r\n]/.test(trimmed)) throw invalid(`${field} must not contain newline characters`);
  return trimmed;
}

function parseVersion(value: unknown, field = "version"): {
  text: string;
  parts: readonly [number, number, number, number];
} {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(value.trim())) {
    throw invalid(`${field} must be a four-part numeric version such as 28.0.0.0`);
  }
  const parsed = value.trim().split(".").map(Number);
  if (parsed.some((part) => !Number.isSafeInteger(part) || part < 0 || part > MAX_VERSION_PART)) {
    throw invalid(`${field} contains an invalid numeric component`);
  }
  const parts = parsed as [number, number, number, number];
  return { text: parts.join("."), parts };
}

function normalizeSelector(selector: PackageSelector): NormalizedPackageSelector {
  const publisher = nonblank(selector.publisher, "publisher");
  const appName = nonblank(selector.appName, "appName");
  const version = parseVersion(selector.version);
  let appId: string | undefined;
  if (selector.appId !== undefined) {
    if (typeof selector.appId !== "string" || !GUID.test(selector.appId.trim())) {
      throw invalid("appId must be a GUID");
    }
    appId = selector.appId.trim().toLowerCase();
  }
  return { publisher, appName, version: version.text, versionParts: version.parts, ...(appId ? { appId } : {}) };
}

function packageUrl(c: ConnectionConfig, selector: NormalizedPackageSelector): string {
  const params = new URLSearchParams({
    publisher: selector.publisher,
    appName: selector.appName,
    versionText: selector.version,
  });
  // WIRE: PackagesApiClient.DownloadPackage sends appId except for the case-insensitive
  // "Application" concept reference (dep-decomp PackagesApiClient.cs and
  // al-codeanalysis-decomp SymbolReferenceSpecification.IsApplicationConceptReference).
  if (selector.appId && selector.appName.toLowerCase() !== "application") {
    params.set("appId", selector.appId);
  }
  if (c.tenant) params.set("tenant", c.tenant);
  // WIRE: the official AL client downloads one package with GET dev/packages and the
  // publisher/appName/versionText selector above (dep-decomp PackagesApiClient.cs).
  // Validated live on BC28 on-prem 2026-07-04 and SaaS Sandbox 2026-07-30.
  return `${baseClientUrl(c)}dev/packages?${params.toString()}`;
}

export function packageDownloadUrl(c: ConnectionConfig, selector: PackageSelector): string {
  return packageUrl(c, normalizeSelector(selector));
}

function upperInvariantUtf16(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const unit = value[index]!;
    const upper = unit.toUpperCase();
    result += upper.length === 1 ? upper : unit;
  }
  return result;
}

function sameText(left: string, right: string): boolean {
  return upperInvariantUtf16(left) === upperInvariantUtf16(right);
}

function compareVersion(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number],
): number {
  for (let i = 0; i < 4; i++) {
    const difference = left[i]! - right[i]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function stringField(object: Record<string, unknown>, wanted: string): string | null {
  const key = Object.keys(object).find((candidate) => candidate.toLowerCase() === wanted.toLowerCase());
  const value = key === undefined ? undefined : object[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function protocolError(
  message: string,
  details: Record<string, string | number | boolean | null> = {},
  cause?: unknown,
): BcDevError {
  return new BcDevError(
    "PROTOCOL_ERROR",
    message,
    "protocol",
    false,
    details,
    cause === undefined ? undefined : { cause },
  );
}

function packageIdentity(bytes: Buffer, selector: NormalizedPackageSelector): PackageIdentity {
  let symbolBytes: Buffer | null;
  try {
    symbolBytes = extractEntry(bytes, "SymbolReference.json");
  } catch (error) {
    throw protocolError("Business Central returned an invalid application package archive", {}, error);
  }
  if (!symbolBytes) {
    throw protocolError("Business Central returned an application package without SymbolReference.json");
  }

  let symbols: Record<string, unknown>;
  try {
    const parsed = JSON.parse(symbolBytes.toString("utf8").replace(/^\uFEFF/, "")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    symbols = parsed as Record<string, unknown>;
  } catch (error) {
    throw protocolError("Business Central returned an application package with invalid SymbolReference.json", {}, error);
  }

  // WIRE: AL compiler .app packages identify their module at the top level of
  // SymbolReference.json as AppId, Name, Publisher, and Version. Confirmed against genuine
  // AL 18/BC28 packages and live SaaS download 2026-07-30.
  const publisher = stringField(symbols, "Publisher");
  const appName = stringField(symbols, "Name");
  const appId = stringField(symbols, "AppId");
  const resolvedVersionText = stringField(symbols, "Version");
  if (!publisher || !appName || !appId || !resolvedVersionText || !GUID.test(appId)) {
    throw protocolError("Business Central returned incomplete package identity metadata");
  }

  let resolvedVersion: ReturnType<typeof parseVersion>;
  try {
    resolvedVersion = parseVersion(resolvedVersionText, "returned package version");
  } catch (error) {
    throw protocolError("Business Central returned an invalid package version", {}, error);
  }
  if (!sameText(publisher, selector.publisher) || !sameText(appName, selector.appName)) {
    throw protocolError("Business Central returned a package with a different publisher or name", {
      requestedPublisher: selector.publisher,
      requestedAppName: selector.appName,
      returnedPublisher: publisher,
      returnedAppName: appName,
    });
  }
  if (selector.appId && appId.toLowerCase() !== selector.appId) {
    throw protocolError("Business Central returned a package with a different app ID", {
      requestedAppId: selector.appId,
      returnedAppId: appId,
    });
  }
  // WIRE: versionText is a minimum-version selector, not exact. A lower version request
  // resolved to the installed higher version on SaaS Sandbox 2026-07-30.
  if (compareVersion(resolvedVersion.parts, selector.versionParts) < 0) {
    throw protocolError("Business Central returned a package older than the requested minimum version", {
      requestedVersion: selector.version,
      returnedVersion: resolvedVersion.text,
    });
  }

  return {
    publisher,
    appName,
    appId: appId.toLowerCase(),
    version: resolvedVersion.text,
    versionParts: resolvedVersion.parts,
  };
}

function safeFilenameComponent(value: string): string {
  const safe = value.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[ .]+$/g, "");
  if (safe === "") throw protocolError("Business Central returned package identity that cannot form a safe filename");
  return safe;
}

function packageFilename(identity: PackageIdentity): string {
  return [
    safeFilenameComponent(identity.publisher),
    safeFilenameComponent(identity.appName),
    safeFilenameComponent(identity.version),
  ].join("_") + ".app";
}

async function readBoundedBody(response: Response, controller: AbortController, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = BigInt(contentLength);
    if (declaredBytes > BigInt(maxBytes)) {
      controller.abort();
      throw protocolError("Business Central package exceeds the download size limit", {
        maxBytes,
        contentLength: declaredBytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(declaredBytes) : contentLength,
      });
    }
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    total += chunk.length;
    if (total > maxBytes) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      throw protocolError("Business Central package exceeds the download size limit", {
        maxBytes,
        receivedBytes: total,
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function filesystemError(message: string, path: string, cause: unknown): BcDevError {
  return new BcDevError("CONFIGURATION_ERROR", message, "configuration", false, { path }, { cause });
}

async function existingFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw filesystemError("Unable to read an existing AL package destination", path, error);
  }
}

async function replaceValidatedFile(tempPath: string, destination: string, hadExisting: boolean): Promise<void> {
  try {
    await rename(tempPath, destination);
    return;
  } catch (error) {
    // POSIX rename replaces an existing file atomically. Windows can reject that with
    // EEXIST/EPERM, so use a recoverable backup swap only for that known case.
    if (!hadExisting || !["EEXIST", "EPERM"].includes(errorCode(error) ?? "")) throw error;
  }

  const backup = `${destination}.${randomUUID()}.backup`;
  await rename(destination, backup);
  try {
    await rename(tempPath, destination);
  } catch (error) {
    await rename(backup, destination).catch(() => undefined);
    throw error;
  }
  await rm(backup, { force: true });
}

async function installPackage(project: string, filename: string, bytes: Buffer, sha256: string): Promise<{
  status: PackageDownloadResult["status"];
  packagePath: string;
}> {
  const packageDir = join(resolve(project), ".alpackages");
  try {
    await mkdir(packageDir, { recursive: true });
    const packageDirStat = await lstat(packageDir);
    if (!packageDirStat.isDirectory() || packageDirStat.isSymbolicLink()) {
      throw new Error(".alpackages is not a direct directory");
    }
  } catch (error) {
    throw filesystemError("Unable to create the AL package directory", packageDir, error);
  }

  const packagePath = join(packageDir, filename);
  const existing = await existingFile(packagePath);
  if (existing && createHash("sha256").update(existing).digest("hex") === sha256) {
    return { status: "unchanged", packagePath };
  }

  const tempPath = join(packageDir, `.${filename}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, bytes, { flag: "wx" });
    await replaceValidatedFile(tempPath, packagePath, existing !== null);
  } catch (error) {
    throw filesystemError("Unable to install the downloaded AL package", packagePath, error);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
  return { status: existing === null ? "downloaded" : "replaced", packagePath };
}

export async function downloadPackage(
  c: ConnectionConfig,
  authorization: AuthorizationProvider,
  project: string,
  requested: PackageSelector,
  fetchFn: typeof fetch = fetch,
  options: PackageDownloadOptions = {},
): Promise<PackageDownloadResult> {
  const selector = normalizeSelector(requested);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw invalid("package download timeout must be positive");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw invalid("package download size limit must be positive");

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let bytes: Buffer;
  try {
    const response = await fetchFn(packageUrl(c, selector), {
      method: "GET",
      headers: { Authorization: await authorization.getAuthorizationHeader() },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      const hint = c.authentication === "UserPassword"
        ? "verify BC_DEV_USER and BC_DEV_PASSWORD"
        : "verify the Azure CLI login, tenant, and Business Central account access";
      throw new BcDevError("AUTHENTICATION_FAILED", `Business Central rejected package download authentication; ${hint}`, "auth");
    }
    if (response.status === 404) {
      throw new BcDevError(
        "NOT_FOUND",
        `No installed Business Central package matched ${selector.publisher}/${selector.appName} at version ${selector.version} or newer`,
        "server",
        false,
        {
          publisher: selector.publisher,
          appName: selector.appName,
          version: selector.version,
          appId: selector.appId ?? null,
        },
      );
    }
    if (!response.ok) {
      throw new BcDevError(
        "SERVER_REJECTED",
        `Business Central package download returned HTTP ${response.status}`,
        "server",
        response.status >= 500,
        { status: response.status },
      );
    }
    bytes = await readBoundedBody(response, controller, maxBytes);
  } catch (error) {
    if (error instanceof BcDevError) throw error;
    if (timedOut) {
      throw new BcDevError(
        "TIMEOUT",
        `Business Central package download timed out after ${timeoutMs} ms`,
        "network",
        true,
        { timeoutMs },
        { cause: error },
      );
    }
    throw new BcDevError(
      "ENDPOINT_UNREACHABLE",
      "Business Central package endpoint is unreachable",
      "network",
      true,
      {},
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  const identity = packageIdentity(bytes, selector);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const installed = await installPackage(project, packageFilename(identity), bytes, sha256);
  return {
    ...installed,
    publisher: identity.publisher,
    appName: identity.appName,
    appId: identity.appId,
    requestedVersion: selector.version,
    resolvedVersion: identity.version,
    bytes: bytes.length,
    sha256,
  };
}
