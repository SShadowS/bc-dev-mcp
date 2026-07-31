import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuthorizationProvider } from "./authorization";
import { BcDevError } from "./agent-errors";
import { upperInvariantUtf16 } from "./al-identifiers";
import { extractEntry } from "./snapshot/zip";
import type { ConnectionConfig } from "./types";
import { baseClientUrl } from "./urls";

export const DEFAULT_PACKAGE_DOWNLOAD_TIMEOUT_MS = 120_000;
export const MAX_PACKAGE_DOWNLOAD_TIMEOUT_MS = 300_000;
export const DEFAULT_PACKAGE_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_PACKAGE_DOWNLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_PACKAGE_SELECTOR_LENGTH = 250;
const DEFAULT_SYMBOL_REFERENCE_BYTES = 512 * 1024 * 1024;
const MAX_VERSION_PART = 2_147_483_647;
const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const installTails = new Map<string, Promise<void>>();

export interface PackageSelector {
  publisher: string;
  appName: string;
  version: string;
  appId?: string;
}

interface NormalizedPackageSelector extends PackageSelector {
  versionParts: readonly [number, number, number, number];
  requestedAppId?: string;
}

export interface PackageInstallFileOps {
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface PackageDownloadOptions {
  timeoutMs?: number;
  maxBytes?: number;
  // Test/integration seam for proving the DEFLATE allocation bound without a huge fixture.
  maxSymbolBytes?: number;
  installFileOps?: PackageInstallFileOps;
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
  if (trimmed.length > MAX_PACKAGE_SELECTOR_LENGTH) {
    throw invalid(`${field} must not exceed ${MAX_PACKAGE_SELECTOR_LENGTH} characters`);
  }
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

function isApplicationConcept(publisher: string, appName: string): boolean {
  // Only the Microsoft/Application identity was validated as the special concept selector.
  // An ordinary third-party app named Application retains its app ID and identity check.
  return publisher.toLowerCase() === "microsoft" && appName.toLowerCase() === "application";
}

function normalizeSelector(selector: PackageSelector): NormalizedPackageSelector {
  const publisher = nonblank(selector.publisher, "publisher");
  const appName = nonblank(selector.appName, "appName");
  const version = parseVersion(selector.version);
  let appId: string | undefined;
  let requestedAppId: string | undefined;
  if (selector.appId !== undefined) {
    if (typeof selector.appId !== "string" || !GUID.test(selector.appId.trim())) {
      throw invalid("appId must be a GUID");
    }
    requestedAppId = selector.appId.trim().toLowerCase();
    // WIRE: BC28 SaaS resolves the case-insensitive Microsoft/Application concept without appId and
    // ignores a deliberately supplied ID. See scripts/e2e-on-demand-source-symbols-2026-07-30.md.
    if (!isApplicationConcept(publisher, appName)) appId = requestedAppId;
  }
  return {
    publisher,
    appName,
    version: version.text,
    versionParts: version.parts,
    ...(appId ? { appId } : {}),
    ...(requestedAppId ? { requestedAppId } : {}),
  };
}

function packageUrl(c: ConnectionConfig, selector: NormalizedPackageSelector): string {
  const params = new URLSearchParams({
    publisher: selector.publisher,
    appName: selector.appName,
    versionText: selector.version,
  });
  // WIRE: BC28 SaaS accepts appId for ordinary packages and omits it for the case-insensitive
  // Microsoft/Application concept. See scripts/e2e-on-demand-source-symbols-2026-07-30.md.
  if (selector.appId) {
    params.set("appId", selector.appId);
  }
  if (c.tenant) params.set("tenant", c.tenant);
  // WIRE: BC28 SaaS downloads one package with GET dev/packages and the
  // publisher/appName/versionText selector above. Validated 2026-07-30; see the dated evidence.
  return `${baseClientUrl(c)}dev/packages?${params.toString()}`;
}

export function packageDownloadUrl(c: ConnectionConfig, selector: PackageSelector): string {
  return packageUrl(c, normalizeSelector(selector));
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

function packageIdentity(
  bytes: Buffer,
  selector: NormalizedPackageSelector,
  maxSymbolBytes: number,
): PackageIdentity {
  let symbolBytes: Buffer | null;
  try {
    symbolBytes = extractEntry(bytes, "SymbolReference.json", maxSymbolBytes);
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

function packageFilename(identity: PackageIdentity): string {
  // SAFETY: derive the destination from the validated package identity instead of trusting a
  // response filename, and remove the Windows invalid/control character set on every platform.
  const defaultName = `${identity.publisher}_${identity.appName}_${identity.version}`;
  const safe = defaultName.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "");
  if (safe === "") throw protocolError("Business Central returned package identity that cannot form a safe filename");
  return `${safe}.app`;
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

async function requireAlProject(project: string): Promise<string> {
  const root = resolve(project);
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    throw filesystemError("AL project directory does not exist or cannot be read", root, error);
  }
  if (!rootStat.isDirectory()) {
    throw new BcDevError(
      "CONFIGURATION_ERROR",
      "AL package downloads require project to identify an existing directory",
      "configuration",
      false,
      { path: root },
    );
  }

  const manifestPath = join(root, "app.json");
  let manifestStat;
  try {
    manifestStat = await stat(manifestPath);
  } catch (error) {
    throw filesystemError("AL package downloads require an existing project app.json", manifestPath, error);
  }
  if (!manifestStat.isFile()) {
    throw new BcDevError(
      "CONFIGURATION_ERROR",
      "AL package downloads require app.json to be a file",
      "configuration",
      false,
      { path: manifestPath },
    );
  }
  return root;
}

async function existingFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw filesystemError("Unable to read an existing AL package destination", path, error);
  }
}

const defaultInstallFileOps: PackageInstallFileOps = {
  rename: async (source, destination) => rename(source, destination),
  remove: async (path) => rm(path, { force: true }),
};

async function replaceValidatedFile(
  tempPath: string,
  destination: string,
  hadExisting: boolean,
  fileOps: PackageInstallFileOps,
): Promise<void> {
  try {
    await fileOps.rename(tempPath, destination);
    return;
  } catch (error) {
    // POSIX rename replaces an existing file atomically. Windows can reject that with
    // EEXIST/EPERM, so use a recoverable backup swap only for that known case.
    if (!hadExisting || !["EEXIST", "EPERM"].includes(errorCode(error) ?? "")) throw error;
  }

  const backup = `${destination}.${randomUUID()}.backup`;
  await fileOps.rename(destination, backup);
  // A process crash after this rename can leave only the ignored .backup. A later validated
  // download recreates the canonical destination; the backup remains evidence, never a partial app.
  try {
    await fileOps.rename(tempPath, destination);
  } catch (error) {
    await fileOps.rename(backup, destination).catch(() => undefined);
    throw error;
  }
  await fileOps.remove(backup);
}

async function withInstallLock<T>(destination: string, operation: () => Promise<T>): Promise<T> {
  const previous = installTails.get(destination) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = previous.then(() => current);
  installTails.set(destination, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (installTails.get(destination) === tail) installTails.delete(destination);
  }
}

async function installPackage(
  projectRoot: string,
  filename: string,
  bytes: Buffer,
  sha256: string,
  fileOps: PackageInstallFileOps,
): Promise<{
  status: PackageDownloadResult["status"];
  packagePath: string;
}> {
  const packageDir = join(projectRoot, ".alpackages");
  try {
    await mkdir(packageDir, { recursive: true });
  } catch (error) {
    throw filesystemError("Unable to create the AL package directory", packageDir, error);
  }
  let packageDirStat;
  try {
    packageDirStat = await lstat(packageDir);
  } catch (error) {
    throw filesystemError("Unable to inspect the AL package directory", packageDir, error);
  }
  if (!packageDirStat.isDirectory() || packageDirStat.isSymbolicLink()) {
    throw new BcDevError(
      "CONFIGURATION_ERROR",
      "AL package directory must be a direct directory, not a file, symlink, or junction",
      "configuration",
      false,
      { path: packageDir },
    );
  }

  const packagePath = join(packageDir, filename);
  return withInstallLock(packagePath, async () => {
    const existing = await existingFile(packagePath);
    if (existing && createHash("sha256").update(existing).digest("hex") === sha256) {
      return { status: "unchanged", packagePath };
    }

    const tempPath = join(packageDir, `.${filename}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, bytes, { flag: "wx" });
      await replaceValidatedFile(tempPath, packagePath, existing !== null, fileOps);
    } catch (error) {
      throw filesystemError("Unable to install the downloaded AL package", packagePath, error);
    } finally {
      await fileOps.remove(tempPath).catch(() => undefined);
    }
    return { status: existing === null ? "downloaded" : "replaced", packagePath };
  });
}

async function cancelUnusedBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already being discarded; cancellation failure does not replace
    // the typed HTTP error that follows.
  }
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_PACKAGE_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_PACKAGE_DOWNLOAD_BYTES;
  const maxSymbolBytes = options.maxSymbolBytes ?? DEFAULT_SYMBOL_REFERENCE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw invalid("package download timeout must be positive");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw invalid("package download size limit must be positive");
  if (timeoutMs > MAX_PACKAGE_DOWNLOAD_TIMEOUT_MS) {
    throw invalid(`package download timeout cannot exceed ${MAX_PACKAGE_DOWNLOAD_TIMEOUT_MS} ms`);
  }
  if (maxBytes > MAX_PACKAGE_DOWNLOAD_BYTES) {
    throw invalid(`package download size limit cannot exceed ${MAX_PACKAGE_DOWNLOAD_BYTES} bytes`);
  }
  if (!Number.isSafeInteger(maxSymbolBytes) || maxSymbolBytes <= 0 || maxSymbolBytes > DEFAULT_SYMBOL_REFERENCE_BYTES) {
    throw invalid(`package symbol size limit must be between 1 and ${DEFAULT_SYMBOL_REFERENCE_BYTES} bytes`);
  }
  const projectRoot = await requireAlProject(project);
  const authorizationHeader = await authorization.getAuthorizationHeader();

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
      headers: { Authorization: authorizationHeader },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      await cancelUnusedBody(response);
      const hint = c.authentication === "UserPassword"
        ? "verify BC_DEV_USER and BC_DEV_PASSWORD"
        : "verify the Azure CLI login, tenant, and Business Central account access";
      throw new BcDevError("AUTHENTICATION_FAILED", `Business Central rejected package download authentication; ${hint}`, "auth");
    }
    if (response.status === 404) {
      await cancelUnusedBody(response);
      throw new BcDevError(
        "NOT_FOUND",
        `No installed Business Central package matched ${selector.publisher}/${selector.appName} at version ${selector.version} or newer, or this server does not expose dev/packages`,
        "server",
        false,
        {
          publisher: selector.publisher,
          appName: selector.appName,
          version: selector.version,
          appId: selector.requestedAppId ?? null,
          appIdSent: selector.appId !== undefined,
        },
      );
    }
    if (!response.ok) {
      await cancelUnusedBody(response);
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

  const identity = packageIdentity(bytes, selector, maxSymbolBytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const installed = await installPackage(
    projectRoot,
    packageFilename(identity),
    bytes,
    sha256,
    options.installFileOps ?? defaultInstallFileOps,
  );
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
