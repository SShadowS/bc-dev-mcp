import { describe, expect, test } from "bun:test";
import { analyzeTestOrder, type OrderRun, type OrderRunResult } from "../../src/core/test-order-analysis";
import { planTestOrder } from "../../src/core/test-order-plan";
import type { TestObservationStatus } from "../../src/core/test-orchestration";

const A = { codeunitId: 50100, method: "A" };
const B = { codeunitId: 50100, method: "B" };
const C = { codeunitId: 50101, method: "C" };
const selection = [A, B, C];

function results(statuses: Record<string, TestObservationStatus>): OrderRunResult[] {
  return selection.map((id) => ({ ...id, status: statuses[id.method]! }));
}
const allPass = () => results({ A: "passed", B: "passed", C: "passed" });
const isolationAllPass = allPass();

const run = (plan: ReturnType<typeof planTestOrder>, r: OrderRunResult[]): OrderRun => ({ plan, results: r });
const recorded = planTestOrder(selection, { mode: "recorded" }); // A B C
const reversed = planTestOrder(selection, { mode: "reversed" }); // C A B (groups reversed, A B keep declaration order)

const byMethod = (analysis: ReturnType<typeof analyzeTestOrder>, method: string) =>
  analysis.tests.find((t) => t.method === method)!;

describe("analyzeTestOrder", () => {
  test("no pollution: every method consistentPass, zero od-victims", () => {
    const analysis = analyzeTestOrder({ isolation: isolationAllPass, runs: [run(recorded, allPass()), run(reversed, allPass())] });
    expect(analysis.tests.map((t) => t.classification)).toEqual(["consistentPass", "consistentPass", "consistentPass"]);
    expect(analysis.summary.odVictim).toBe(0);
    expect(analysis.runs).toEqual([{ mode: "recorded", order: ["50100:A", "50100:B", "50101:C"] }, { mode: "reversed", order: ["50101:C", "50100:A", "50100:B"] }]);
  });

  test("passes in isolation, fails only after others: od-victim with candidate polluters", () => {
    // C fails after A (recorded), passes when it runs first (reversed).
    const analysis = analyzeTestOrder({
      isolation: isolationAllPass,
      runs: [run(recorded, results({ A: "passed", B: "passed", C: "failed" })), run(reversed, allPass())],
    });
    const c = byMethod(analysis, "C");
    expect(c.classification).toBe("odVictim");
    // Intersection of predecessors across failing runs.
    expect(c.candidatePolluters).toEqual([A, B]);
    expect(c.failingRuns).toEqual([0]);
    expect(analysis.summary.odVictim).toBe(1);
  });

  test("same-codeunit victim: fails in its group in every order, candidates narrow to the intersection", () => {
    const bFails = results({ A: "passed", B: "failed", C: "passed" });
    const analysis = analyzeTestOrder({ isolation: isolationAllPass, runs: [run(recorded, bFails), run(reversed, bFails)] });
    const b = byMethod(analysis, "B");
    expect(b.classification).toBe("odVictim");
    expect(b.candidatePolluters).toEqual([A]); // recorded: {A}; reversed: {C, A}
    expect(b.failingRuns).toEqual([0, 1]);
  });

  test("fails in isolation and in every order: consistentFail", () => {
    const r = results({ A: "failed", B: "passed", C: "passed" });
    const analysis = analyzeTestOrder({
      isolation: results({ A: "failed", B: "passed", C: "passed" }),
      runs: [run(recorded, r), run(reversed, r)],
    });
    expect(byMethod(analysis, "A").classification).toBe("consistentFail");
    expect(analysis.summary.consistentFail).toBe(1);
  });

  test("fails in isolation but passes after another method: odBrittle", () => {
    const analysis = analyzeTestOrder({
      isolation: results({ A: "passed", B: "passed", C: "failed" }),
      runs: [run(recorded, allPass())],
    });
    expect(byMethod(analysis, "C").classification).toBe("odBrittle");
  });

  test("passes in isolation, fails when run first: flakyInSameOrder (isolation = empty prefix)", () => {
    const analysis = analyzeTestOrder({
      isolation: isolationAllPass,
      runs: [run(recorded, results({ A: "failed", B: "passed", C: "passed" }))],
    });
    const a = byMethod(analysis, "A");
    expect(a.classification).toBe("flakyInSameOrder");
    expect(a.candidatePolluters).toEqual([]);
  });

  test("different outcomes for the same predecessors: flakyInSameOrder beats od classes", () => {
    const analysis = analyzeTestOrder({
      isolation: isolationAllPass,
      runs: [run(recorded, results({ A: "passed", B: "passed", C: "failed" })), run(recorded, allPass())],
    });
    const c = byMethod(analysis, "C");
    expect(c.classification).toBe("flakyInSameOrder");
    expect(c.candidatePolluters).toEqual([]);
  });

  test("mixed outcomes without isolation: orderDependent", () => {
    const analysis = analyzeTestOrder({
      runs: [run(recorded, results({ A: "passed", B: "passed", C: "failed" })), run(reversed, allPass())],
    });
    expect(byMethod(analysis, "C").classification).toBe("orderDependent");
  });

  test("no pass/fail observation: incomplete; method identity is case-insensitive", () => {
    const analysis = analyzeTestOrder({
      isolation: [{ codeunitId: 50100, method: "a", status: "passed" }],
      runs: [run(recorded, results({ A: "missing", B: "skipped", C: "passed" }))],
    });
    expect(byMethod(analysis, "B").classification).toBe("incomplete");
    expect(byMethod(analysis, "A").classification).toBe("consistentPass"); // isolation "a" matched A
    expect(byMethod(analysis, "A").observations).toEqual([
      { run: "isolation", status: "passed" },
      { run: 0, status: "missing" },
    ]);
  });
});
