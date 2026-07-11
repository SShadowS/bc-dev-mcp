import { describe, expect, test } from "bun:test";
import { workQueue, type WorkerConfig, type WorkerDeps } from "../../../src/core/queue/worker";
import type { CaptureRequestRow, ClaimResult } from "../../../src/core/queue/queue-client";
import type { CycleOutcome } from "../../../src/core/ship/capture-cycle";

function row(over: Partial<CaptureRequestRow> = {}): CaptureRequestRow {
  return {
    id: 1,
    tenant: "contoso",
    fingerprint: "telemetry:9f2c1a7b0e4d5f61",
    findingId: 203,
    appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    appName: "Sales Extensions",
    objectType: "Codeunit",
    objectId: 50100,
    methodName: "processline",
    reason: "RT0018: 5 runs, severity critical",
    status: "pending",
    requestedAt: "2026-07-01T09:00:00.000Z",
    expiresAt: "2026-07-15T09:00:00.000Z",
    claimedAt: null,
    claimedBy: null,
    fulfilledAt: null,
    fulfilledByProfileId: null,
    ...over,
  };
}

function fakeClient(opts: {
  rows: CaptureRequestRow[];
  claimResults?: Record<number, ClaimResult>;
  cancelResults?: Record<number, { ok: boolean; message: string }>;
}) {
  const claimCalls: Array<{ id: number; by: string }> = [];
  const cancelCalls: number[] = [];
  const client: WorkerDeps["client"] = {
    async listPending() {
      return opts.rows;
    },
    async claim(id, by) {
      claimCalls.push({ id, by });
      return opts.claimResults?.[id] ?? { ok: true };
    },
    async cancel(id) {
      cancelCalls.push(id);
      return opts.cancelResults?.[id] ?? { ok: true, message: "cancelled" };
    },
  };
  return { client, claimCalls, cancelCalls };
}

const noopSpawn: WorkerDeps["spawnWorkload"] = () => ({ kill: () => {}, done: Promise.resolve(0) });

function baseCfg(over: Partial<WorkerConfig> = {}): WorkerConfig {
  return { executor: "worker1", max: 1, keepClaimOnFailure: false, ...over };
}

describe("workQueue: empty queue", () => {
  test("returns a zeroed report and never calls claim or runCycle", async () => {
    const { client, claimCalls } = fakeClient({ rows: [] });
    let cycleCalls = 0;
    const deps: WorkerDeps = {
      client,
      runCycle: async () => {
        cycleCalls++;
        return { kind: "shipped", activityId: "x", gzippedBytes: 1 };
      },
      spawnWorkload: noopSpawn,
      log: () => {},
    };
    const report = await workQueue(baseCfg(), deps);
    expect(report).toEqual({ polled: 0, worked: [], failures: 0, claimErrors: 0 });
    expect(claimCalls.length).toBe(0);
    expect(cycleCalls).toBe(0);
  });
});

describe("workQueue: selection", () => {
  test("works only the first `max` successfully-claimed rows, in list order", async () => {
    const rows = [1, 2, 3, 4, 5].map((id) => row({ id }));
    const { client, claimCalls } = fakeClient({ rows });
    const cycleCalls: number[] = [];
    const deps: WorkerDeps = {
      client,
      runCycle: async (r) => {
        cycleCalls.push(r.id);
        return { kind: "shipped", activityId: "a", gzippedBytes: 1 };
      },
      spawnWorkload: noopSpawn,
      log: () => {},
    };
    const report = await workQueue(baseCfg({ max: 1 }), deps);
    expect(claimCalls).toEqual([{ id: 1, by: "worker1" }]);
    expect(cycleCalls).toEqual([1]);
    expect(report.polled).toBe(5);
    expect(report.worked.length).toBe(1);
  });
});

