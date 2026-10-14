/**
 * Runs `bc-mdc-converter <zip> <tmp.json> --format snapshot-json` and reads the result. The I/O seam
 * for snapshot decoding: bounded time, stderr and output size; the temp JSON is always deleted.
 * SECURITY: converter stderr can echo archive content, so only its first line (<= 300 chars) leaves here.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT_LIMITS } from "./limits";

export type SnapshotJsonRunner = (binary: string, zipPath: string) => Promise<{ ok: true; json: unknown } | { ok: false; error: string }>;

/** `argsPrefix` exists only so tests can run a script through the current runtime. */
export function runSnapshotJsonWith(opts: { timeoutMs: number; jsonBytes: number; stderrBytes: number; argsPrefix?: string[] }): SnapshotJsonRunner {
  return async (binary, zipPath) => {
    const out = join(tmpdir(), `bc-dev-mcp-snapshot-${randomUUID()}.json`);
    try {
      const res = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve) => {
        const child = spawn(binary, [...(opts.argsPrefix ?? []), zipPath, out, "--format", "snapshot-json"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: process.env });
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs);
        child.stderr?.on("data", (d) => { if (stderr.length < opts.stderrBytes) stderr = (stderr + String(d)).slice(0, opts.stderrBytes); });
        child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stderr: String(e.message), timedOut }); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr, timedOut }); });
      });
      if (res.timedOut) return { ok: false, error: `bc-mdc-converter did not finish within ${opts.timeoutMs / 1000} s` };
      if (res.code !== 0) return { ok: false, error: `bc-mdc-converter failed (exit ${res.code}): ${firstLine(res.stderr)}` };
      const size = (await stat(out)).size;
      if (size > opts.jsonBytes) return { ok: false, error: `bc-mdc-converter output is ${size} bytes, over the ${opts.jsonBytes}-byte limit` };
      return { ok: true, json: JSON.parse(await readFile(out, "utf8")) };
    } catch (e) {
      return { ok: false, error: `bc-mdc-converter output unreadable: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` };
    } finally {
      await rm(out, { force: true });
    }
  };
}

const firstLine = (s: string) => (s.trim().split(/\r?\n/)[0] ?? "").slice(0, 300);

export const runSnapshotJson = runSnapshotJsonWith({ timeoutMs: SNAPSHOT_LIMITS.converterMs, jsonBytes: SNAPSHOT_LIMITS.jsonBytes, stderrBytes: SNAPSHOT_LIMITS.stderrBytes });
