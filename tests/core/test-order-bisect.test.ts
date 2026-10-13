import { describe, expect, test } from "bun:test";
import { bisectPolluters, type OrderRunner } from "../../src/core/test-order-bisect";
import type { OrderRunResult } from "../../src/core/test-order-analysis";
import { planExecutionOrder, type TestOrderPlan } from "../../src/core/test-order-plan";
import type { OrchestratedTestIdentity } from "../../src/core/test-orchestration";

const id = (method: string, codeunitId = 50100): OrchestratedTestIdentity => ({ codeunitId, method });
const A = id("A"), B = id("B"), C = id("C"), D = id("D"), E = id("E"), F = id("F"), V = id("V");

/** Fake runner: the victim fails iff every method in one of `pollutingSets` ran before it. */
function fakeRunner(victim: string, pollutingSets: string[][]) {
  const probes: string[][] = [];
  const runner: OrderRunner = async (plan: TestOrderPlan) => {
    const executed = planExecutionOrder(plan);
    const order = executed.map((m) => m.method);
    probes.push(order);
    const ran = new Set(order.slice(0, order.indexOf(victim)));
    const polluted = pollutingSets.some((set) => set.every((m) => ran.has(m)));
    return executed.map((m): OrderRunResult => ({ ...m, status: m.method === victim && polluted ? "failed" : "passed" }));
  };
  return { runner, probes };
}

describe("bisectPolluters", () => {
  test("finds the single polluter among candidates, keeping candidate order before the victim", async () => {
    const { runner, probes } = fakeRunner("V", [["D"]]);
    const result = await bisectPolluters({ victims: [{ ...V, candidatePolluters: [A, B, C, D, E, F] }], runner });
    expect(result.victims[0]).toMatchObject({ ...V, outcome: "found", polluter: D, remainingCandidates: [D] });
    expect(probes[0]).toEqual(["A", "B", "C", "D", "E", "F", "V"]); // confirm
    expect(probes.at(-1)).toEqual(["D", "V"]); // the pair is verified by a probe
    expect(result.capped).toBe(false);
    expect(result.probes).toBe(probes.length);
    expect(result.victims[0]!.probes).toBe(probes.length);
  });

  test("probe is one Initialize: other-codeunit candidates first, then the victim's group with its own candidates", async () => {
    const X = id("X", 50101);
    const plans: TestOrderPlan[] = [];
    const { runner: inner } = fakeRunner("V", [["X"]]);
    const runner: OrderRunner = (plan) => (plans.push(plan), inner(plan));
    const result = await bisectPolluters({ victims: [{ ...V, candidatePolluters: [A, X] }], runner });
    expect(plans[0]!.groups).toEqual([{ id: 50101, methods: ["X"] }, { id: 50100, methods: ["A", "V"] }]);
    expect(result.victims[0]).toMatchObject({ outcome: "found", polluter: X });
    expect(plans.at(-1)!.groups).toEqual([{ id: 50101, methods: ["X"] }, { id: 50100, methods: ["V"] }]);
  });

  test("not reproduced when the victim passes after all candidates", async () => {
    const { runner, probes } = fakeRunner("V", []);
    const result = await bisectPolluters({ victims: [{ ...V, candidatePolluters: [A, B] }], runner });
    expect(result.victims[0]).toMatchObject({ outcome: "notReproduced", remainingCandidates: [A, B], probes: 1 });
    expect(result.victims[0]!.polluter).toBeUndefined();
    expect(probes).toEqual([["A", "B", "V"]]);
  });

  test("compound when pollution needs methods from both halves", async () => {
    const { runner } = fakeRunner("V", [["A", "D"]]);
    const result = await bisectPolluters({ victims: [{ ...V, candidatePolluters: [A, B, C, D] }], runner });
    expect(result.victims[0]).toMatchObject({ outcome: "compound", remainingCandidates: [A, B, C, D] });
  });

  test("probe cap is shared across victims and reported", async () => {
    const W = id("W");
    const { runner, probes } = fakeRunner("V", [["A"]]);
    const result = await bisectPolluters({
      victims: [{ ...V, candidatePolluters: [A, B, C, D, E, F] }, { ...W, candidatePolluters: [A] }],
      runner,
      maxProbes: 2,
    });
    expect(probes.length).toBe(2);
    expect(result.capped).toBe(true);
    expect(result.victims[0]!.outcome).toBe("capped");
    expect(result.victims[0]!.remainingCandidates).toEqual([A, B, C]);
    expect(result.victims[1]).toMatchObject({ outcome: "capped", remainingCandidates: [A], probes: 0 });
  });

  test("inconclusive when the victim has no passed/failed result in a probe", async () => {
    const runner: OrderRunner = async () => [];
    const result = await bisectPolluters({ victims: [{ ...V, candidatePolluters: [A] }], runner });
    expect(result.victims[0]).toMatchObject({ outcome: "inconclusive", remainingCandidates: [A], probes: 1 });
  });

  test("rejects a non-positive or non-integer cap", async () => {
    const { runner } = fakeRunner("V", []);
    await expect(bisectPolluters({ victims: [], runner, maxProbes: 0 })).rejects.toThrow(RangeError);
    await expect(bisectPolluters({ victims: [], runner, maxProbes: 1.5 })).rejects.toThrow(RangeError);
  });
});
