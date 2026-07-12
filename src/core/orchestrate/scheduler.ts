// Scheduler core (D2/D3/D4/D5/D7 of the orchestrator-daemon plan). A single dependency-free
// state machine: one armed timer at a time, always aimed at the earliest pending wake across
// every job (either that job's next cron-computed occurrence, or a pending retry). Every
// effect (clock, timers, spawn, state I/O, logging, jitter randomness) is injected via
// SchedulerDeps so this module has zero real I/O and is fully driven by a fake clock in tests.
//
// Drift avoidance: a job's next regular occurrence is always computed from the DUE time it
// just fired at (cron.nextRun(schedule, dueDate)), never from when the run/retry chain
// happened to finish — a slow job does not shift its own schedule. The next occurrence is
// armed immediately when a due tick is observed (before spawning), so a still-running job
// is correctly detected as "due again" for D3 overlap-skip purposes.
//
// Retry chains "occupy the job" (D4): `running` stays true for the whole chain, including the
// gaps between attempts, so an overlapping regular due tick during a retry backoff is skipped
// like any other overlap, never queued.
import type { JobConfig, OrchestratorConfig } from "./config";
import { nextRun } from "./cron";

export type JobOutcome = "ok" | "failed" | "timeout" | "skipped-overlap";

export interface JobState {
  lastStartAt: number | null;
  lastFinishAt: number | null;
  lastExitCode: number | null;
  lastOutcome: JobOutcome | null;
  consecutiveFailures: number;
  skippedOverlaps: number;
}

export interface OrchestratorState {
  jobs: Record<string, JobState>;
}

export interface SpawnResult {
  code: number | null;
  timedOut: boolean;
}

export interface SchedulerDeps {
  now(): number;
  setTimer(ms: number, fn: () => void): number;
  clearTimer(id: number): void;
  spawnJob(job: JobConfig): { done: Promise<SpawnResult>; kill(): void };
  readState(): OrchestratorState | null;
  writeState(s: OrchestratorState): void;
  log(line: string): void;
  random(): number; // [0, 1) — jitter; injected for determinism
}

