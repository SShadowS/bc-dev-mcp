import { describe, expect, test } from "bun:test";
import { DebuggerClient } from "../../src/core/hubs/debugger-hub";
import type { ConnectionConfig, DebuggerEvent } from "../../src/core/types";
import { FakeHub, fakeHubFactory } from "../fakes/fake-hub";

const config: ConnectionConfig = {
  server: "http://localhost",
  serverInstance: "BC",
  username: "u",
  password: "p",
};

async function connected(hub: FakeHub): Promise<{ client: DebuggerClient; events: DebuggerEvent[] }> {
  const client = new DebuggerClient(fakeHubFactory(hub));
  const events: DebuggerEvent[] = [];
  client.onEvent = (e) => events.push(e);
  await client.connect(config, { breakOnError: true });
  return { client, events };
}

describe("DebuggerClient", () => {
  test("connect attaches; configuration sent after session binds", async () => {
    const hub = new FakeHub();
    const { client } = await connected(hub);
    expect(hub.url).toBe("http://localhost:7049/BC/dev/DebuggerHub");
    expect(hub.invoked("Attach")[0]?.args[0]).toMatchObject({ BreakOnNextClient: 1, SessionId: -1 });
    expect(hub.invoked("DebugAdapterConfigurationDone")).toHaveLength(0);

    hub.emit("OnAttachedToConnection");
    await Bun.sleep(0);
    expect(hub.invoked("DebugAdapterConfigurationDone")).toHaveLength(1);
    expect(hub.invoked("DebugAdapterConfigurationDone")[0]?.args[0]).toMatchObject({
      BreakOnError: true,
      SkipSystemTriggers: true,
    });
    expect(client.connectionId).toBe("fake-conn-1");

    // A second session-bind notification must not re-send configuration.
    hub.emit("OnAttachedToConnection");
    await Bun.sleep(0);
    expect(hub.invoked("DebugAdapterConfigurationDone")).toHaveLength(1);
  });

  test("HubConnected also binds the session (BC28 live E2E round 4)", async () => {
    const hub = new FakeHub();
    const { client } = await connected(hub);
    expect(hub.invoked("DebugAdapterConfigurationDone")).toHaveLength(0);

    hub.emit("HubConnected");
    await Bun.sleep(0);
    expect(hub.invoked("DebugAdapterConfigurationDone")).toHaveLength(1);
    expect(hub.invoked("DebugAdapterConfigurationDone")[0]?.args[0]).toMatchObject({
      BreakOnError: true,
      SkipSystemTriggers: true,
    });
    expect(client.connectionId).toBe("fake-conn-1");

    // OnAttachedToConnection firing afterwards (or on a build that sends both) must not re-send.
    hub.emit("OnAttachedToConnection");
    await Bun.sleep(0);
    expect(hub.invoked("DebugAdapterConfigurationDone")).toHaveLength(1);
  });

  test("auto-acks IsAlive", async () => {
    const hub = new FakeHub();
    await connected(hub);
    hub.emit("IsAlive");
    await Bun.sleep(0);
    expect(hub.invoked("AcknowledgeIsAlive")).toHaveLength(1);
  });

  test("normalizes Break into event with stack", async () => {
    const hub = new FakeHub();
    const { events } = await connected(hub);
    hub.emit(
      "Break",
      { ObjectType: 5, ObjectNumber: 50100 },
      [
        {
          ObjectId: { ObjectType: 5, ObjectNumber: 50100 },
          ObjectName: "My Tests",
          MethodName: "PostInvoice",
          StatementSpan: { From: { Line: 12, Column: 4 }, To: { Line: 12, Column: 30 } },
        },
      ],
      "",
    );
    expect(events).toEqual([
      {
        kind: "break",
        objectType: 5,
        objectId: 50100,
        errorMessage: undefined,
        line: 13,
        stack: [{ objectType: 5, objectId: 50100, objectName: "My Tests", methodName: "PostInvoice", line: 13 }],
      },
    ]);
  });

  test("queues detach and fatal events", async () => {
    const hub = new FakeHub();
    const { events } = await connected(hub);
    hub.emit("OnDetachedFromConnection", true);
    hub.emit("OnFatalDebuggerException", "boom");
    expect(events).toEqual([
      { kind: "detached", terminateSession: true },
      { kind: "fatal", message: "boom" },
    ]);
  });

  test("addBreakpoint sends wire shape and returns id; step maps enum", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => (method === "AddBreakpoint" ? { BreakpointId: 42 } : undefined);
    const { client } = await connected(hub);
    const id = await client.addBreakpoint(5, 50100, 12, "x > 1");
    expect(id).toBe(42);
    expect(hub.invoked("AddBreakpoint")[0]?.args).toEqual([
      { ObjectType: 5, ObjectNumber: 50100 },
      { Line: 11, Column: 0 },
      "x > 1",
    ]);
    await client.step("stepOver");
    expect(hub.invoked("SetBreakpointResponse")[0]?.args).toEqual([1]);
  });

  test("addBreakpoint sends 0-based wire line for editor line 1", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => (method === "AddBreakpoint" ? { BreakpointId: 1 } : undefined);
    const { client } = await connected(hub);
    await client.addBreakpoint(5, 1, 1);
    expect(hub.invoked("AddBreakpoint")[0]?.args).toEqual([
      { ObjectType: 5, ObjectNumber: 1 },
      { Line: 0, Column: 0 },
      "",
    ]);
  });

  test("getVariables normalizes LocalNode payload", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) =>
      method === "GetVariables"
        ? [{ Name: "Rec", TypeName: "Record", Summary: "Customer 10000", HasChildren: true, Children: null }]
        : undefined;
    const { client } = await connected(hub);
    expect(await client.getVariables(0)).toEqual([
      { name: "Rec", typeName: "Record", summary: "Customer 10000", hasChildren: true, children: undefined },
    ]);
  });

  test("getVariables coerces null typeName/summary to empty strings", async () => {
    // Live BC28: a RecordRef's synthetic "Fields" node arrives with typeName null.
    const hub = new FakeHub();
    hub.onInvoke = (method) =>
      method === "GetVariables"
        ? [{ Name: "Fields", TypeName: null, Summary: null, HasChildren: true, Children: [] }]
        : undefined;
    const { client } = await connected(hub);
    expect(await client.getVariables(0)).toEqual([
      { name: "Fields", typeName: "", summary: "", hasChildren: true, children: [] },
    ]);
  });

  test("addBreakpoint rejects when the server response has no breakpoint id", async () => {
    const hub = new FakeHub();
    // hub.onInvoke left unset — invoke("AddBreakpoint", ...) resolves to undefined.
    const { client } = await connected(hub);
    await expect(client.addBreakpoint(5, 1, 1)).rejects.toThrow(/breakpoint id/);
  });

  test("connect cleans up when Attach rejects", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "Attach") throw new Error("attach denied");
      return undefined;
    };
    const client = new DebuggerClient(fakeHubFactory(hub));
    await expect(client.connect(config, {})).rejects.toThrow("attach denied");
    expect(hub.stopped).toBe(true);
    expect(client.connectionId).toBeNull();
  });

  test("unexpected close clears the hub so calls fail fast", async () => {
    const hub = new FakeHub();
    const { client } = await connected(hub);
    hub.close(new Error("dropped"));
    await expect(client.step("continue")).rejects.toThrow(/not connected/);
  });
});