describe("workQueue: claim races", () => {
  test("raced/gone claims are recorded as claim-raced, move to the next row, and don't consume the budget", async () => {
    const rows = [1, 2, 3].map((id) => row({ id }));
    const { client, claimCalls } = fakeClient({
      rows,
      claimResults: {
        1: { ok: false, reason: "raced", message: "status is claimed" },
        2: { ok: false, reason: "gone", message: "No capture request with id 2." },
        3: { ok: true },
      },
    });
    const cycleCalls: number[] = [];
    const deps: WorkerDeps = {
      client,
      runCycle: async (r) => {
        cycleCalls.push(r.id);
        return { kind: "shipped", activityId: "a", gzippedBytes: 1 };
      },
      spawnWorkload: noopSpawn,
      log: () => {},
    };
    const report = await workQueue(baseCfg({ max: 1 }), deps);
    expect(claimCalls.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(cycleCalls).toEqual([3]);
    expect(report.worked).toEqual([
      { id: 1, outcome: "claim-raced", released: false },
      { id: 2, outcome: "claim-raced", released: false },
      { id: 3, outcome: "shipped", released: false },
    ]);
  });
});

describe("workQueue: claim retention on delivery", () => {
  test("shipped and duplicate outcomes keep the claim — no cancel call", async () => {
    const rows = [row({ id: 1 }), row({ id: 2 })];
    const { client, cancelCalls } = fakeClient({ rows });
    const outcomes: CycleOutcome[] = [
      { kind: "shipped", activityId: "a1", gzippedBytes: 1 },
      { kind: "duplicate", activityId: "a2" },
    ];
    let i = 0;
    const deps: WorkerDeps = {
      client,
      runCycle: async () => outcomes[i++]!,
      spawnWorkload: noopSpawn,
      log: () => {},
    };
    const report = await workQueue(baseCfg({ max: 2 }), deps);
    expect(cancelCalls).toEqual([]);
    expect(report.worked).toEqual([
      { id: 1, outcome: "shipped", released: false },
      { id: 2, outcome: "duplicate", released: false },
    ]);
  });

  test("dry-run outcome keeps the claim — no cancel call (a benign self-expiring claim beats identity churn)", async () => {
    const rows = [row({ id: 1 })];
    const { client, cancelCalls } = fakeClient({ rows });
    const deps: WorkerDeps = {
      client,
      runCycle: async () => ({ kind: "dry-run", activityId: "a1", manifest: {}, gzippedBytes: 1, zipPath: "z", irPath: "i" }),
      spawnWorkload: noopSpawn,
      log: () => {},
    };
    const report = await workQueue(baseCfg(), deps);
    expect(cancelCalls).toEqual([]);
    expect(report.worked).toEqual([{ id: 1, outcome: "dry-run", released: false }]);
  });
});

describe("workQueue: claim errors (CLI failure, distinct from a raced/gone claim)", () => {
  test('reason "error" is recorded as claim-error, not claim-raced, and doesn\'t consume the budget', async () => {
    const rows = [row({ id: 1 }), row({ id: 2 })];
    const { client, claimCalls } = fakeClient({
      rows,
      claimResults: {
        1: { ok: false, reason: "error", message: "captures claim failed (exit 127): command not found" },
        2: { ok: true },
      },
    });
    const cycleCalls: number[] = [];
    const deps: WorkerDeps = {
      client,
      runCycle: async (r) => {
        cycleCalls.push(r.id);
        return { kind: "shipped", activityId: "a", gzippedBytes: 1 };
      },
      spawnWorkload: noopSpawn,
      log: () => {},
    };
    const report = await workQueue(baseCfg({ max: 1 }), deps);
    expect(claimCalls.map((c) => c.id)).toEqual([1, 2]);
    expect(cycleCalls).toEqual([2]);
    expect(report.worked).toEqual([
      { id: 1, outcome: "claim-error", released: false },
      { id: 2, outcome: "shipped", released: false },
    ]);
    expect(report.claimErrors).toBe(1);
    expect(report.failures).toBe(0);
  });

  test("an all-claim-error queue reports claimErrors == polled and leaves failures at 0", async () => {
    const rows = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })];
    const { client } = fakeClient({
      rows,
      claimResults: {
        1: { ok: false, reason: "error", message: "boom" },
        2: { ok: false, reason: "error", message: "boom" },
        3: { ok: false, reason: "error", message: "boom" },
      },
    });
    let cycleCalls = 0;
    const deps: WorkerDeps = {
      client,
      runCycle: async () => {
        cycleCalls++;
        return { kind: "shipped", activityId: "a", gzippedBytes: 1 };
      },
      spawnWorkload: noopSpawn,
      log: () => {},
    };
    const report = await workQueue(baseCfg({ max: 3 }), deps);
    expect(cycleCalls).toBe(0);
    expect(report.polled).toBe(3);
    expect(report.worked.every((w) => w.outcome === "claim-error")).toBe(true);
    expect(report.claimErrors).toBe(3);
    expect(report.claimErrors).toBe(report.polled);
    expect(report.failures).toBe(0);
  });
});

