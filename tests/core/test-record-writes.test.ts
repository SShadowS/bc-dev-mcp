import { describe, expect, test } from "bun:test";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import type { HubFactory } from "../../src/core/hubs/signalr-base";
import { findTestMethodFrame, runTestsWithRecordWrites } from "../../src/core/test-record-writes";
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
