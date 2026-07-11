// Worker core for al-perf's capture-queue: selects pending requests, claims one at a
// time, runs the capture-ship cycle against it, and releases the claim per D3's policy
// (shipped/duplicate stay claimed — fulfillment is automatic server-side; no-capture/error
// get cancelled so the identity frees for the next scan). All effects are injected so this
// is unit-testable without al-perf, a BC server, or a real child process.
import type { CaptureRequestRow, createQueueClient } from "./queue-client";
import type { CycleOutcome } from "../ship/capture-cycle";

export interface WorkerConfig {
  executor: string;
  max: number; // requests to attempt this invocation
  tenant?: string;
  keepClaimOnFailure: boolean;
  workloadCmd?: string;
}

export interface WorkerDeps {
  client: ReturnType<typeof createQueueClient>;
  runCycle(request: CaptureRequestRow, onLog: (line: string) => void): Promise<CycleOutcome>;
  spawnWorkload(cmd: string, env: Record<string, string>): { kill(): void; done: Promise<number | null> };
  log(msg: string): void;
}

export interface WorkedRequest {
  id: number;
  outcome: CycleOutcome["kind"] | "claim-raced";
  released: boolean; // cancelled after failure
}

export interface WorkerReport {
  polled: number;
  worked: WorkedRequest[];
  failures: number; // outcomes of kind "error"
}

const ARMED_LINE = /armed .* capture/;

function workloadEnv(row: CaptureRequestRow): Record<string, string> {
  return {
    BCQ_REQUEST_ID: String(row.id),
    BCQ_TENANT: row.tenant,
    BCQ_APP_ID: row.appId,
    BCQ_APP_NAME: row.appName ?? "",
    BCQ_OBJECT_TYPE: row.objectType,
    BCQ_OBJECT_ID: String(row.objectId),
    BCQ_METHOD_NAME: row.methodName,
    BCQ_REASON: row.reason,
  };
}

export async function workQueue(cfg: WorkerConfig, deps: WorkerDeps): Promise<WorkerReport> {
  const rows = await deps.client.listPending(cfg.tenant);
  const worked: WorkedRequest[] = [];
  let failures = 0;
  let attempted = 0;

  for (const row of rows) {
    if (attempted >= cfg.max) break;

    const claimResult = await deps.client.claim(row.id, cfg.executor);
    if (!claimResult.ok) {
      // Only "raced"/"gone" are documented here; a bare CLI "error" is treated the same
      // way — we don't hold the claim either way, so there's nothing to run or release.
      deps.log(`claim for request #${row.id} did not succeed (${claimResult.reason}): ${claimResult.message}`);
      worked.push({ id: row.id, outcome: "claim-raced", released: false });
      continue; // does not consume the max budget
    }
    attempted++;

    let spawned: { kill(): void; done: Promise<number | null> } | undefined;
    // Mapped to a boolean at spawn time, not at the post-cycle check: racing an
    // already-settled promise needs one microtask hop same as a fresh marker, so both
    // stay on equal footing at check time — mapping lazily would add an extra hop only
    // on this side and make an already-exited child look "still running".
    let exited: Promise<boolean> | undefined;
    let workloadFired = false;
    const onLog = (line: string) => {
      deps.log(line);
      if (cfg.workloadCmd && !workloadFired && ARMED_LINE.test(line)) {
        workloadFired = true;
        spawned = deps.spawnWorkload(cfg.workloadCmd, workloadEnv(row));
        exited = spawned.done.then(
          () => true,
          () => true, // a rejected `done` counts as exited too — the child's exit never affects the report
        );
      }
    };

    let kind: CycleOutcome["kind"];
    try {
      kind = (await deps.runCycle(row, onLog)).kind;
    } catch (err) {
      deps.log(`cycle threw for request #${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      kind = "error";
    }

    if (spawned && exited) {
      const alreadyExited = await Promise.race([exited, Promise.resolve(false)]);
      if (!alreadyExited) spawned.kill();
    }

    if (kind === "error") failures++;

    let released: boolean;
    if (kind === "shipped" || kind === "duplicate") {
      released = false;
    } else if (cfg.keepClaimOnFailure) {
      deps.log(`keeping claim on request #${row.id} despite a "${kind}" outcome (keepClaimOnFailure)`);
      released = false;
    } else {
      const cancelResult = await deps.client.cancel(row.id);
      if (!cancelResult.ok) {
        deps.log(`cancel failed for request #${row.id}: ${cancelResult.message}`);
      }
      released = cancelResult.ok;
    }

    worked.push({ id: row.id, outcome: kind, released });
  }

  return { polled: rows.length, worked, failures };
}