describe("workQueue: claim release on non-delivery", () => {
  test("no-capture and error outcomes cancel the claim (released=true) by default", async () => {
    const rows = [row({ id: 1 }), row({ id: 2 })];
    const { client, cancelCalls } = fakeClient({ rows });
    const outcomes: CycleOutcome[] = [{ kind: "no-capture" }, { kind: "error", stage: "attach", message: "boom" }];
    let i = 0;
    const deps: WorkerDeps = {
      client,
      runCycle: async () => outcomes[i++]!,
      spawnWorkload: noopSpawn,
      log: () => {},
    };
    const report = await workQueue(baseCfg({ max: 2 }), deps);
    expect(cancelCalls).toEqual([1, 2]);
    expect(report.worked).toEqual([
      { id: 1, outcome: "no-capture", released: true },
      { id: 2, outcome: "error", released: true },
    ]);
  });

  test("keepClaimOnFailure keeps the claim on failure and logs it, without calling cancel", async () => {
    const rows = [row({ id: 1 })];
    const { client, cancelCalls } = fakeClient({ rows });
    const logs: string[] = [];
    const deps: WorkerDeps = {
      client,
      runCycle: async () => ({ kind: "no-capture" }),
      spawnWorkload: noopSpawn,
      log: (m) => logs.push(m),
    };
    const report = await workQueue(baseCfg({ keepClaimOnFailure: true }), deps);
    expect(cancelCalls).toEqual([]);
    expect(report.worked).toEqual([{ id: 1, outcome: "no-capture", released: false }]);
    expect(logs.some((l) => /keep/i.test(l) && l.includes("1"))).toBe(true);
  });

  test("a cancel failure (ok:false) is logged, not thrown", async () => {
    const rows = [row({ id: 1 })];
    const { client } = fakeClient({ rows, cancelResults: { 1: { ok: false, message: "already fulfilled" } } });
    const logs: string[] = [];
    const deps: WorkerDeps = {
      client,
      runCycle: async () => ({ kind: "error", stage: "ship", message: "boom" }),
      spawnWorkload: noopSpawn,
      log: (m) => logs.push(m),
    };
    const report = await workQueue(baseCfg(), deps);
    expect(report.worked).toEqual([{ id: 1, outcome: "error", released: false }]);
    expect(logs.some((l) => l.includes("already fulfilled"))).toBe(true);
  });
});

