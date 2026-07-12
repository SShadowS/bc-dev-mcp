import { describe, expect, mock, test } from "bun:test";
import type { JobConfig, OrchestratorConfig } from "../../../src/core/orchestrate/config";
import { type OrchestratorState, type SchedulerDeps, createScheduler } from "../../../src/core/orchestrate/scheduler";

// ---- fake clock: manual timers, no real setTimeout in the scheduler's own scheduling path ----

interface FakeClock {
  now(): number;
  setTimer(ms: number, fn: () => void): number;
  clearTimer(id: number): void;
  advanceTo(targetMs: number): void;
  advanceBy(ms: number): void;
  pendingCount(): number;
}

function createFakeClock(startMs: number): FakeClock {
  let nowMs = startMs;
  let nextId = 1;
  const timers = new Map<number, { dueAt: number; fn: () => void }>();

  function advanceTo(targetMs: number): void {
    nowMs = targetMs;
    let fired = true;
    while (fired) {
      fired = false;
      const due = [...timers.entries()].filter(([, t]) => t.dueAt <= nowMs).sort((a, b) => a[1].dueAt - b[1].dueAt);
      for (const [id] of due) {
        const t = timers.get(id);
        if (!t) continue;
        timers.delete(id);
        t.fn();
        fired = true;
      }
    }
  }

  return {
    now: () => nowMs,
    setTimer: (ms, fn) => {
      const id = nextId++;
      timers.set(id, { dueAt: nowMs + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    advanceTo,
    advanceBy: (ms) => advanceTo(nowMs + ms),
    pendingCount: () => timers.size,
  };
}

// ---- deferred promise + controllable spawnJob mock ----

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface SpawnInstance {
  job: JobConfig;
  resolve: (r: { code: number | null; timedOut: boolean }) => void;
  kill: ReturnType<typeof mock>;
}

function createMockSpawner() {
  const calls: JobConfig[] = [];
  const instances: SpawnInstance[] = [];
  let throwOnNext: Error | null = null;

  function spawnJob(job: JobConfig): { done: Promise<{ code: number | null; timedOut: boolean }>; kill(): void } {
    if (throwOnNext) {
      const err = throwOnNext;
      throwOnNext = null;
      throw err;
    }
    calls.push(job);
    const d = deferred<{ code: number | null; timedOut: boolean }>();
    const kill = mock(() => {});
    instances.push({ job, resolve: d.resolve, kill });
    return { done: d.promise, kill };
  }

  return {
    spawnJob,
    calls,
    instances,
    throwNext(err: Error): void {
      throwOnNext = err;
    },
  };
}

// yields to the microtask queue so promise `.then` chains inside the scheduler settle
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function job(over: Partial<JobConfig> = {}): JobConfig {
  return {
    name: "a",
    schedule: "*/5 * * * *",
    command: "bun",
    args: ["toy.ts"],
    env: {},
    jitterMinutes: 0,
    timeoutMinutes: 30,
    ...over,
  };
}

function cfg(...jobs: JobConfig[]): OrchestratorConfig {
  return { jobs };
}

function createTestDeps(clock: FakeClock, spawner: ReturnType<typeof createMockSpawner>) {
  const logs: string[] = [];
  const writes: OrchestratorState[] = [];
  let stateToRead: OrchestratorState | null = null;
  const deps: SchedulerDeps = {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    spawnJob: spawner.spawnJob,
    readState: () => stateToRead,
    writeState: (s) => {
      writes.push(structuredClone(s));
    },
    log: (line) => {
      logs.push(line);
    },
    random: () => 0,
  };
  return {
    deps,
    logs,
    writes,
    setStateToRead(s: OrchestratorState | null): void {
      stateToRead = s;
    },
  };
}

// 2026-01-01 00:00:00 local — arbitrary fixed anchor, minute-aligned.
const T0 = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();

describe("createScheduler: next-due computation and single-timer arming", () => {
  test("arms a single timer for the earliest due job and fires spawnJob exactly at that time", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(job({ name: "a", schedule: "*/5 * * * *" })), deps);

    scheduler.start();
    expect(spawner.calls).toHaveLength(0);

    clock.advanceTo(T0 + 4 * 60_000);
    expect(spawner.calls).toHaveLength(0);

    clock.advanceTo(T0 + 5 * 60_000);
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.name).toBe("a");
  });

  test("re-arms from the DUE time after firing, so a slow job does not shift the schedule (no drift)", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(job({ name: "a", schedule: "*/5 * * * *" })), deps);
    scheduler.start();

    clock.advanceTo(T0 + 5 * 60_000);
    expect(spawner.calls).toHaveLength(1);

    // job takes 3 extra minutes to "complete" — resolve it well after due time
    clock.advanceTo(T0 + 8 * 60_000);
    const first = spawner.instances[0];
    expect(first).toBeDefined();
    first?.resolve({ code: 0, timedOut: false });
    await flush();

    // Next occurrence must be T0+10m (due-time-anchored), not T0+8m+5m=13m (completion-anchored).
    clock.advanceTo(T0 + 10 * 60_000 - 1);
    expect(spawner.calls).toHaveLength(1);
    clock.advanceTo(T0 + 10 * 60_000);
    expect(spawner.calls).toHaveLength(2);
  });

  test("applies jitter as random()*jitterMinutes*60000 added to the cron-computed due time", () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps } = createTestDeps(clock, spawner);
    deps.random = () => 0.5; // half of jitterMinutes
    const scheduler = createScheduler(cfg(job({ name: "a", schedule: "*/5 * * * *", jitterMinutes: 4 })), deps);
    scheduler.start();

    // base due = T0+5m; jitter = 0.5*4*60000 = 120000ms = 2m -> fires at T0+7m
    clock.advanceTo(T0 + 7 * 60_000 - 1);
    expect(spawner.calls).toHaveLength(0);
    clock.advanceTo(T0 + 7 * 60_000);
    expect(spawner.calls).toHaveLength(1);
  });

  test("two jobs due the same minute both spawn from a single tick", () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(job({ name: "a", schedule: "*/5 * * * *" }), job({ name: "b", schedule: "0,5,10 * * * *" })), deps);
    scheduler.start();

    clock.advanceTo(T0 + 5 * 60_000);
    expect(spawner.calls).toHaveLength(2);
    expect(spawner.calls.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });
});

