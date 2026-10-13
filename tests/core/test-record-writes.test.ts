import { describe, expect, test } from "bun:test";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import type { HubFactory } from "../../src/core/hubs/signalr-base";
import type { BisectedVictim } from "../../src/core/test-order-bisect";
import { attributePolluterWrites, findTestMethodFrame, runTestsWithRecordWrites, type TestRunRecordWrites } from "../../src/core/test-record-writes";
import type { ConnectionConfig } from "../../src/core/types";
import { FakeHub } from "../fakes/fake-hub";

const config: ConnectionConfig = {
  environmentType: "OnPrem",
  authentication: "UserPassword",
  server: "http://localhost",
  serverInstance: "BC",
  username: "u",
  password: "p",
};
const auth = new BasicAuthorizationProvider("u", "p");

const SOURCE = [
  'codeunit 50100 "Writer Test"',
  "{",
  "    Subtype = Test;",
  "    [Test]",
  "    procedure TestWrite()",
  "    var Customer: Record Customer;",
  "    begin",
  "        Customer.Insert();",
  "    end;",
  "}",
].join("\n");

const WIRE_STACK = [
  {
    ObjectId: { ObjectType: 5, ObjectNumber: 50100 },
    ObjectName: "Writer Test",
    MethodName: "TestWrite",
    StatementSpan: { From: { Line: 7, Column: 8 }, To: { Line: 7, Column: 25 } },
  },
  {
    ObjectId: { ObjectType: 5, ObjectNumber: 130450 },
    ObjectName: "Test Runner - Isol. Codeunit",
    MethodName: "OnRun",
    StatementSpan: { From: { Line: 20, Column: 8 }, To: { Line: 20, Column: 30 } },
  },
];

function hubs() {
  const debuggerHub = new FakeHub();
  const runnerHub = new FakeHub();
  debuggerHub.connectionId = "dbg-7";
  const factory: HubFactory = (url) => (url.endsWith("/DebuggerHub") ? debuggerHub : runnerHub);
  debuggerHub.onInvoke = (method, args) => {
    if (method === "Attach") queueMicrotask(() => debuggerHub.emit("HubConnected"));
    if (method === "GetNstSessionInfo") return { SessionId: 9, HostId: "h" };
    if (method === "GetSourceContent") return { Content: SOURCE, IsALContent: true };
    if (method === "GetWatchNode") return { Name: "Customer", TypeName: "Table Customer (18)", Summary: "", HasChildren: true };
    if (method === "SetBreakpointResponse" && args[0] === 0) {
      queueMicrotask(() => {
        runnerHub.emit("TestCompleted", 50100, "TestWrite", 0, "", 5);
        runnerHub.emit("TestRunCompleted", { Tests: [] });
      });
    }
    return undefined;
  };
  runnerHub.onInvoke = (method) => {
    if (method === "RunTests") queueMicrotask(() => debuggerHub.emit("Break", { ObjectType: 5, ObjectNumber: 50100 }, WIRE_STACK, null));
    return undefined;
  };
  return { debuggerHub, runnerHub, factory };
}

describe("runTestsWithRecordWrites", () => {
  test("binds the test run to the collector connection and returns writers with test-method frames", async () => {
    const { debuggerHub, runnerHub, factory } = hubs();
    const result = await runTestsWithRecordWrites({
      hubFactory: factory,
      config,
      authorization: auth,
      plan: [{ id: 50100 }],
      tableId: 18,
      localSource: async () => null,
      localFile: () => undefined,
    });

    expect(runnerHub.invoked("Initialize")[0]?.args).toEqual(["", "dbg-7", 0]);
    expect(debuggerHub.invoked("DebugAdapterConfigurationDone")[0]?.args[0]).toMatchObject({
      BreakOnError: false,
      BreakOnRecordWrite: true,
      BreakOnRecordWriteBehaviour: 3,
    });
    expect(result.testRun.results).toEqual([
      { codeunitId: 50100, method: "TestWrite", status: "passed", durationMs: 5, output: "" },
    ]);
    expect(result.writes.outcome).toBe("completed");
    expect(result.writes.complete).toBe(true);
    expect(result.writes.target).toEqual({ tableId: 18, tableName: "Customer" });
    expect(result.writes.writers).toHaveLength(1);
    expect(result.writes.writers[0]).toMatchObject({
      operation: "insert",
      receiver: "Customer",
      count: 1,
      testMethod: { codeunitId: 50100, method: "TestWrite", frameIndex: 0 },
    });
    expect(debuggerHub.invoked("StopDebugging").length).toBeGreaterThan(0);
  });

  test("still finishes the capture when the test run fails to start", async () => {
    const { debuggerHub, runnerHub, factory } = hubs();
    runnerHub.start = async () => {
      throw new Error("negotiate 401");
    };
    const result = await runTestsWithRecordWrites({
      hubFactory: factory,
      config,
      authorization: auth,
      plan: [{ id: 50100 }],
      tableId: 18,
      localSource: async () => null,
      localFile: () => undefined,
    });
    expect(result.testRun.runAborted).toBe(true);
    expect(result.writes.writers).toEqual([]);
    expect(debuggerHub.invoked("StopDebugging").length).toBeGreaterThan(0);
  });
});

