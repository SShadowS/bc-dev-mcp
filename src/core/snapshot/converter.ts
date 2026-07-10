import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface ConverterEnv {
  converterPath: string;
}

export type SpawnRunner = (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;

// Discover the bc-mdc-converter binary (github.com/SShadowS/bc-mdc-converter — standalone
// Rust, no .NET). BC_MDC_CONVERTER wins (same convention as scripts/capture-and-ship.ts);
// otherwise scan PATH for bc-mdc-converter(.exe).
export function resolveConverter(opts: {
  env: Record<string, string | undefined>;
  existsFn?: (p: string) => boolean;
  platform?: NodeJS.Platform;
}): ConverterEnv | null {
  const existsFn = opts.existsFn ?? existsSync;
  const platform = opts.platform ?? process.platform;
  const override = opts.env["BC_MDC_CONVERTER"];
  if (override) return existsFn(override) ? { converterPath: override } : null;
  const exe = platform === "win32" ? "bc-mdc-converter.exe" : "bc-mdc-converter";
  const pathDelimiter = platform === "win32" ? ";" : ":";
  for (const dir of (opts.env["PATH"] ?? "").split(pathDelimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (existsFn(candidate)) return { converterPath: candidate };
  }
  return null;
}

export const spawnRunner: SpawnRunner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ code: -1, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });

// bc-mdc-converter <in.mdc.zip> <out> --format v8 — exit 0 means <out> was written
// (.alcpuprofile, byte-identical to the official AL tooling's output).
export async function convertMdcZip(
  env: ConverterEnv,
  mdcZipPath: string,
  outPath: string,
  run: SpawnRunner = spawnRunner,
): Promise<{ ok: true; profilePath: string } | { ok: false; error: string }> {
  const res = await run(env.converterPath, [mdcZipPath, outPath, "--format", "v8"]);
  if (res.code === 0) return { ok: true, profilePath: outPath };
  return { ok: false, error: res.stderr.trim() || `converter exited ${res.code}` };
}