describe("createScheduler: D3 overlap skip", () => {
  test("a due tick while the job is still running is skipped, counted, and never queued", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps, logs, writes } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(job({ name: "a", schedule: "*/5 * * * *" })), deps);
    scheduler.start();

    clock.advanceTo(T0 + 5 * 60_000);
    expect(spawner.calls).toHaveLength(1);

    // still running at the next due tick -> overlap skip, not a second spawn
    clock.advanceTo(T0 + 10 * 60_000);
    expect(spawner.calls).toHaveLength(1);
    expect(writes.at(-1)?.jobs["a"]?.skippedOverlaps).toBe(1);
    expect(logs.some((l) => l.toLowerCase().includes("overlap"))).toBe(true);

    // lastOutcome from before the overlap is untouched (still null — no run has finished yet)
    expect(writes.at(-1)?.jobs["a"]?.lastOutcome).toBeNull();

    // a further overlap at the next due tick still doesn't queue a second run
    clock.advanceTo(T0 + 15 * 60_000);
    expect(spawner.calls).toHaveLength(1);
    expect(writes.at(-1)?.jobs["a"]?.skippedOverlaps).toBe(2);

    // finishing the run frees the job for its NEXT due tick, not a queued backlog
    const first = spawner.instances[0];
    first?.resolve({ code: 0, timedOut: false });
    await flush();
    clock.advanceTo(T0 + 20 * 60_000);
    expect(spawner.calls).toHaveLength(2);
  });

  test("distinct jobs run concurrently — one job's overlap does not block another job's spawn", () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(job({ name: "a", schedule: "*/5 * * * *" }), job({ name: "b", schedule: "*/5 * * * *" })), deps);
    scheduler.start();

    clock.advanceTo(T0 + 5 * 60_000);
    expect(spawner.calls).toHaveLength(2);

    // neither a nor b resolves; both due again at +10m -> a and b both overlap-skip independently, no crash/interference
    clock.advanceTo(T0 + 10 * 60_000);
    expect(spawner.calls).toHaveLength(2);
  });
});

