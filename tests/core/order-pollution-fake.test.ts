import { describe, expect, test } from "bun:test";
import { TestRunnerClient } from "../../src/core/hubs/test-runner-hub";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import type { CodeunitTestGroup, ConnectionConfig } from "../../src/core/types";
import { fakeHubFactory } from "../fakes/fake-hub";
import { orderPollutionHub, POLLUTION_CODEUNIT as CU } from "../fakes/order-pollution-hub";

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

  test("same codeunit twice on one connection kills the hub mid-group", async () => {
    const r = await run([
      { id: CU, methods: ["PolluterCommitsCustomer"] },
      { id: CU, methods: ["VictimInsertsSameCustomer"] },
    ]);
    expect(r.runAborted).toBe(true);
    expect(r.results.map((t) => t.method)).toEqual(["PolluterCommitsCustomer"]);
  });
});