describe("workQueue: workload hook", () => {
  test("spawns only after the armed log line, with all 8 BCQ_* env vars from the request", async () => {
    const r = row({
      id: 42,
      tenant: "contoso",
      appId: "app-guid",
      appName: "Sales Ext",
      objectType: "Codeunit",
      objectId: 50100,
      methodName: "ProcessLine",
      reason: "RT0018: 5 runs, severity critical",
    });
    const { client } = fakeClient({ rows: [r] });
    const spawnCalls: Array<{ cmd: string; env: Record<string, string> }> = [];
    const deps: WorkerDeps = {
      client,
      runCycle: async (_row, onLog) => {
        onLog("snapshot endpoint ok (webApiVersion 1.0)");
        expect(spawnCalls.length).toBe(0); // not yet — armed line hasn't fired
        onLog("armed instrumentation capture 550e8400-e29b-41d4-a716-446655440042 (attachKind Debugger)");
        return { kind: "shipped", activityId: "a1", gzippedBytes: 1 };
      },
      spawnWorkload: (cmd, env) => {
        spawnCalls.push({ cmd, env });
        return { kill: () => {}, done: Promise.resolve(0) };
      },
      log: () => {},
    };
    await workQueue(baseCfg({ workloadCmd: "run-workload.exe" }), deps);
    expect(spawnCalls).toEqual([
      {
        cmd: "run-workload.exe",
        env: {
          BCQ_REQUEST_ID: "42",
          BCQ_TENANT: "contoso",
          BCQ_APP_ID: "app-guid",
          BCQ_APP_NAME: "Sales Ext",
          BCQ_OBJECT_TYPE: "Codeunit",
          BCQ_OBJECT_ID: "50100",
          BCQ_METHOD_NAME: "ProcessLine",
          BCQ_REASON: "RT0018: 5 runs, severity critical",
        },
      },
    ]);
  });

  test("null appName maps to an empty-string BCQ_APP_NAME", async () => {
    const r = row({ appName: null });
    const { client } = fakeClient({ rows: [r] });
    const spawnCalls: Array<{ env: Record<string, string> }> = [];
    const deps: WorkerDeps = {
      client,
      runCycle: async (_row, onLog) => {
        onLog("armed instrumentation capture x (attachKind y)");
        return { kind: "shipped", activityId: "a", gzippedBytes: 1 };
      },
      spawnWorkload: (_cmd, env) => {
        spawnCalls.push({ env });
        return { kill: () => {}, done: Promise.resolve(0) };
      },
      log: () => {},
    };
    await workQueue(baseCfg({ workloadCmd: "wl" }), deps);
    expect(spawnCalls[0]!.env.BCQ_APP_NAME).toBe("");
  });

  test("a still-running child is killed when the cycle resolves", async () => {
    const { client } = fakeClient({ rows: [row({ id: 1 })] });
    let killed = false;
    const deps: WorkerDeps = {
      client,
      runCycle: async (_row, onLog) => {
        onLog("armed instrumentation capture x (attachKind y)");
        return { kind: "shipped", activityId: "a", gzippedBytes: 1 };
      },
      spawnWorkload: () => ({
        kill: () => {
          killed = true;
        },
        done: new Promise<number | null>(() => {}), // never resolves — still running
      }),
      log: () => {},
    };
    await workQueue(baseCfg({ workloadCmd: "wl" }), deps);
    expect(killed).toBe(true);
  });

  test("an already-exited child is not killed again", async () => {
    const { client } = fakeClient({ rows: [row({ id: 1 })] });
    let killCalls = 0;
    const deps: WorkerDeps = {
      client,
      runCycle: async (_row, onLog) => {
        onLog("armed instrumentation capture x (attachKind y)");
        return { kind: "shipped", activityId: "a", gzippedBytes: 1 };
      },
      spawnWorkload: () => ({
        kill: () => {
          killCalls++;
        },
        done: Promise.resolve(0), // already settled — exited
      }),
      log: () => {},
    };
    await workQueue(baseCfg({ workloadCmd: "wl" }), deps);
    expect(killCalls).toBe(0);
  });

  test("never spawns when the armed line doesn't appear (cycle errors at attach)", async () => {
    const { client } = fakeClient({ rows: [row({ id: 1 })] });
    let spawned = false;
    const deps: WorkerDeps = {
      client,
      runCycle: async (_row, onLog) => {
        onLog("snapshot endpoint unreachable: connection refused");
        return { kind: "error", stage: "attach", message: "connection refused" };
      },
      spawnWorkload: () => {
        spawned = true;
        return { kill: () => {}, done: Promise.resolve(0) };
      },
      log: () => {},
    };
    const report = await workQueue(baseCfg({ workloadCmd: "wl" }), deps);
    expect(spawned).toBe(false);
    expect(report.worked[0]!.outcome).toBe("error");
  });

  test("never spawns when workloadCmd is not configured", async () => {
    const { client } = fakeClient({ rows: [row({ id: 1 })] });
    let spawned = false;
    const deps: WorkerDeps = {
      client,
      runCycle: async (_row, onLog) => {
        onLog("armed instrumentation capture x (attachKind y)");
        return { kind: "shipped", activityId: "a", gzippedBytes: 1 };
      },
      spawnWorkload: () => {
        spawned = true;
        return { kill: () => {}, done: Promise.resolve(0) };
      },
      log: () => {},
    };
    await workQueue(baseCfg(), deps);
    expect(spawned).toBe(false);
  });
});

describe("workQueue: failures counting", () => {
  test("counts only `error` outcomes — a no-capture is normal", async () => {
    const rows = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })];
    const { client } = fakeClient({ rows });
    const outcomes: CycleOutcome[] = [
      { kind: "no-capture" },
      { kind: "shipped", activityId: "a", gzippedBytes: 1 },
      { kind: "error", stage: "ship", message: "boom" },
    ];
    let i = 0;
    const deps: WorkerDeps = {
      client,
      runCycle: async () => outcomes[i++]!,
      spawnWorkload: noopSpawn,
      log: () => {},
    };
    const report = await workQueue(baseCfg({ max: 3 }), deps);
    expect(report.failures).toBe(1);
  });
});

describe("workQueue: resilience to a bad request", () => {
  test("a rejected runCycle promise is recorded as error, released per the failure rule, and the loop continues", async () => {
    const rows = [row({ id: 1 }), row({ id: 2 })];
    const { client, cancelCalls } = fakeClient({ rows });
    let calls = 0;
    const deps: WorkerDeps = {
      client,
      runCycle: async () => {
        calls++;
        if (calls === 1) throw new Error("cycle blew up");
        return { kind: "shipped", activityId: "a", gzippedBytes: 1 };
      },
      spawnWorkload: noopSpawn,
      log: () => {},
    };
    const report = await workQueue(baseCfg({ max: 2 }), deps);
    expect(calls).toBe(2);
    expect(cancelCalls).toEqual([1]);
    expect(report.worked).toEqual([
      { id: 1, outcome: "error", released: true },
      { id: 2, outcome: "shipped", released: false },
    ]);
    expect(report.failures).toBe(1);
  });
});
