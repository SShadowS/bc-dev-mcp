// Argument resolution for scripts/orchestrate.ts. No forwarding (unlike the ship/queue
// entry-args) — the orchestrator config file is the only source of job definitions; this
// module owns only the daemon's own four flags. Also owns the pure, testable dry-run
// schedule projection (buildDryRunRows/formatDryRunTable) so the entry script itself stays
// a thin shell with no logic of its own to test.
import { dirname, join } from "node:path";
import type { OrchestratorConfig } from "./config";
import { nextRun } from "./cron";

const DEFAULT_STATE_FILENAME = "orchestrator.state.json";
const DEFAULT_SHUTDOWN_GRACE_SECONDS = 30;
const DRY_RUN_FIRE_COUNT = 3;

export interface EntryConfig {
  readonly configPath: string;
  readonly statePath: string;
  readonly shutdownGraceMs: number;
  readonly dryRun: boolean;
}

export type EntryResolveResult = { kind: "config"; config: EntryConfig } | { kind: "help" } | { kind: "error"; errors: string[] };

export const ENTRY_USAGE = `usage: bun scripts/orchestrate.ts --config <path> [options]

One long-running process: schedules capture jobs (cron + jitter) from a
config file and supervises them as child processes. See docs/orchestrator-recipe.md.

  --config <path>             orchestrator.config.json path; required
  --state <path>              orchestrator.state.json path (default: beside --config)
  --shutdown-grace <seconds>  SIGINT/SIGTERM: wait this long for running jobs before
                              killing them (default 30)
  --dry-run                   print the parsed schedule (name, cron, next 3 fire
                              times) and exit 0 without scheduling anything
  -h, --help                  show this help

exit codes: 0 clean shutdown or --dry-run, 2 bad usage / fail-closed config error`;

const VALUE_FLAGS = new Set(["--config", "--state", "--shutdown-grace"]);

export function resolveEntryArgs(argv: string[]): EntryResolveResult {
  const errors: string[] = [];
  const flags = new Map<string, string>();
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") return { kind: "help" };
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) {
        errors.push(`${a} needs a value`);
        continue;
      }
      flags.set(a, v);
      i++;
      continue;
    }
    errors.push(`unknown argument: ${a}`);
  }

  const configPath = flags.get("--config");
  if (configPath === undefined) {
    errors.push("--config <path> is required — the orchestrator.config.json path");
  }

  let shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_SECONDS * 1000;
  const graceRaw = flags.get("--shutdown-grace");
  if (graceRaw !== undefined) {
    const n = Number(graceRaw);
    if (!Number.isInteger(n) || n < 0) {
      errors.push(`--shutdown-grace must be a non-negative integer (seconds), got ${graceRaw}`);
    } else {
      shutdownGraceMs = n * 1000;
    }
  }

  if (errors.length > 0 || configPath === undefined) return { kind: "error", errors };

  const statePath = flags.get("--state") ?? join(dirname(configPath), DEFAULT_STATE_FILENAME);

  return {
    kind: "config",
    config: { configPath, statePath, shutdownGraceMs, dryRun },
  };
}

// ---- dry-run schedule projection (pure; no I/O, no real clock) ----

export interface DryRunJobRow {
  readonly name: string;
  readonly schedule: string;
  readonly nextRuns: readonly Date[]; // up to DRY_RUN_FIRE_COUNT, in order; empty if `error` is set
  readonly error?: string;
}

/** Projects each job's next DRY_RUN_FIRE_COUNT fire times via cron.nextRun — no jitter (jitter is random; dry-run must be deterministic). */
export function buildDryRunRows(cfg: OrchestratorConfig, now: Date): DryRunJobRow[] {
  return cfg.jobs.map((job): DryRunJobRow => {
    const nextRuns: Date[] = [];
    let cursor = now;
    try {
      for (let i = 0; i < DRY_RUN_FIRE_COUNT; i++) {
        const next = nextRun(job.schedule, cursor);
        nextRuns.push(next);
        cursor = next;
      }
      return { name: job.name, schedule: job.schedule, nextRuns };
    } catch (err) {
      return { name: job.name, schedule: job.schedule, nextRuns: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function formatLocal(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Renders buildDryRunRows() output as an operator-readable table (local time, matching cron's own local-time semantics). */
export function formatDryRunTable(rows: DryRunJobRow[]): string {
  if (rows.length === 0) return "no jobs configured in this file";

  const header = ["name", "cron", "next 3 fire times (local)"];
  const cells = rows.map((r) => [r.name, r.schedule, r.error ? `ERROR: ${r.error}` : r.nextRuns.map(formatLocal).join("  |  ")]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const formatRow = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");

  return [formatRow(header), formatRow(widths.map((w) => "-".repeat(w))), ...cells.map(formatRow)].join("\n");
}
