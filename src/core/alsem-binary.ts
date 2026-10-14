import { ALSEM_PIN, type AlSemPin } from "./alsem-pin";
import { createToolResolver, probeVersion, type ToolDescriptor } from "./tool-binary";

export { satisfiesPin, defaultCacheDir } from "./tool-binary";

/** The alsem executable to run: a path, or bare "alsem" (PATH lookup; a missing binary then fails as ENOENT). */
export type AlSemBinary = () => Promise<string>;

/** Today's behaviour and the default of every al-sem factory: BC_DEV_ALSEM, else `alsem` on PATH. */
export const envAlSemBinary = (env: Record<string, string | undefined>): AlSemBinary => async () => env[ALSEM_ENV_VAR]?.trim() || "alsem";

export const ALSEM_ENV_VAR = "BC_DEV_ALSEM";
export const ALSEM_DOWNLOAD_ENV_VAR = "BC_DEV_ALSEM_DOWNLOAD";
export const CACHE_DIR_ENV_VAR = "BC_DEV_CACHE_DIR";

const ALSEM_TOOL = (pin: AlSemPin): ToolDescriptor => ({
  name: "al-sem",
  envVar: ALSEM_ENV_VAR,
  downloadEnvVar: ALSEM_DOWNLOAD_ENV_VAR,
  pathCommand: "alsem",
  cacheName: "alsem",
  fileName: (platform) => (platform === "win32" ? "alsem.exe" : "alsem"),
  releaseBase: "https://github.com/SShadowS/al-sem/releases/download",
  bareFallback: true,
  pin,
});

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

/**
 * Finds al-sem: BC_DEV_ALSEM as-is; `alsem` on PATH when it satisfies the pin; the verified cached
 * download; else downloads the pinned release asset and checks its SHA-256 before it is ever run.
 * Never throws: when nothing works it answers bare "alsem", so callers keep their not-found warnings.
 */
export function createAlSemResolver(deps: AlSemResolverDeps): AlSemResolver {
  const tool = createToolResolver(ALSEM_TOOL(deps.pin ?? ALSEM_PIN), deps);
  // bareFallback guarantees a non-null path.
  const resolve = () => tool.resolve() as Promise<AlSemResolution>;
  return { binary: async () => (await resolve()).path, resolve };
}

/** Real `alsem --version` probe ("al-sem 1.7.1"). */
export const alsemVersionOf = (binary: string) => probeVersion(binary, /al-sem (\d+\.\d+\.\d+)/);
