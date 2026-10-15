import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BcDevError } from "./agent-errors";
import { upperInvariantUtf16 } from "./al-identifiers";
import {
  compareVersion,
  packageDirExists,
  parseVersion,
  requireAlProject,
  sameText,
  type PackageDownloadResult,
  type PackageSelector,
} from "./package-download";
import { extractEntry } from "./snapshot/zip";

const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// WIRE: live Cronus29 2026-10-15 — System's SymbolReference/NavxManifest AppId; dev/packages
// resolves the platform package with it (Microsoft/System, versionText = app.json platform).
const SYSTEM_APP_ID = "8874ed3a-0643-4247-9ced-7a7002f7135d";
const MAX_PACKAGES = 200;
// NavxManifest.xml is a few KB; the cap keeps a crafted package from inflating without bound.
const MAX_MANIFEST_BYTES = 1024 * 1024;
// Per-package failures that leave the run going; anything else (auth, unreachable, local
// filesystem) would fail every later package the same way, so it aborts the call.
const PER_PACKAGE_FAILURES = new Set(["NOT_FOUND", "TIMEOUT", "SERVER_REJECTED", "PROTOCOL_ERROR"]);

type Parts = readonly [number, number, number, number];
export type SymbolsStatus = "downloaded" | "replaced" | "unchanged" | "skipped" | "missing" | "failed";

export interface PackageManifest {
  appId: string;
  name: string;
  publisher: string;
  version: string;
  propagateDependencies: boolean;
  dependencies: Array<{ appId: string; name: string; publisher: string; minVersion: string }>;
}

export interface SymbolsPackage {
  publisher: string;
  appName: string;
  appId?: string;
  minVersion: string;
  source: "platform" | "application" | "dependency" | "transitive";
  requiredBy: string;
  status: SymbolsStatus;
  resolvedVersion?: string;
  packagePath?: string;
  error?: { code: string; message: string };
  warning?: string;
}

export interface SymbolsDownloadResult {
  packageDir: string;
  summary: Record<SymbolsStatus, number>;
  packages: SymbolsPackage[];
}

export type FetchPackage = (selector: PackageSelector) => Promise<PackageDownloadResult>;

interface Reference {
  publisher: string;
  appName: string;
  appId?: string;
  minVersion: string;
  parts: Parts;
  source: SymbolsPackage["source"];
  requiredBy: string;
}

interface CachedPackage {
  manifest: PackageManifest;
  parts: Parts;
  path: string;
}

function decodeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_m, name: string) =>
    ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]!);
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z]+)="([^"]*)"/g)) result[m[1]!] = decodeXml(m[2]!);
  return result;
}

/**
 * Identity and dependencies from a package's NavxManifest.xml; null when it is absent or has no
 * usable <App> element. Reads only that small entry, never the (large) SymbolReference.json.
 */
export function readPackageManifest(bytes: Uint8Array): PackageManifest | null {
  let xml: string;
  try {
    const entry = extractEntry(bytes, "NavxManifest.xml", MAX_MANIFEST_BYTES);
    if (!entry) return null;
    xml = entry.toString("utf8");
  } catch {
    return null;
  }
  // WIRE: live Cronus29 2026-10-15 — NavxManifest.xml carries <App Id Name Publisher Version
  // [PropagateDependencies="True"] …/> and <Dependencies><Dependency Id Name Publisher MinVersion …/>.
  const appTag = /<App\s[^>]*>/.exec(xml)?.[0];
  if (!appTag) return null;
  const app = attributes(appTag);
  if (!app["Id"] || !GUID.test(app["Id"]) || !app["Name"] || !app["Publisher"] || !app["Version"]) return null;
  const dependencies: PackageManifest["dependencies"] = [];
  for (const tag of xml.match(/<Dependency\s[^>]*>/g) ?? []) {
    const d = attributes(tag);
    if (d["Id"] && GUID.test(d["Id"]) && d["Name"] && d["Publisher"] && d["MinVersion"]) {
      dependencies.push({ appId: d["Id"].toLowerCase(), name: d["Name"], publisher: d["Publisher"], minVersion: d["MinVersion"] });
    }
  }
  return {
    appId: app["Id"].toLowerCase(),
    name: app["Name"],
    publisher: app["Publisher"],
    version: app["Version"],
    propagateDependencies: app["PropagateDependencies"]?.toLowerCase() === "true",
    dependencies,
  };
}

function versionParts(text: string): Parts | null {
  try {
    return parseVersion(text).parts;
  } catch {
    return null;
  }
}

function configError(message: string, path: string, cause?: unknown): BcDevError {
  return new BcDevError("CONFIGURATION_ERROR", message, "configuration", false, { path }, cause === undefined ? undefined : { cause });
}

