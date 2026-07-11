#!/usr/bin/env bun
// work-capture-queue: polls al-perf's capture-request queue, claims one pending
// request, runs the existing capture-and-ship cycle against it, and lets al-perf's
// automatic fulfillment close the loop. Thin I/O shell; all logic lives in
// src/core/queue/ and src/core/ship/ (typechecked + unit-tested).
// Recipe doc: docs/capture-queue-worker.md
// Executor contract this implements: al-perf's docs/capture-request-contract.md
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolveEntryArgs, ENTRY_USAGE } from "../src/core/queue/entry-args";
import { resolveShipConfig, SHIP_USAGE, type ShipConfig } from "../src/core/ship/args";
import { createQueueClient, type CaptureRequestRow, type CliRunner } from "../src/core/queue/queue-client";
import { workQueue, type WorkerDeps } from "../src/core/queue/worker";
import { runCaptureShipCycle, type CycleOutcome } from "../src/core/ship/capture-cycle";
import { spawnRunner } from "../src/core/snapshot/converter";

const entryRes = resolveEntryArgs(process.argv.slice(2), process.env);
if (entryRes.kind === "help") {
  console.log(ENTRY_USAGE);
  console.log();
  console.log(SHIP_USAGE);
  process.exit(0);
}
if (entryRes.kind === "error") {
  for (const e of entryRes.errors) console.error(`error: ${e}`);
  console.error(`\n${ENTRY_USAGE}`);
  process.exit(2);
}
const entry = entryRes.config;

const shipRes = resolveShipConfig(entry.rest, process.env);
if (shipRes.kind === "help") {
  console.log(SHIP_USAGE);
  process.exit(0);
}
if (shipRes.kind === "error") {
  for (const e of shipRes.errors) console.error(`error: ${e}`);
  console.error(`\n${SHIP_USAGE}`);
  process.exit(2);
}
const baseShipConfig = shipRes.config;

// Runs the al-perf CLI (queue-client's CliRunner). `args` already has the cli
// prefix at the front (queue-client prepends cfg.cliPrefix), so the whole array
// is one flat command line.
const runCli: CliRunner = (args) =>
  new Promise((resolve) => {
    const child = spawn(args[0]!, args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

const client = createQueueClient({ cliPrefix: entry.cliPrefix, dbPath: entry.queueDbPath }, runCli);

// D4: the optional workload hook, spawned once the worker sees the "armed" log
// line. Whitespace-split, same convention (and limitation) as --al-perf-cli.
const spawnWorkload: WorkerDeps["spawnWorkload"] = (cmd, env) => {
  const parts = cmd.trim().split(/\s+/);
  const child = spawn(parts[0]!, parts.slice(1), { stdio: "ignore", env: { ...process.env, ...env } });
  const done = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null)); // spawn failure counts as "exited"; never fails the worker
  });
  return {
    kill: () => {
      try {
        child.kill();
      } catch {
        // best-effort — the child may have already exited
      }
    },
    done,
  };
};

async function runCycle(row: CaptureRequestRow, onLog: (line: string) => void): Promise<CycleOutcome> {
  let cfg: ShipConfig = baseShipConfig;

  // Same-tenant rule (capture-request-contract.md §2.4): the ship destination
  // MUST be the requesting tenant, not whatever --al-perf-tenant was forwarded
  // with (if anything) — override per request, logging only when it actually
  // changes something a user configured.
  if (cfg.alPerfTenant !== row.tenant) {
    if (cfg.alPerfTenant) {
      onLog(`request #${row.id}: overriding --al-perf-tenant "${cfg.alPerfTenant}" with the request's own tenant "${row.tenant}" (same-tenant rule)`);
    }
    cfg = { ...cfg, alPerfTenant: row.tenant };
  }

  const description = `capture-request #${row.id}: ${row.reason}`;
  onLog(`request #${row.id}: description set to ${JSON.stringify(description)}`);
  cfg = { ...cfg, description };

  return runCaptureShipCycle(cfg, shipRes.connection, {
    fetchFn: fetch,
    runConverter: spawnRunner,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: onLog,
    uuid: randomUUID,
  });
}

const report = await workQueue(
  {
    executor: entry.executor,
    max: entry.max,
    tenant: entry.queueTenant,
    keepClaimOnFailure: entry.keepClaimOnFailure,
    workloadCmd: entry.workloadCmd,
  },
  {
    client,
    runCycle,
    spawnWorkload,
    log: (msg) => console.error(`[work-capture-queue] ${msg}`),
  },
);

console.error(
  `[work-capture-queue] polled ${report.polled}, worked ${report.worked.length}, failures ${report.failures}, claimErrors ${report.claimErrors}`,
);
for (const w of report.worked) {
  console.error(`[work-capture-queue]   #${w.id}: ${w.outcome}${w.released ? " (released)" : ""}`);
}

// D5 exit codes, plus the claim-error carry-over: claimErrors alone (a busy pool
// racing claims, or a request that vanished) is normal and doesn't fail the run;
// claimErrors WITHOUT any request reaching an actual cycle outcome means the al-perf
// CLI itself is broken (bad --al-perf-cli, unreachable queue db, ...) — a distinct,
// louder signal for cron/monitoring than "just busy."
const ranACycle = report.worked.some((w) => w.outcome !== "claim-raced" && w.outcome !== "claim-error");
if (report.claimErrors > 0 && !ranACycle) {
  console.error(
    `[work-capture-queue] FAILED: ${report.claimErrors} claim error(s) and no request reached a cycle outcome — the al-perf CLI itself appears broken (check --al-perf-cli / AL_PERF_CLI and --queue-db)`,
  );
  process.exit(1);
}
if (report.claimErrors > 0) {
  console.error(`[work-capture-queue] WARNING: ${report.claimErrors} claim error(s) occurred alongside other work that succeeded — investigate the al-perf CLI / queue db`);
}
if (report.failures > 0) {
  console.error(`[work-capture-queue] FAILED: ${report.failures} cycle failure(s)`);
  process.exit(1);
}
process.exit(0);
