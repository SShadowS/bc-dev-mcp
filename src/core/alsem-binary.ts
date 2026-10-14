import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ALSEM_PIN, type AlSemPin } from "./alsem-pin";

/** The alsem executable to run: a path, or bare "alsem" (PATH lookup; a missing binary then fails as ENOENT). */
export type AlSemBinary = () => Promise<string>;

/** Today's behaviour and the default of every al-sem factory: BC_DEV_ALSEM, else `alsem` on PATH. */
export const envAlSemBinary = (env: Record<string, string | undefined>): AlSemBinary => async () => env[ALSEM_ENV_VAR]?.trim() || "alsem";

export const ALSEM_ENV_VAR = "BC_DEV_ALSEM";
export const ALSEM_DOWNLOAD_ENV_VAR = "BC_DEV_ALSEM_DOWNLOAD";
export const CACHE_DIR_ENV_VAR = "BC_DEV_CACHE_DIR";
const RELEASES = "https://github.com/SShadowS/al-sem/releases/download";
const FAILURE_MEMO_MS = 10 * 60_000;

export interface AlSemResolution {
  source: "env" | "path" | "cache" | "download" | "unavailable";
  path: string;
  version?: string;
  /** Why the pinned al-sem is not in use (unavailable, or a PATH copy that was skipped). */
  reason?: string;
}

export interface AlSemResolverDeps {
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
  fetchFn: typeof fetch;
  /** `<binary> --version` -> "1.7.1", or undefined when it is not found or prints something else. */
  versionOf: (binary: string) => Promise<string | undefined>;
  log: (message: string) => void;
  now: () => number;
  pin?: AlSemPin;
}

export interface AlSemResolver {
  binary: AlSemBinary;
  resolve: () => Promise<AlSemResolution>;
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
 * Finds al-sem: BC_DEV_ALSEM as-is; `alsem` on PATH when it satisfies the pin; the verified cached
 * download; else downloads the pinned release asset and checks its SHA-256 before it is ever run.
 * Never throws: when nothing works it answers bare "alsem", so callers keep their not-found warnings.
 * One resolution per process; a failed download is retried after 10 minutes.
 */
export function createAlSemResolver(deps: AlSemResolverDeps): AlSemResolver {
  const pin = deps.pin ?? ALSEM_PIN;
  let memo: { at: number; result: Promise<AlSemResolution> } | undefined;

  async function find(): Promise<AlSemResolution> {
    const explicit = deps.env[ALSEM_ENV_VAR]?.trim();
    if (explicit) return { source: "env", path: explicit };

    const onPath = await deps.versionOf("alsem");
    if (onPath && satisfiesPin(onPath, pin.version)) return { source: "path", path: "alsem", version: onPath };
    const skipped = onPath ? `alsem ${onPath} on PATH is older than the pinned ${pin.version} (or another major)` : undefined;
    const unavailable = (why: string): AlSemResolution => ({
      source: "unavailable", path: "alsem", ...(onPath ? { version: onPath } : {}), reason: skipped ? `${why}; using ${skipped}` : why,
    });

    const key = `${deps.platform}-${deps.arch}`;
    const asset = pin.assets[key];
    if (!asset) return unavailable(`al-sem ${pin.version} has no release binary for ${key}; set ${ALSEM_ENV_VAR}`);
    const dir = join(defaultCacheDir(deps.env, deps.platform), "alsem", pin.version);
    const file = join(dir, deps.platform === "win32" ? "alsem.exe" : "alsem");
    const cached = await readFile(file).catch(() => undefined);
    if (cached && sha256(cached) === asset.sha256) return { source: "cache", path: file, version: pin.version, ...(skipped ? { reason: skipped } : {}) };

    if (deps.env[ALSEM_DOWNLOAD_ENV_VAR]?.trim() === "0") return unavailable(`download disabled (${ALSEM_DOWNLOAD_ENV_VAR}=0)`);
    const url = `${RELEASES}/v${pin.version}/${asset.name}`;
    const part = join(dir, `.alsem-${randomBytes(6).toString("hex")}.part`);
    try {
      deps.log(`downloading al-sem ${pin.version} (${asset.name}, ${Math.round(asset.size / 1e6)} MB) to ${dir}`);
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
      deps.log(`al-sem ${pin.version} verified and cached at ${file}`);
      return { source: "download", path: file, version: pin.version, ...(skipped ? { reason: skipped } : {}) };
    } catch (error) {
      await rm(part, { force: true }).catch(() => {});
      return unavailable(`al-sem ${pin.version} download failed: ${error instanceof Error ? error.message : String(error)}; set ${ALSEM_ENV_VAR} or retry later`);
    }
  }

  let last: AlSemResolution | undefined;
  const resolve = () => {
    const stale = memo !== undefined && last?.source === "unavailable" && deps.now() - memo.at >= FAILURE_MEMO_MS;
    if (!memo || stale) memo = { at: deps.now(), result: find().then((r) => (last = r)) };
    return memo.result;
  };
  return { binary: async () => (await resolve()).path, resolve };
}

const execFileAsync = promisify(execFile);

/** Real `alsem --version` probe ("al-sem 1.7.1"). */
export async function alsemVersionOf(binary: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    return /al-sem (\d+\.\d+\.\d+)/.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}
