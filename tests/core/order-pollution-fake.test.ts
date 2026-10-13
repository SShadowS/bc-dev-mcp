import { describe, expect, test } from "bun:test";
import { TestRunnerClient } from "../../src/core/hubs/test-runner-hub";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import type { CodeunitTestGroup, ConnectionConfig } from "../../src/core/types";
import { fakeHubFactory } from "../fakes/fake-hub";
import { orderPollutionHub, POLLUTION_CODEUNIT as CU, POLLUTION_METHODS } from "../fakes/order-pollution-hub";
import { analyzeTestOrder } from "../../src/core/test-order-analysis";
import { bisectPolluters, type OrderRunner } from "../../src/core/test-order-bisect";
import { planTestOrder } from "../../src/core/test-order-plan";

const config: ConnectionConfig = {
  environmentType: "OnPrem",
  authentication: "UserPassword",
  server: "http://localhost",
  serverInstance: "BC",
  username: "u",
  password: "p",
};

async function run(plan: CodeunitTestGroup[]) {
  return new TestRunnerClient(fakeHubFactory(orderPollutionHub())).run(config, new BasicAuthorizationProvider("u", "p"), plan);
}

const failed = (r: Awaited<ReturnType<typeof run>>) => r.results.filter((t) => t.status === "failed").map((t) => t.method);

describe("order-pollution demo FakeHub script", () => {
  test("full group: both victims fail after their polluters", async () => {
    const r = await run([{ id: CU }]);
    expect(r.results).toHaveLength(8);
    expect(failed(r)).toEqual(["VictimInsertsSameCustomer", "VictimExpectsNoFlag"]);
  });

  test("each victim passes in isolation", async () => {
    expect(failed(await run([{ id: CU, methods: ["VictimInsertsSameCustomer"] }]))).toEqual([]);
    expect(failed(await run([{ id: CU, methods: ["VictimExpectsNoFlag"] }]))).toEqual([]);
  });

  test("minimal polluter pairs reproduce, cross pairs do not", async () => {
    expect(failed(await run([{ id: CU, methods: ["PolluterCommitsCustomer", "VictimInsertsSameCustomer"] }]))).toEqual([
      "VictimInsertsSameCustomer",
    ]);
    expect(failed(await run([{ id: CU, methods: ["PolluterCommitsFlag", "VictimExpectsNoFlag"] }]))).toEqual([
      "VictimExpectsNoFlag",
    ]);
    expect(failed(await run([{ id: CU, methods: ["PolluterCommitsCustomer", "VictimExpectsNoFlag"] }]))).toEqual([]);
    expect(failed(await run([{ id: CU, methods: ["PolluterCommitsFlag", "VictimInsertsSameCustomer"] }]))).toEqual([]);
  });

  test("testMethods[] order is ignored: victim-first still runs in declaration order", async () => {
    const r = await run([{ id: CU, methods: ["VictimInsertsSameCustomer", "PolluterCommitsCustomer"] }]);
    expect(r.results.map((t) => t.method)).toEqual(["PolluterCommitsCustomer", "VictimInsertsSameCustomer"]);
    expect(failed(r)).toEqual(["VictimInsertsSameCustomer"]);
  });

  test("no-pollution selection reports zero failures", async () => {
    const clean = ["IndependentArithmetic", "IndependentCompanyName", "IndependentRolledBackWrite", "IndependentLast"];
    const r = await run([{ id: CU, methods: clean }]);
    expect(r.results).toHaveLength(4);
    expect(failed(r)).toEqual([]);
  });

  test("same codeunit twice on one connection: second group runs rolled-back, then the hub dies", async () => {
    const r = await run([
      { id: CU, methods: ["PolluterCommitsCustomer"] },
      { id: CU, methods: ["VictimInsertsSameCustomer"] },
    ]);
    expect(r.runAborted).toBe(true);
    expect(r.results.map((t) => t.method)).toEqual(["PolluterCommitsCustomer", "VictimInsertsSameCustomer"]);
    expect(failed(r)).toEqual([]);
  });
});

describe("order mode end to end against the demo FakeHub (planner + analysis + bisect)", () => {
  const ALL = POLLUTION_METHODS.map((m) => ({ codeunitId: CU, method: m.name }));
  // One Initialize (fresh hub) per plan.
  const runner: OrderRunner = async (plan) =>
    (await run(plan.groups)).results
      .filter((t) => t.method !== "")
      .map((t) => ({ codeunitId: t.codeunitId, method: t.method, status: t.status === "passed" ? "passed" : "failed" }));

  async function orderMode(selection: typeof ALL) {
    const isolation = (await Promise.all(selection.map((m) => runner(planTestOrder([m], { mode: "recorded" }))))).flat();
    const plans = [
      planTestOrder(selection, { mode: "recorded" }),
      planTestOrder(selection, { mode: "reversed" }),
      ...[1, 2, 3].map((seed) => planTestOrder(selection, { mode: "shuffle", seed })),
    ];
    const runs = await Promise.all(plans.map(async (plan) => ({ plan, results: await runner(plan) })));
    return analyzeTestOrder({ isolation, runs });
  }

  test("finds both od-victims and bisects each to its single polluter", async () => {
    const analysis = await orderMode(ALL);
    const victims = analysis.tests.filter((t) => t.classification === "odVictim");
    expect(victims.map((v) => v.method)).toEqual(["VictimInsertsSameCustomer", "VictimExpectsNoFlag"]);
    const bisect = await bisectPolluters({ victims, runner });
    expect(bisect.victims.map((v) => [v.method, v.outcome, v.polluter?.method])).toEqual([
      ["VictimInsertsSameCustomer", "found", "PolluterCommitsCustomer"],
      ["VictimExpectsNoFlag", "found", "PolluterCommitsFlag"],
    ]);
  });

  test("no-pollution selection reports zero od-victims across 3 seeds", async () => {
    const clean = ALL.filter((m) => m.method.startsWith("Independent"));
    expect((await orderMode(clean)).summary.odVictim).toBe(0);
  });
});
