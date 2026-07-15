import { describe, expect, test } from "bun:test";
import { DebuggerClient, type DebugAttachOptions } from "../../src/core/hubs/debugger-hub";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import type { ConnectionConfig, DebuggerEvent } from "../../src/core/types";
import { FakeHub, fakeHubFactory } from "../fakes/fake-hub";

const config: ConnectionConfig = {
  environmentType: "OnPrem",
  authentication: "UserPassword",
  server: "http://localhost",
  serverInstance: "BC",
  username: "u",
  password: "p",
};
const auth = new BasicAuthorizationProvider("u", "p");

async function connected(hub: FakeHub, opts: DebugAttachOptions = { breakOnError: true }): Promise<{ client: DebuggerClient; events: DebuggerEvent[] }> {
  const client = new DebuggerClient(fakeHubFactory(hub));
  const events: DebuggerEvent[] = [];
  client.onEvent = (e) => events.push(e);
  await client.connect(config, auth, opts);
  return { client, events };
}

describe("DebuggerClient", () => {
  test("connect attaches; configuration sent after session binds", async () => {
    const hub = new FakeHub();
    const { client } = await connected(hub);
    expect(hub.url).toBe("http://localhost:7049/BC/dev/DebuggerHub");
    expect(hub.opts?.queryParams["Authentication"]).toBe(hub.opts?.authHeader);
    expect(hub.invoked("Attach")[0]?.args[0]).toEqual({ BreakOnNextClient: 1, SessionId: -1, UserId: null });
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

  test("user targeting trims UserId and keeps break-on-next client selection", async () => {
    const hub = new FakeHub();
    await connected(hub, { userId: "  alice@example.com  ", breakOnNext: "Background" });
    expect(hub.invoked("Attach")[0]?.args[0]).toEqual({
      BreakOnNextClient: 2,
      SessionId: -1,
      UserId: "alice@example.com",
    });
  });

  test("exact-session targeting sends the positive id and null user", async () => {
    const hub = new FakeHub();
    await connected(hub, { sessionId: 43210, breakOnNext: "WebServiceClient" });
    expect(hub.invoked("Attach")[0]?.args[0]).toEqual({
      BreakOnNextClient: 0,
      SessionId: 43210,
      UserId: null,
    });
  });

  test("an exact session can bind before Attach resolves", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "Attach") hub.emit("HubConnected");
      if (method === "GetNstSessionInfo") {
        return { SessionId: 43210, HostId: "11111111-1111-1111-1111-111111111111" };
      }
      return undefined;
    };
    const { events } = await connected(hub, { sessionId: 43210 });
    await Bun.sleep(0);
    expect(hub.invoked("DebugAdapterConfigurationDone")).toHaveLength(1);
    expect(events).toEqual([
      {
        kind: "sessionBound",
        sessionId: 43210,
        hostId: "11111111-1111-1111-1111-111111111111",
      },
    ]);
  });

  test("rejects invalid targeting before starting or invoking the hub", async () => {
    const invalid: DebugAttachOptions[] = [
      { sessionId: 1, userId: "alice" },
      { sessionId: 0 },
      { sessionId: -1 },
      { sessionId: 1.5 },
      { sessionId: Number.NaN },
      { sessionId: Number.POSITIVE_INFINITY },
      { userId: "   " },
    ];
    for (const opts of invalid) {
      const hub = new FakeHub();
      const client = new DebuggerClient(fakeHubFactory(hub));
      await expect(client.connect(config, auth, opts)).rejects.toThrow(/mutually exclusive|positive integer|nonblank/);
      expect(hub.started).toBe(false);
      expect(hub.invoked("Attach")).toHaveLength(0);
    }
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

  for (const [name, callbacks] of [
    ["HubConnected first", ["HubConnected", "OnAttachedToConnection"]],
    ["OnAttachedToConnection first", ["OnAttachedToConnection", "HubConnected"]],
  ] as const) {
    test(`reports normalized session identity once when ${name}`, async () => {
      const hub = new FakeHub();
      hub.onInvoke = (method) =>
        method === "GetNstSessionInfo"
          ? { SessionId: 43210, HostId: "11111111-1111-1111-1111-111111111111" }
          : undefined;
      const { events } = await connected(hub);
      hub.emit(callbacks[0]);
      hub.emit(callbacks[1]);
      await Bun.sleep(0);
      expect(hub.invoked("DebugAdapterConfigurationDone")).toHaveLength(1);
      expect(hub.invoked("GetNstSessionInfo")).toEqual([{ method: "GetNstSessionInfo", args: [] }]);
      expect(events).toEqual([
        {
          kind: "sessionBound",
          sessionId: 43210,
          hostId: "11111111-1111-1111-1111-111111111111",
        },
      ]);
    });
  }

  test("session-info lookup failure is redacted, nonfatal, and not retried", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "GetNstSessionInfo") {
        throw new Error("lookup failed at https://bc/dev?Authentication=Bearer%20secret-token&tenant=default");
      }
      return undefined;
    };
    const { client, events } = await connected(hub);
    hub.emit("HubConnected");
    hub.emit("OnAttachedToConnection");
    await Bun.sleep(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "sessionBound", sessionId: null, hostId: null });
    expect((events[0] as { warning: string }).warning).toContain("[REDACTED]");
    expect((events[0] as { warning: string }).warning).not.toContain("secret-token");
    expect(hub.invoked("GetNstSessionInfo")).toHaveLength(1);
    await client.step("continue");
    expect(hub.invoked("SetBreakpointResponse")).toHaveLength(1);
  });

  test("malformed session-info response produces a warning without disconnecting", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => (method === "GetNstSessionInfo" ? { SessionId: 0, HostId: "" } : undefined);
    const { client, events } = await connected(hub);
    hub.emit("HubConnected");
    await Bun.sleep(0);
    expect(events).toEqual([
      {
        kind: "sessionBound",
        sessionId: null,
        hostId: null,
        warning: "Debugger bound, but NST session identity could not be read: Business Central returned an invalid NST session id",
      },
    ]);
    await client.step("continue");
    expect(hub.invoked("SetBreakpointResponse")).toHaveLength(1);
  });

  test("preserves a valid session id when the optional host id is absent", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => (method === "GetNstSessionInfo" ? { SessionId: 43210, HostId: null } : undefined);
    const { events } = await connected(hub);
    hub.emit("HubConnected");
    await Bun.sleep(0);
    expect(events).toEqual([{ kind: "sessionBound", sessionId: 43210, hostId: null }]);
  });

  test("an unknown user fatal before binding tears down without session or break events", async () => {
    const hub = new FakeHub();
    const { client, events } = await connected(hub, { userId: "ghost-user" });
    hub.emit("OnFatalDebuggerException", "The user specified in your launch.json file cannot be found on the tenant.");
    await Bun.sleep(0);
    await Bun.sleep(0);
    hub.emit("HubConnected");
    hub.emit("Break", { ObjectType: 5, ObjectNumber: 50100 }, [], "should not be delivered");
    await Bun.sleep(0);
    expect(events).toEqual([
      {
        kind: "fatal",
        message: expect.stringContaining("user-filtered session"),
      },
    ]);
    expect(events.some((event) => event.kind === "sessionBound" || event.kind === "break")).toBe(false);
    expect(hub.invoked("StopDebugging")).toHaveLength(1);
    expect(hub.stopped).toBe(true);
    expect(client.connectionId).toBeNull();
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
    await expect(client.connect(config, auth, {})).rejects.toThrow("attach denied");
    expect(hub.stopped).toBe(true);
    expect(client.connectionId).toBeNull();
  });

  test("unavailable exact session rolls back with actionable redacted detail", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "Attach") {
        throw new Error("not found at https://bc/dev?Authentication=Bearer%20secret-token&tenant=default");
      }
      return undefined;
    };
    const client = new DebuggerClient(fakeHubFactory(hub));
    let message = "";
    try {
      await client.connect(config, auth, { sessionId: 43210 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Unable to attach to NST session 43210");
    expect(message).toContain("active and accessible");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("secret-token");
    expect(hub.stopped).toBe(true);
    expect(client.connectionId).toBeNull();
  });

  test("fatal signalled during exact Attach is converted to attach rollback", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "Attach") {
        hub.emit("OnFatalDebuggerException", "session unavailable?Authentication=Bearer%20secret-token&tenant=default");
      }
      return undefined;
    };
    const client = new DebuggerClient(fakeHubFactory(hub));
    const events: DebuggerEvent[] = [];
    client.onEvent = (event) => events.push(event);
    let message = "";
    try {
      await client.connect(config, auth, { sessionId: 43210 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Unable to attach to NST session 43210");
    expect(message).toContain("active and accessible");
    expect(message).not.toContain("secret-token");
    expect(events).toEqual([]);
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
