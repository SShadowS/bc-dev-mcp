import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONVERTER_PIN } from "./converter-pin";

export const CACHE_DIR_ENV_VAR = "BC_DEV_CACHE_DIR";
const FAILURE_MEMO_MS = 10 * 60_000;

export interface ToolPin {
  version: string;
  /** Keyed `${process.platform}-${process.arch}`. */
  assets: Record<string, { name: string; sha256: string; size: number }>;
}

export interface ToolDescriptor {
  /** For messages: "al-sem" | "bc-mdc-converter". */
  name: string;
  /** Used as-is when set. */
  envVar: string;
  /** "0" disables the download. */
  downloadEnvVar: string;
  /** Bare command probed with versionOf. */
  pathCommand: string;
  /** <cache>/<cacheName>/<version>/ */
  cacheName: string;
  fileName: (platform: string) => string;
  /** https://github.com/<owner>/<repo>/releases/download */
  releaseBase: string;
  /** al-sem true (bare command keeps callers' not-found warnings); converter false (unavailable = no binary). */
  bareFallback: boolean;
  pin: ToolPin;
}

export interface ToolResolution {
  source: "env" | "path" | "cache" | "download" | "unavailable";
  path: string | null;
  version?: string;
  /** Why the pinned tool is not in use (unavailable, or a PATH copy that was skipped). */
  reason?: string;
}

export interface ToolResolverDeps {
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
  fetchFn: typeof fetch;
  /** `<binary> --version` -> "1.7.1", or undefined when it is not found or prints something else. */
  versionOf: (binary: string) => Promise<string | undefined>;
  log: (message: string) => void;
  now: () => number;
}

export interface ToolResolver {
  binary: () => Promise<string | null>;
  resolve: () => Promise<ToolResolution>;
}

const semver = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
/** Same major as the pin and not older than it. */
export function satisfiesPin(version: string, pinned: string): boolean {
  const [a, b] = [semver(version), semver(pinned)];
  if (a[0] !== b[0]) return false;
  for (let i = 1; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

export function defaultCacheDir(env: Record<string, string | undefined>, platform: string): string {
  const explicit = env[CACHE_DIR_ENV_VAR]?.trim();
  if (explicit) return explicit;
  const base = platform === "win32"
    ? env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local")
    : env["XDG_CACHE_HOME"] || join(homedir(), ".cache");
  return join(base, "bc-dev-mcp");
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Finds a pinned tool: its env var as-is; the bare command on PATH when it satisfies the pin; the
 * verified cached download; else downloads the pinned release asset and checks size + SHA-256 before
 * it is ever run. Never throws. One resolution per process; a failed download is retried after 10 minutes.
 */
export function createToolResolver(desc: ToolDescriptor, deps: ToolResolverDeps): ToolResolver {
  const pin = desc.pin;
  let memo: { at: number; result: Promise<ToolResolution> } | undefined;

  async function find(): Promise<ToolResolution> {
    const explicit = deps.env[desc.envVar]?.trim();
    if (explicit) return { source: "env", path: explicit };

    const onPath = await deps.versionOf(desc.pathCommand);
    if (onPath && satisfiesPin(onPath, pin.version)) return { source: "path", path: desc.pathCommand, version: onPath };
    const skipped = onPath ? `${desc.pathCommand} ${onPath} on PATH is older than the pinned ${pin.version} (or another major)` : undefined;
    const unavailable = (why: string): ToolResolution => ({
      source: "unavailable", path: desc.bareFallback ? desc.pathCommand : null, ...(onPath ? { version: onPath } : {}), reason: skipped ? `${why}; using ${skipped}` : why,
    });

    const key = `${deps.platform}-${deps.arch}`;
    const asset = pin.assets[key];
    if (!asset) return unavailable(`${desc.name} ${pin.version} has no release binary for ${key}; set ${desc.envVar}`);
    const dir = join(defaultCacheDir(deps.env, deps.platform), desc.cacheName, pin.version);
    const file = join(dir, desc.fileName(deps.platform));
    const cached = await readFile(file).catch(() => undefined);
    if (cached && sha256(cached) === asset.sha256) return { source: "cache", path: file, version: pin.version, ...(skipped ? { reason: skipped } : {}) };

    if (deps.env[desc.downloadEnvVar]?.trim() === "0") return unavailable(`download disabled (${desc.downloadEnvVar}=0)`);
    const url = `${desc.releaseBase}/v${pin.version}/${asset.name}`;
    const part = join(dir, `.${desc.cacheName}-${randomBytes(6).toString("hex")}.part`);
    try {
      deps.log(`downloading ${desc.name} ${pin.version} (${asset.name}, ${Math.round(asset.size / 1e6)} MB) to ${dir}`);
      const response = await deps.fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer()); // ponytail: ~27 MB in memory; stream if assets grow
      if (bytes.byteLength !== asset.size) throw new Error(`${asset.name} is ${bytes.byteLength} bytes, expected ${asset.size}`);
      const digest = sha256(bytes);
      if (digest !== asset.sha256) throw new Error(`${asset.name} SHA-256 ${digest} does not match the pinned ${asset.sha256}`);
      await mkdir(dir, { recursive: true });
      await writeFile(part, bytes);
      if (deps.platform !== "win32") await chmod(part, 0o755);
      await rename(part, file); // atomic; a racing process lands the same verified bytes
      deps.log(`${desc.name} ${pin.version} verified and cached at ${file}`);
      return { source: "download", path: file, version: pin.version, ...(skipped ? { reason: skipped } : {}) };
    } catch (error) {
      await rm(part, { force: true }).catch(() => {});
      return unavailable(`${desc.name} ${pin.version} download failed: ${error instanceof Error ? error.message : String(error)}; set ${desc.envVar} or retry later`);
    }
  }

  let last: ToolResolution | undefined;
  const resolve = () => {
    const stale = memo !== undefined && last?.source === "unavailable" && deps.now() - memo.at >= FAILURE_MEMO_MS;
    if (!memo || stale) memo = { at: deps.now(), result: find().then((r) => (last = r)) };
    return memo.result;
  };
  return { binary: async () => (await resolve()).path, resolve };
}

const execFileAsync = promisify(execFile);

/** Real `<binary> --version` probe; `pattern` captures the x.y.z. */
export async function probeVersion(binary: string, pattern: RegExp): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    return pattern.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}

export const CONVERTER_TOOL: ToolDescriptor = {
  name: "bc-mdc-converter",
  envVar: "BC_MDC_CONVERTER",
  downloadEnvVar: "BC_MDC_CONVERTER_DOWNLOAD",
  pathCommand: "bc-mdc-converter",
  cacheName: "bc-mdc-converter",
  fileName: (platform) => (platform === "win32" ? "bc-mdc-converter.exe" : "bc-mdc-converter"),
  releaseBase: "https://github.com/SShadowS/bc-mdc-converter/releases/download",
  bareFallback: false,
  pin: CONVERTER_PIN,
};
