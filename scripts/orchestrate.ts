#!/usr/bin/env bun
// orchestrate: the long-running capture-job daemon. Thin I/O shell; all logic lives in
// src/core/orchestrate/ (cron parser, config loader, scheduler core — all typechecked +
// unit-tested). This file wires the scheduler's injected SchedulerDeps to real Bun.spawn
// child processes, real timers, and an atomically-written state file, per D5/D6/D7 of the
// orchestrator-daemon plan. Recipe doc: docs/orchestrator-recipe.md
//
// SECRETS: job.env holds BC credentials / tokens (see config.ts's own SECURITY note). This
// file must NEVER log a job's env VALUES — only names/counts of keys, if anything at all.
// Every log() call below names only job.name/command/args; grep this file for `.env` before
// adding a new one.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadOrchestratorConfig, type JobConfig } from "../src/core/orchestrate/config";
import { createScheduler, type OrchestratorState, type SchedulerDeps, type SpawnResult } from "../src/core/orchestrate/scheduler";
import { buildDryRunRows, ENTRY_USAGE, formatDryRunTable, resolveEntryArgs } from "../src/core/orchestrate/entry-args";

// Grace between SIGTERM and SIGKILL for a job that outran its own timeoutMinutes — distinct
// from --shutdown-grace (which bounds the whole daemon's shutdown, not one job's kill).
const TIMEOUT_KILL_GRACE_MS = 5_000;

function log(line: string): void {
  console.error(`[${new Date().toISOString()}] [orchestrate] ${line}`);
}

const entryRes = resolveEntryArgs(process.argv.slice(2));
if (entryRes.kind === "help") {
  console.log(ENTRY_USAGE);
  process.exit(0);
}
if (entryRes.kind === "error") {
  for (const e of entryRes.errors) console.error(`error: ${e}`);
  console.error(`\n${ENTRY_USAGE}`);
  process.exit(2);
}
const entry = entryRes.config;

let cfg: ReturnType<typeof loadOrchestratorConfig>;
try {
  cfg = loadOrchestratorConfig(entry.configPath);
} catch (err) {
  // Fail-closed (plan's Global Constraints): a malformed config refuses to start, exit 2,
  // naming the offending job+field — the message already comes from config.ts naming both.
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

if (entry.dryRun) {
  console.log(formatDryRunTable(buildDryRunRows(cfg, new Date())));
  process.exit(0);
}

// ---- real SchedulerDeps ----

let nextTimerId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function setTimer(ms: number, fn: () => void): number {
  const id = nextTimerId++;
  const handle = setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.set(id, handle);
  return id;
}

function clearTimer(id: number): void {
  const handle = timers.get(id);
  if (handle !== undefined) {
    clearTimeout(handle);
    timers.delete(id);
  }
}

function spawnJob(job: JobConfig): { done: Promise<SpawnResult>; kill(): void } {
  const proc = Bun.spawn({
    cmd: [job.command, ...job.args],
    env: { ...process.env, ...job.env },
    stdin: "ignore",
    // v1: child stdout/stderr inherited to the daemon's own stdout/stderr — systemd/schtasks
    // capture the daemon's stdio, so this is enough to see job output without a per-job
    // logfile (a documented follow-up, per the plan).
    stdout: "inherit",
    stderr: "inherit",
  });

  let timedOut = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let killGraceTimer: ReturnType<typeof setTimeout> | undefined;

  // timeoutMinutes === 0 is an explicit opt-out (no enforcement) — the config loader only
  // guarantees >= 0, and the plan's default (60) covers the common case; a bare 0 has no
  // other sane reading (an instantly-killed job would never be useful).
  if (job.timeoutMinutes > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      log(`job "${job.name}" exceeded its ${job.timeoutMinutes}m timeout — sending SIGTERM`);
      proc.kill("SIGTERM");
      killGraceTimer = setTimeout(() => {
        if (!proc.killed) {
          log(`job "${job.name}" did not exit within ${TIMEOUT_KILL_GRACE_MS}ms of SIGTERM — sending SIGKILL`);
          proc.kill("SIGKILL");
        }
      }, TIMEOUT_KILL_GRACE_MS);
    }, job.timeoutMinutes * 60_000);
  }

  const done = proc.exited.then((code): SpawnResult => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (killGraceTimer !== undefined) clearTimeout(killGraceTimer);
    return { code, timedOut };
  });

  return {
    done,
    kill: () => proc.kill("SIGTERM"),
  };
}

function readState(): OrchestratorState | null {
  let text: string;
  try {
    text = readFileSync(entry.statePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log(`could not read state file "${entry.statePath}": ${err instanceof Error ? err.message : String(err)} — starting with no prior state`);
    }
    return null;
  }
  try {
    return JSON.parse(text) as OrchestratorState;
  } catch (err) {
    log(`state file "${entry.statePath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)} — starting with no prior state`);
    return null;
  }
}

function writeState(state: OrchestratorState): void {
  // Atomic write: write to a sibling tmp file, then rename over the real path — a reader
  // (or a crash mid-write) never observes a partially-written state file.
  const tmpPath = `${entry.statePath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, entry.statePath);
  } catch (err) {
    // A transient state-write failure must not crash the whole daemon (global constraint:
    // "the daemon must never wedge") — log loudly and keep scheduling; the next successful
    // write catches state back up.
    log(`FAILED to write state file "${entry.statePath}": ${err instanceof Error ? err.message : String(err)}`);
    // If writeFileSync succeeded but renameSync then threw (e.g. the target is momentarily
    // locked by an antivirus scan on Windows), the tmp file would otherwise be orphaned —
    // clean it up. Best-effort: if writeFileSync itself failed, tmpPath never existed and
    // this is a harmless no-op; if unlink also fails there's nothing more useful to do.
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore — see comment above
    }
  }
}

// Ensure the state directory exists before the scheduler's first write (defaults beside
// --config, which already exists; only matters for a custom --state in a fresh directory).
mkdirSync(dirname(entry.statePath), { recursive: true });

const deps: SchedulerDeps = {
  now: Date.now,
  setTimer,
  clearTimer,
  spawnJob,
  readState,
  writeState,
  log,
  random: Math.random,
};

// Verified (docs/orchestrator-recipe.md's Shutdown semantics): on Windows, an external
// SIGINT/SIGTERM sent to this process (schtasks "End Task," taskkill, NSSM's default stop
// method) does NOT invoke our signal handler below — the process is unconditionally
// terminated. --shutdown-grace only actually applies on Linux/systemd or an interactive
// Ctrl+C in a console this process shares. Warn once, at startup, only when an operator
// explicitly set this flag (not on the silent default) — they relied on a promise this
// platform doesn't keep under a service-manager stop.
if (process.platform === "win32" && entry.shutdownGraceExplicit) {
  log(
    `WARNING: --shutdown-grace was set explicitly, but Windows does not reliably deliver an external stop signal to this process — the grace only applies to an interactive Ctrl+C sharing this console, not a service-manager stop (schtasks/NSSM default). See docs/orchestrator-recipe.md's Shutdown semantics section.`,
  );
}

const scheduler = createScheduler(cfg, deps);
log(`starting — ${cfg.jobs.length} job(s) from "${entry.configPath}", state at "${entry.statePath}"`);
scheduler.start();

let shuttingDown = false;
function handleShutdownSignal(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal} — stopping (up to ${entry.shutdownGraceMs}ms grace for running jobs)`);
  scheduler
    .stop(entry.shutdownGraceMs)
    .then(() => {
      log("shutdown complete");
      process.exit(0);
    })
    .catch((err) => {
      log(`shutdown did not complete cleanly: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(0);
    });
}

process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
