import { describe, expect, test } from "bun:test";
import { BcDevError } from "../../src/core/agent-errors";
import type { TestCodeunitInfo } from "../../src/core/al-objects";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import { TestRunnerClient } from "../../src/core/hubs/test-runner-hub";
import { expandOrderSelection, runOrderMode } from "../../src/core/test-order-mode";
import type { CodeunitTestGroup, ConnectionConfig } from "../../src/core/types";
import { fakeHubFactory } from "../fakes/fake-hub";
import { orderPollutionHub, POLLUTION_CODEUNIT as CU, POLLUTION_METHODS } from "../fakes/order-pollution-hub";

const config: ConnectionConfig = {
  environmentType: "OnPrem", authentication: "UserPassword", server: "http://localhost", serverInstance: "BC", username: "u", password: "p",
};
const execute = (groups: CodeunitTestGroup[]) =>
  new TestRunnerClient(fakeHubFactory(orderPollutionHub())).run(config, new BasicAuthorizationProvider("u", "p"), groups);

const discovered: TestCodeunitInfo[] = [{
  codeunitId: CU,
  name: "Order Pollution Tests",
  file: "x.al",
  testPermissions: "Disabled",
  methods: POLLUTION_METHODS.map((m) => m.name),
  methodDetails: POLLUTION_METHODS.map((m) => ({ name: m.name, transactionModel: m.pollutes ? "AutoCommit" : "AutoRollback", testPermissions: "Disabled", attributes: ["Test"] })),
}];

describe("expandOrderSelection", () => {
  test("expands to declaration order with declared spelling and TransactionModel", () => {
    const sel = expandOrderSelection([{ id: CU, methods: ["victiminsertssamecustomer", "PolluterCommitsCustomer"] }], discovered);
    expect(sel).toEqual([
      { codeunitId: CU, method: "PolluterCommitsCustomer", transactionModel: "AutoCommit" },
      { codeunitId: CU, method: "VictimInsertsSameCustomer", transactionModel: "AutoRollback" },
    ]);
    expect(expandOrderSelection([{ id: CU }], discovered)).toHaveLength(8);
  });

  test("rejects unknown codeunits, unknown methods and repeated codeunits with structured errors", () => {
    const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as BcDevError).code; } return null; };
    expect(code(() => expandOrderSelection([{ id: 1 }], discovered))).toBe("NOT_FOUND");
    expect(code(() => expandOrderSelection([{ id: CU, methods: ["Nope"] }], discovered))).toBe("INVALID_ARGUMENT");
    expect(code(() => expandOrderSelection([{ id: CU }, { id: CU }], discovered))).toBe("INVALID_ARGUMENT");
  });
});

describe("runOrderMode against the order-pollution FakeHub", () => {
  test("3 seeds: finds both victims, names each polluter, deterministic per seed", async () => {
    const selection = expandOrderSelection([{ id: CU }], discovered);
    const a = await runOrderMode({ selection, seeds: [1, 2, 3], execute });
    expect(a.bisection.victims.map((v) => [v.method, v.outcome, v.polluter?.method])).toEqual([
      ["VictimInsertsSameCustomer", "found", "PolluterCommitsCustomer"],
      ["VictimExpectsNoFlag", "found", "PolluterCommitsFlag"],
    ]);
    expect(a.complete).toBe(true);
    expect(a.firstFailureOutput.size).toBe(2);
    const b = await runOrderMode({ selection, seeds: [1, 2, 3], execute });
    expect(b.analysis).toEqual(a.analysis);
    expect(b.bisection).toEqual(a.bisection);
  });

  test("no-pollution selection: zero od-victims across 3 seeds", async () => {
    const clean = POLLUTION_METHODS.filter((m) => m.name.startsWith("Independent")).map((m) => m.name);
    const r = await runOrderMode({ selection: expandOrderSelection([{ id: CU, methods: clean }], discovered), seeds: [1, 2, 3], execute });
    expect(r.analysis.summary.odVictim).toBe(0);
    expect(r.bisection.victims).toEqual([]);
  });

  test("an aborted Initialize halts every later one and marks the result incomplete", async () => {
    let calls = 0;
    const r = await runOrderMode({
      selection: expandOrderSelection([{ id: CU, methods: ["IndependentArithmetic", "IndependentLast"] }], discovered),
      seeds: [1],
      execute: async () => (calls++, { results: [], runAborted: true, abortReason: "hub closed" }),
    });
    expect(calls).toBe(1);
    expect(r.initializes).toBe(1);
    expect(r.complete).toBe(false);
    expect(r.warnings[0]).toContain("hub closed");
  });
});