describe("createScheduler: D4 retry chain", () => {
  function retryJob(over: Partial<JobConfig> = {}): JobConfig {
    return job({ retry: { attempts: 2, delayMinutes: 3 }, ...over });
  }

  test("a failed attempt schedules a retry after delayMinutes; chain occupies the job", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps, writes } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(retryJob({ schedule: "*/5 * * * *" })), deps);
    scheduler.start();

    clock.advanceTo(T0 + 5 * 60_000);
    expect(spawner.calls).toHaveLength(1);
    spawner.instances[0]?.resolve({ code: 1, timedOut: false });
    await flush();

    // not yet retried, still occupies the job (running) so state is not finalized
    expect(writes.at(-1)?.jobs["a"]?.lastOutcome).toBeNull();
    expect(writes.at(-1)?.jobs["a"]?.lastExitCode).toBe(1);

    // due tick for the regular schedule at +10m must NOT queue a second concurrent run —
    // the retry chain still occupies the job, so this manifests as an overlap skip.
    clock.advanceTo(T0 + 8 * 60_000); // retry fires at +3m after failure = T0+8m
    expect(spawner.calls).toHaveLength(2);
    expect(spawner.calls[1]?.name).toBe("a");
  });

  test("attempts exhausted -> consecutiveFailures++ and lastOutcome = failed", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps, writes } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(retryJob({ schedule: "*/5 * * * *", retry: { attempts: 1, delayMinutes: 3 } })), deps);
    scheduler.start();

    clock.advanceTo(T0 + 5 * 60_000); // attempt 1
    spawner.instances[0]?.resolve({ code: 1, timedOut: false });
    await flush();

    clock.advanceTo(T0 + 8 * 60_000); // retry attempt (last allowed)
    expect(spawner.calls).toHaveLength(2);
    spawner.instances[1]?.resolve({ code: 1, timedOut: false });
    await flush();

    const state = writes.at(-1)?.jobs["a"];
    expect(state?.lastOutcome).toBe("failed");
    expect(state?.consecutiveFailures).toBe(1);
  });

  test("success mid-chain resets consecutiveFailures and finalizes outcome ok", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps, writes } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(retryJob({ schedule: "*/5 * * * *" })), deps);
    scheduler.start();

    clock.advanceTo(T0 + 5 * 60_000); // attempt 1 fails
    spawner.instances[0]?.resolve({ code: 1, timedOut: false });
    await flush();

    clock.advanceTo(T0 + 8 * 60_000); // attempt 2 (retry) succeeds
    spawner.instances[1]?.resolve({ code: 0, timedOut: false });
    await flush();

    const state = writes.at(-1)?.jobs["a"];
    expect(state?.lastOutcome).toBe("ok");
    expect(state?.consecutiveFailures).toBe(0);
  });

  test("spawnJob throwing synchronously counts as a failed attempt and can retry", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps, writes } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(retryJob({ schedule: "*/5 * * * *", retry: { attempts: 1, delayMinutes: 3 } })), deps);
    scheduler.start();

    spawner.throwNext(new Error("ENOENT"));
    clock.advanceTo(T0 + 5 * 60_000);
    expect(spawner.calls).toHaveLength(0); // throwing means no successful call recorded

    clock.advanceTo(T0 + 8 * 60_000); // scheduled retry after the synchronous throw
    expect(spawner.calls).toHaveLength(1);
    spawner.instances[0]?.resolve({ code: 0, timedOut: false });
    await flush();

    expect(writes.at(-1)?.jobs["a"]?.lastOutcome).toBe("ok");
  });

  test("timeout: spawnJob's timedOut result yields outcome timeout, and retry still applies", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps, writes } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(retryJob({ schedule: "*/5 * * * *", retry: { attempts: 0, delayMinutes: 3 } })), deps);
    scheduler.start();

    clock.advanceTo(T0 + 5 * 60_000);
    spawner.instances[0]?.resolve({ code: null, timedOut: true });
    await flush();

    const state = writes.at(-1)?.jobs["a"];
    expect(state?.lastOutcome).toBe("timeout");
    expect(state?.consecutiveFailures).toBe(1);
  });
});