export interface Scheduler {
  start(): void;
  stop(graceMs?: number): Promise<void>;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;
// Node/Bun's setTimeout (like the browser spec it follows) silently clamps any delay above a
// signed 32-bit int of milliseconds to ~1ms — and on Bun 1.3.14/win32 also emits a
// TimeoutOverflowWarning per call. A sparse schedule (monthly, quarterly, yearly, a Feb 29
// job) routinely computes a true due-delay past this: an unclamped arm would fire almost
// immediately, tick() would find nothing due, and rearmGlobalTimer() would re-arm the SAME
// oversized delay — spinning at ~1000 ticks/sec (and flooding the log) for however many days
// remain until the true gap shrinks under the limit. Clamping the delay actually PASSED to
// setTimer (armedForTime below still tracks the true, unclamped due time) turns that spin into
// a small, bounded number of full-length re-arms: tick() finding nothing due just calls
// rearmGlobalTimer() again, which reclamps the now-smaller remaining delay. The job still
// fires at its true due time either way — this only bounds how the wait gets there.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1; // ~24.86 days

interface JobRuntime {
  readonly job: JobConfig;
  // Both fields can be live simultaneously: nextScheduledAt keeps advancing on its regular
  // cadence even while a retry chain occupies the job (pendingRetryAt set), so an overlapping
  // regular due tick during a retry backoff is still detected as D3 overlap-skip instead of
  // silently stalling the schedule for the chain. See tick()/rearmGlobalTimer() below.
  nextScheduledAt: number;
  pendingRetryAt: number | null;
  running: boolean;
  attemptsUsed: number;
  currentDone: Promise<SpawnResult> | undefined;
  currentKill: (() => void) | undefined;
  state: JobState;
}

function freshJobState(): JobState {
  return {
    lastStartAt: null,
    lastFinishAt: null,
    lastExitCode: null,
    lastOutcome: null,
    consecutiveFailures: 0,
    skippedOverlaps: 0,
  };
}

export function createScheduler(cfg: OrchestratorConfig, deps: SchedulerDeps): Scheduler {
  const jobs = new Map<string, JobRuntime>();
  let armedTimerId: number | null = null;
  let armedForTime: number | null = null;
  let stopped = false;

  function computeNextDue(job: JobConfig, fromDate: Date): number {
    const base = nextRun(job.schedule, fromDate);
    return base.getTime() + deps.random() * job.jitterMinutes * 60_000;
  }

  function persistState(): void {
    const snapshot: OrchestratorState = { jobs: {} };
    for (const rt of jobs.values()) {
      snapshot.jobs[rt.job.name] = { ...rt.state };
    }
    deps.writeState(snapshot);
  }

  function rearmGlobalTimer(): void {
    if (stopped) return;
    let min: number | null = null;
    for (const rt of jobs.values()) {
      // A pending retry does NOT suspend the job's regular cadence — nextScheduledAt keeps
      // advancing and must stay armed so an overlap during the retry backoff is still
      // detected (D3), not silently missed because "something else" is due for this job.
      const candidates = rt.pendingRetryAt !== null ? [rt.pendingRetryAt, rt.nextScheduledAt] : [rt.nextScheduledAt];
      for (const candidate of candidates) {
        if (min === null || candidate < min) min = candidate;
      }
    }
    if (min === null) return; // no jobs configured
    if (min === armedForTime && armedTimerId !== null) return; // already armed correctly
    if (armedTimerId !== null) {
      deps.clearTimer(armedTimerId);
      armedTimerId = null;
    }
    const delay = Math.min(Math.max(0, min - deps.now()), MAX_TIMER_DELAY_MS);
    armedForTime = min;
    armedTimerId = deps.setTimer(delay, tick);
  }

  function finishAttempt(rt: JobRuntime, result: SpawnResult, spawnFailed: boolean): void {
    rt.currentDone = undefined;
    rt.currentKill = undefined;
    rt.state.lastFinishAt = deps.now();
    rt.state.lastExitCode = spawnFailed ? null : result.code;

    const success = !spawnFailed && result.code === 0 && !result.timedOut;
    if (success) {
      rt.state.lastOutcome = "ok";
      rt.state.consecutiveFailures = 0;
      rt.running = false;
      persistState();
      deps.log(`orchestrator: job "${rt.job.name}" succeeded`);
      return;
    }

    const classification: JobOutcome = !spawnFailed && result.timedOut ? "timeout" : "failed";
    const attemptsAllowed = rt.job.retry?.attempts ?? 0;
    // `&& !stopped`: rearmGlobalTimer() is a no-op once stopped (see its own `if (stopped)
    // return`), so a retry "scheduled" after stop() has already been called would never
    // actually fire — logging "retrying in Xm" in that case would be a promise the log and
    // the state file both make and then silently break. Fall through to the permanent-failure
    // path instead so the recorded outcome matches what actually happens: no retry.
    if (rt.attemptsUsed < attemptsAllowed && !stopped) {
      rt.attemptsUsed += 1;
      const delayMinutes = rt.job.retry?.delayMinutes ?? 0;
      rt.pendingRetryAt = deps.now() + delayMinutes * 60_000;
      persistState();
      deps.log(
        `orchestrator: job "${rt.job.name}" attempt failed (${classification}); retrying in ${delayMinutes}m ` +
          `(attempt ${rt.attemptsUsed}/${attemptsAllowed})`,
      );
      rearmGlobalTimer();
      return;
    }

    rt.state.lastOutcome = classification;
    rt.state.consecutiveFailures += 1;
    rt.running = false;
    persistState();
    if (stopped && rt.attemptsUsed < attemptsAllowed) {
      deps.log(
        `orchestrator: job "${rt.job.name}" failed (${classification}) during shutdown — retry budget remained ` +
          `(${rt.attemptsUsed}/${attemptsAllowed}) but the daemon is stopping, so it will not be attempted`,
      );
    } else {
      deps.log(`orchestrator: job "${rt.job.name}" failed permanently (${classification})`);
    }
  }

  function startAttempt(rt: JobRuntime, atTime: number): void {
    rt.running = true;
    rt.state.lastStartAt = atTime;
    persistState();

    let handle: { done: Promise<SpawnResult>; kill(): void };
    try {
      handle = deps.spawnJob(rt.job);
    } catch (err) {
      deps.log(`orchestrator: job "${rt.job.name}" spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      finishAttempt(rt, { code: null, timedOut: false }, true);
      return;
    }

    rt.currentDone = handle.done;
    rt.currentKill = handle.kill;
    handle.done
      .then((result) => finishAttempt(rt, result, false))
      .catch((err) => {
        deps.log(`orchestrator: job "${rt.job.name}" spawn promise rejected: ${err instanceof Error ? err.message : String(err)}`);
        finishAttempt(rt, { code: null, timedOut: false }, true);
      });
  }

  function tick(): void {
    if (stopped) return;
    armedTimerId = null;
    const now = deps.now();

    const dueScheduled: JobRuntime[] = [];
    const dueRetries: JobRuntime[] = [];
    for (const rt of jobs.values()) {
      // Independent checks, not mutually exclusive: a pending retry and the job's regular
      // cadence can both be due (the regular cadence keeps ticking during a retry backoff so
      // D3 overlap-skip still fires instead of the schedule silently stalling for the chain).
      if (rt.pendingRetryAt !== null && rt.pendingRetryAt <= now) {
        dueRetries.push(rt);
      }
      if (rt.nextScheduledAt <= now) {
        dueScheduled.push(rt);
      }
    }

    for (const rt of dueScheduled) {
      const dueAt = rt.nextScheduledAt;
      // Advance the schedule from the DUE time regardless of what happens next — this keeps
      // the cron cadence ticking even while the job is still running, which is what makes
      // D3 overlap-skip detection possible instead of the schedule silently stalling.
      rt.nextScheduledAt = computeNextDue(rt.job, new Date(dueAt));
      if (rt.running) {
        rt.state.skippedOverlaps += 1;
        persistState();
        deps.log(`orchestrator: job "${rt.job.name}" due at ${new Date(dueAt).toISOString()} skipped (still running — overlap)`);
      } else {
        rt.attemptsUsed = 0;
        startAttempt(rt, dueAt);
      }
    }

    for (const rt of dueRetries) {
      const fireAt = rt.pendingRetryAt as number;
      rt.pendingRetryAt = null;
      startAttempt(rt, fireAt);
    }

    rearmGlobalTimer();
  }

  function start(): void {
    const startDate = new Date(deps.now());
    const priorState = deps.readState();

    for (const job of cfg.jobs) {
      const prior = priorState?.jobs[job.name];
      if (prior) {
        deps.log(
          `orchestrator: job "${job.name}" previous state — lastOutcome=${prior.lastOutcome ?? "none"}, ` +
            `lastFinishAt=${prior.lastFinishAt ?? "never"} (informational only; not backfilled)`,
        );
      }
      jobs.set(job.name, {
        job,
        nextScheduledAt: computeNextDue(job, startDate),
        pendingRetryAt: null,
        running: false,
        attemptsUsed: 0,
        currentDone: undefined,
        currentKill: undefined,
        state: freshJobState(),
      });
    }

    rearmGlobalTimer();
  }

  async function stop(graceMs: number = DEFAULT_SHUTDOWN_GRACE_MS): Promise<void> {
    stopped = true;
    if (armedTimerId !== null) {
      deps.clearTimer(armedTimerId);
      armedTimerId = null;
    }

    const active = [...jobs.values()].filter((rt) => rt.currentDone !== undefined);
    if (active.length === 0) {
      deps.log("orchestrator: stop — no jobs running, shutting down immediately");
      return;
    }

    deps.log(`orchestrator: stop — ${active.length} job(s) running; awaiting up to ${graceMs}ms grace`);
    const settled = new Set<string>();
    for (const rt of active) {
      rt.currentDone
        ?.then(() => settled.add(rt.job.name))
        .catch(() => settled.add(rt.job.name));
    }

    await new Promise<void>((resolve) => {
      let resolved = false;
      const graceTimerId = deps.setTimer(graceMs, () => {
        if (resolved) return;
        resolved = true;
        for (const rt of active) {
          if (!settled.has(rt.job.name)) {
            deps.log(`orchestrator: stop — grace expired, killing job "${rt.job.name}"`);
            rt.currentKill?.();
          }
        }
        resolve();
      });
      Promise.all(active.map((rt) => rt.currentDone)).then(() => {
        if (resolved) return;
        resolved = true;
        deps.clearTimer(graceTimerId);
        deps.log("orchestrator: stop — all running jobs finished within grace");
        resolve();
      });
    });
  }

  return { start, stop };
}