describe("findTestMethodFrame", () => {
  const frame = (objectId: number, methodName: string, objectType = 5) => ({
    objectType,
    objectId,
    objectName: "",
    methodName,
    line: 1,
  });

  test("picks the outermost planned-codeunit frame, skipping helpers above and the runner below", () => {
    const stack = [frame(18, "OnInsert", 1), frame(50100, "CreateCustomer"), frame(50100, "TestWrite"), frame(130450, "OnRun")];
    expect(findTestMethodFrame(stack, [{ id: 50100 }])).toEqual({ codeunitId: 50100, method: "TestWrite", frameIndex: 2 });
  });

  test("returns null when no frame belongs to a planned codeunit", () => {
    expect(findTestMethodFrame([frame(50200, "Other"), frame(130450, "OnRun")], [{ id: 50100 }])).toBeNull();
  });
});

describe("attributePolluterWrites", () => {
  const stackFor = (codeunitId: number, method: string) => [
    { objectType: 1, objectId: 18, objectName: "Customer", methodName: "OnInsert", line: 1 },
    { objectType: 5, objectId: codeunitId, objectName: "", methodName: method, line: 3 },
  ];
  const writer = (codeunitId: number, method: string, count = 1) => ({
    operation: "insert" as const,
    receiver: "Customer",
    count,
    firstSequence: 1,
    lastSequence: count,
    source: "deployed" as const,
    stack: stackFor(codeunitId, method),
    testMethod: { codeunitId, method, frameIndex: 1 },
  });
  const writes = (over: Partial<TestRunRecordWrites["writes"]> = {}): TestRunRecordWrites["writes"] => ({
    target: { tableId: 18, tableName: "Customer" },
    outcome: "completed",
    stopReason: "finished",
    complete: true,
    truncated: false,
    summary: { observedWrites: 3, matchedWrites: 3, uniqueWriters: 2, unrelatedWrites: 0, unresolvedWrites: 0 },
    strayBinds: 0,
    rearms: 0,
    writers: [writer(50100, "Polluter", 2), writer(50101, "Other"), { ...writer(50102, "X"), testMethod: null }],
    unresolved: [],
    warnings: [],
    ...over,
  });
  const victim = (outcome: BisectedVictim["outcome"], remaining: { codeunitId: number; method: string }[]): BisectedVictim => ({
    codeunitId: 50100,
    method: "Victim",
    outcome,
    ...(outcome === "found" ? { polluter: remaining[0] } : {}),
    remainingCandidates: remaining,
    probes: 2,
  });

  test("found polluter gets its observed writes; never claims commit", () => {
    const [row] = attributePolluterWrites([victim("found", [{ codeunitId: 50100, method: "polluter" }])], writes());
    expect(row).toMatchObject({
      codeunitId: 50100,
      method: "Victim",
      outcome: "found",
      table: { tableId: 18, tableName: "Customer" },
      captureComplete: true,
      unattributedWriteGroups: 1,
      suspects: [{ codeunitId: 50100, method: "polluter", evidence: "writeObserved", writes: [{ operation: "insert", receiver: "Customer", count: 2, source: "deployed" }] }],
    });
    expect(JSON.stringify({ ...row, note: undefined })).not.toMatch(/commit/i);
    expect(row!.note).toMatch(/not.*commit/i);
  });

  test("unresolved candidates: noWriteObserved on a complete capture, unknown on an incomplete one", () => {
    const v = victim("compound", [{ codeunitId: 50101, method: "Other" }, { codeunitId: 50103, method: "Quiet" }]);
    expect(attributePolluterWrites([v], writes())[0]!.suspects.map((s) => s.evidence)).toEqual(["writeObserved", "noWriteObserved"]);
    const partial = writes({ complete: false, truncated: true, outcome: "truncated" });
    const row = attributePolluterWrites([v], partial)[0]!;
    expect(row.captureComplete).toBe(false);
    expect(row.suspects.map((s) => s.evidence)).toEqual(["writeObserved", "unknown"]);
  });

  test("unresolved write groups bound to a suspect count as writeObserved", () => {
    const unresolved = [{ reason: "receiverUnavailable" as const, operation: "modify" as const, receiver: null, count: 4, firstSequence: 5, lastSequence: 8, stack: stackFor(50103, "Quiet"), testMethod: { codeunitId: 50103, method: "Quiet", frameIndex: 1 } }];
    const row = attributePolluterWrites([victim("found", [{ codeunitId: 50103, method: "Quiet" }])], writes({ unresolved }))[0]!;
    expect(row.suspects[0]).toMatchObject({ evidence: "writeObserved", writes: [], unresolvedWrites: 4 });
  });
});