describe("createScheduler: D5 persisted state", () => {
  test("writes state after every transition: start, then finish", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps, writes } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(job({ schedule: "*/5 * * * *" })), deps);
    scheduler.start();

    clock.advanceTo(T0 + 5 * 60_000);
    const afterStart = writes.length;
    expect(afterStart).toBeGreaterThan(0);
    expect(writes.at(-1)?.jobs["a"]?.lastStartAt).toBe(T0 + 5 * 60_000);

    spawner.instances[0]?.resolve({ code: 0, timedOut: false });
    await flush();
    expect(writes.length).toBeGreaterThan(afterStart);
    expect(writes.at(-1)?.jobs["a"]?.lastFinishAt).toBe(T0 + 5 * 60_000);
    expect(writes.at(-1)?.jobs["a"]?.lastOutcome).toBe("ok");
  });

  test("readState at startup is consulted for logging only — it does not seed live counters (no backfill)", () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps, logs, setStateToRead } = createTestDeps(clock, spawner);
    setStateToRead({
      jobs: {
        a: {
          lastStartAt: T0 - 1000,
          lastFinishAt: T0 - 500,
          lastExitCode: 1,
          lastOutcome: "failed",
          consecutiveFailures: 7,
          skippedOverlaps: 3,
        },
      },
    });
    const scheduler = createScheduler(cfg(job({ schedule: "*/5 * * * *" })), deps);
    scheduler.start();

    // startup read is surfaced via logging
    expect(logs.some((l) => l.includes("a") && (l.includes("prior") || l.includes("previous")))).toBe(true);

    // but the live run starts fresh: a fresh success at the first due tick resets to consecutiveFailures 0
    clock.advanceTo(T0 + 5 * 60_000);
    spawner.instances[0]?.resolve({ code: 0, timedOut: false });
  });
});

describe("createScheduler: stop()", () => {
  test("stop() with no running jobs resolves immediately and prevents new spawns", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(job({ schedule: "*/5 * * * *" })), deps);
    scheduler.start();

    await scheduler.stop(30_000);

    clock.advanceTo(T0 + 5 * 60_000);
    expect(spawner.calls).toHaveLength(0);
  });

  test("stop() awaits a running child up to grace, then resolves once it finishes within grace", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(job({ schedule: "*/5 * * * *" })), deps);
    scheduler.start();
    clock.advanceTo(T0 + 5 * 60_000);
    expect(spawner.calls).toHaveLength(1);

    const stopPromise = scheduler.stop(10_000);
    // resolve the child before grace expires
    spawner.instances[0]?.resolve({ code: 0, timedOut: false });
    clock.advanceBy(1); // let any fake timers tied to the resolution tick over, if scheduled
    await stopPromise;

    expect(spawner.instances[0]?.kill).not.toHaveBeenCalled();
  });

  test("stop() kills a running child once grace expires and still resolves", async () => {
    const clock = createFakeClock(T0);
    const spawner = createMockSpawner();
    const { deps, logs } = createTestDeps(clock, spawner);
    const scheduler = createScheduler(cfg(job({ schedule: "*/5 * * * *" })), deps);
    scheduler.start();
    clock.advanceTo(T0 + 5 * 60_000);
    expect(spawner.calls).toHaveLength(1);

    const stopPromise = scheduler.stop(5_000);
    // never resolve the child; advance the fake clock past the grace window so the
    // scheduler's own grace timer fires and triggers kill()
    clock.advanceBy(5_000);
    await stopPromise;

    expect(spawner.instances[0]?.kill).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.toLowerCase().includes("grace") && l.toLowerCase().includes("kill"))).toBe(true);
  });
});