function invalid(message: string): BcDevError {
  return new BcDevError("INVALID_ARGUMENT", message, "validation");
}

async function appJsonRoots(root: string): Promise<Reference[]> {
  const path = join(root, "app.json");
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse((await readFile(path, "utf8")).replace(/^﻿/, "")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("app.json is not a JSON object");
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    throw configError("app.json cannot be read or is not a JSON object", path, error);
  }

  const roots: Reference[] = [];
  const add = (field: string, ref: Omit<Reference, "minVersion" | "parts" | "requiredBy">, version: unknown) => {
    const parsed = parseVersion(version, `app.json ${field}`);
    roots.push({ ...ref, minVersion: parsed.text, parts: parsed.parts, requiredBy: "app.json" });
  };
  if (manifest["platform"] !== undefined) {
    add("platform", { publisher: "Microsoft", appName: "System", appId: SYSTEM_APP_ID, source: "platform" }, manifest["platform"]);
  }
  if (manifest["application"] !== undefined) {
    // The Application concept is selected by publisher/name only (no appId), as packageUrl does.
    add("application", { publisher: "Microsoft", appName: "Application", source: "application" }, manifest["application"]);
  }
  const dependencies = manifest["dependencies"] ?? [];
  if (!Array.isArray(dependencies)) throw invalid("app.json dependencies must be an array");
  dependencies.forEach((dep: unknown, i) => {
    const d = (dep ?? {}) as Record<string, unknown>;
    const appId = d["id"] ?? d["appId"];
    const field = `dependencies[${i}]`;
    if (typeof appId !== "string" || !GUID.test(appId.trim())) throw invalid(`app.json ${field} needs an id GUID`);
    for (const key of ["name", "publisher"]) {
      if (typeof d[key] !== "string" || (d[key] as string).trim() === "") throw invalid(`app.json ${field}.${key} must be a nonblank string`);
    }
    add(`${field}.version`, {
      publisher: (d["publisher"] as string).trim(),
      appName: (d["name"] as string).trim(),
      appId: appId.trim().toLowerCase(),
      source: "dependency",
    }, d["version"]);
  });
  return roots;
}

async function indexCache(packageDir: string): Promise<CachedPackage[]> {
  if (!(await packageDirExists(packageDir))) return [];
  const cached: CachedPackage[] = [];
  const entries = await readdir(packageDir, { withFileTypes: true }).catch((error: unknown) => {
    throw configError(".alpackages cannot be listed", packageDir, error);
  });
  for (const entry of entries) {
    // Skip in-flight temp files (.<name>.tmp) and anything that is not a top-level .app file.
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.toLowerCase().endsWith(".app")) continue;
    const path = join(packageDir, entry.name);
    const manifest = readPackageManifest(await readFile(path).catch(() => Buffer.alloc(0)));
    const parts = manifest && versionParts(manifest.version);
    if (manifest && parts) cached.push({ manifest, parts, path }); // unreadable files are ignored, never deleted
  }
  return cached;
}

function keyOf(ref: { publisher: string; appName: string; appId?: string }): string {
  return ref.appId ?? `concept:${upperInvariantUtf16(ref.publisher)}/${upperInvariantUtf16(ref.appName)}`;
}

function bestCached(cache: CachedPackage[], ref: Reference): CachedPackage | undefined {
  return cache
    .filter((c) => (ref.appId
      ? c.manifest.appId === ref.appId
      : sameText(c.manifest.publisher, ref.publisher) && sameText(c.manifest.name, ref.appName)))
    .filter((c) => compareVersion(c.parts, ref.parts) >= 0)
    .sort((a, b) => compareVersion(b.parts, a.parts))[0];
}

/**
 * Make <project>/.alpackages hold every symbol package app.json needs: platform System, the
 * Application concept, declared dependencies, and their dependencies. Sequential, one GET each.
 *
 * Deliberate deviation from the AL extension's symbol download, which stops at the second level and
 * filters it by PropagateDependencies: this follows the full transitive closure. For the standard
 * Application case the result is the same; for third-party dependencies the compiler (and al-sem)
 * need their dependencies present too.
 */
