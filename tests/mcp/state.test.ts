import { describe, expect, test } from "bun:test";
import { DebugSession } from "../../src/mcp/state";
import type { DebuggerEvent } from "../../src/core/types";

const brk: DebuggerEvent = { kind: "break", objectType: 5, objectId: 1, stack: [] };

function session(): DebugSession {
  // client/index unused by queue logic; state only stores them
  return new DebugSession(null as never, null as never);
}

describe("DebugSession queue", () => {
  test("wait returns queued event immediately", async () => {
    const s = session();
    s.push(brk);
    expect(await s.wait(1000)).toEqual(brk);
  });

  test("wait resolves when event arrives later", async () => {
    const s = session();
    const pending = s.wait(1000);
    s.push({ kind: "testRunFinished" });
    expect(await pending).toEqual({ kind: "testRunFinished" });
  });

  test("wait times out", async () => {
    const s = session();
    expect(await s.wait(10)).toEqual({ timedOut: true });
  });

  test("second concurrent wait throws", async () => {
    const s = session();
    const first = s.wait(50);
    await expect(s.wait(50)).rejects.toThrow(/already pending/);
    await first;
  });

  test("queue drops oldest beyond 100 events", () => {
    const s = session();
    for (let i = 0; i < 105; i++) s.push({ kind: "fatal", message: `m${i}` });
    expect(s.queueLength).toBe(100);
  });

  test("droppedEvents counts events discarded at the cap", () => {
    const s = session();
    expect(s.droppedEvents).toBe(0);
    for (let i = 0; i < 105; i++) s.push({ kind: "fatal", message: `m${i}` });
    expect(s.droppedEvents).toBe(5);
  });
});