export async function downloadSymbols(
  project: string,
  options: { force?: boolean; dryRun?: boolean },
  fetchPackage: FetchPackage | null,
): Promise<SymbolsDownloadResult> {
  const root = await requireAlProject(project);
  const roots = await appJsonRoots(root);
  const packageDir = join(root, ".alpackages");
  const cache = await indexCache(packageDir);

  const queue: Reference[] = [];
  const queued = new Map<string, Reference>();
  const enqueue = (ref: Reference) => {
    const key = keyOf(ref);
    const existing = queued.get(key);
    if (!existing) {
      if (queued.size >= MAX_PACKAGES) {
        throw new BcDevError("PROTOCOL_ERROR", `Dependency graph exceeds ${MAX_PACKAGES} packages`, "protocol", false, { maxPackages: MAX_PACKAGES });
      }
      queued.set(key, ref);
      queue.push(ref);
    } else if (compareVersion(ref.parts, existing.parts) > 0) {
      if (queue.includes(existing)) {
        // Still pending: keep the highest requested minimum.
        Object.assign(existing, { minVersion: ref.minVersion, parts: ref.parts });
        return;
      }
      // ponytail: a higher minimum discovered after the package was processed is not re-requested;
      // the entry says so instead, so the agent knows to rerun with force.
      const entry = processed.get(existing);
      const resolved = entry?.resolvedVersion ? versionParts(entry.resolvedVersion) : null;
      if (entry && resolved && compareVersion(ref.parts, resolved) > 0) {
        const note = `${ref.requiredBy} requires >= ${ref.minVersion}; rerun bcdev_symbols_download with force`;
        entry.warning = entry.warning ? `${entry.warning}; ${note}` : note;
      }
    }
  };
  // The concept form (Application by publisher/name) and the appId form must dedup to one package.
  const alias = (ref: Reference, appId: string) => {
    if (!queued.has(appId)) queued.set(appId, ref);
  };
  const enqueueDependencies = (manifest: PackageManifest | null, parent: Reference) => {
    if (options.dryRun || !manifest) return;
    for (const dep of manifest.dependencies) {
      const parts = versionParts(dep.minVersion);
      if (!parts) continue;
      enqueue({
        publisher: dep.publisher,
        appName: dep.name,
        appId: dep.appId,
        minVersion: parts.join("."),
        parts,
        source: "transitive",
        requiredBy: `${parent.publisher}/${parent.appName}`,
      });
    }
  };

  const packages: SymbolsPackage[] = [];
  const processed = new Map<Reference, SymbolsPackage>();
  roots.forEach(enqueue);
  for (let ref = queue.shift(); ref; ref = queue.shift()) {
    const base = {
      publisher: ref.publisher,
      appName: ref.appName,
      ...(ref.appId ? { appId: ref.appId } : {}),
      minVersion: ref.minVersion,
      source: ref.source,
      requiredBy: ref.requiredBy,
    };
    const hit = options.force ? undefined : bestCached(cache, ref);
    if (hit) {
      packages.push({ ...base, status: "skipped", resolvedVersion: hit.manifest.version, packagePath: hit.path });
      processed.set(ref, packages.at(-1)!);
      alias(ref, hit.manifest.appId);
      enqueueDependencies(hit.manifest, ref);
      continue;
    }
    if (options.dryRun || !fetchPackage) {
      packages.push({ ...base, status: "missing" });
      continue;
    }
    let downloaded: PackageDownloadResult;
    try {
      downloaded = await fetchPackage({ publisher: ref.publisher, appName: ref.appName, version: ref.minVersion, appId: ref.appId });
    } catch (error) {
      // A transitive reference comes from a package manifest, not the caller, so a selector it
      // cannot form (overlong or control characters) fails only that package.
      const perPackage = error instanceof BcDevError
        && (PER_PACKAGE_FAILURES.has(error.code) || (error.code === "INVALID_ARGUMENT" && ref.source === "transitive"));
      if (!perPackage) throw error;
      packages.push({ ...base, status: "failed", error: { code: error.code, message: error.message } });
      continue; // a failed package's dependencies are not explored
    }
    packages.push({
      ...base,
      status: downloaded.status,
      resolvedVersion: downloaded.resolvedVersion,
      packagePath: downloaded.packagePath,
      ...(downloaded.warning ? { warning: downloaded.warning } : {}),
    });
    processed.set(ref, packages.at(-1)!);
    alias(ref, downloaded.appId.toLowerCase());
    const bytes = await readFile(downloaded.packagePath).catch((error: unknown) => {
      throw configError("Downloaded package cannot be read back", downloaded.packagePath, error);
    });
    const manifest = readPackageManifest(bytes);
    const parts = manifest && versionParts(manifest.version);
    if (manifest && parts) cache.push({ manifest, parts, path: downloaded.packagePath });
    enqueueDependencies(manifest, ref);
  }

  const summary: Record<SymbolsStatus, number> = { downloaded: 0, replaced: 0, unchanged: 0, skipped: 0, missing: 0, failed: 0 };
  for (const p of packages) summary[p.status]++;
  return { packageDir, summary, packages };
}
