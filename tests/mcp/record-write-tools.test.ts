import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorizationProviderFactory } from "../../src/core/authorization";
import type { GitChangeSet } from "../../src/core/git-changes";
import { ServerState } from "../../src/mcp/state";
import { createTools, type ToolDeps } from "../../src/mcp/tools";
import { FakeHub, fakeHubFactory } from "../fakes/fake-hub";

const SOURCE = [
  "codeunit 50100 Writer",
  "{",
  "    procedure Run()",
  "    var",
  "        Customer: Record Customer;",
  "    begin",
  "        Customer.Modify(true);",
  "    end;",
  "}",
].join("\n");

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "bcmcp-record-writes-"));
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(
    join(dir, ".vscode", "launch.json"),
    JSON.stringify({ configurations: [{ type: "al", request: "launch", server: "http://localhost", serverInstance: "BC" }] }),
  );
  writeFileSync(join(dir, "app.json"), JSON.stringify({ runtime: "16.0" }));
  writeFileSync(join(dir, "Writer.Codeunit.al"), SOURCE);
  return dir;
}

function setup(hub: FakeHub) {
  const state = new ServerState();
  const deps: ToolDeps = {
    hubFactory: fakeHubFactory(hub),
    authorizationFactory: createAuthorizationProviderFactory(),
    fetchFn: (async () => new Response(JSON.stringify({ WebApiVersion: "7.0" }))) as unknown as typeof fetch,
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" },
    cwd: project(),
    gitChanges: async (_project, baseRef): Promise<GitChangeSet> => ({
      baseRef,
      mergeBase: "a".repeat(40),
      head: "workingTree",
      files: [],
    }),
  };
  return {
    state,
    tools: new Map(createTools(state, deps).map((tool) => [tool.name, tool])),
  };
}

function emitWrite(hub: FakeHub): void {
  hub.emit(
    "Break",
    { ObjectType: 5, ObjectNumber: 50100 },
    [{
      ObjectId: { ObjectType: 5, ObjectNumber: 50100 },
      ObjectName: "Writer",
      MethodName: "Run",
      StatementSpan: {
        From: { Line: 6, Column: 8 },
        To: { Line: 6, Column: 30 },
      },
    }],
    "",
  );
}

describe("record-write MCP tools", () => {
  test("start configures fail-closed triage, collects in background, and finish returns a valid grouped report", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "GetNstSessionInfo") return { SessionId: 321, HostId: null };
      if (method === "GetSourceContent") return { Content: SOURCE, IsALContent: true };
      if (method === "GetWatchNode") {
        return {
          Name: "Customer",
          TypeName: "Table Customer (18)",
          Summary: "'10000'",
          HasChildren: true,
        };
      }
      return undefined;
    };
    const { state, tools } = setup(hub);
    const start = await tools.get("bcdev_record_writes_start")!.handler({
      tableId: 18,
      sessionId: 321,
    }) as { nextSteps: string[] };
    expect(start.nextSteps.join(" ")).toContain("Trigger");
    expect(() => tools.get("bcdev_record_writes_start")!.outputSchema.parse(start)).not.toThrow();
    expect(state.debugOwner).toBe("recordWrites");
    const arming = await tools.get("bcdev_record_writes_status")!.handler({}) as {
      phase: string;
      nextSteps: string[];
    };
    expect(arming.phase).toBe("arming");
    expect(arming.nextSteps.join(" ")).toContain("Trigger");
    expect(() => tools.get("bcdev_record_writes_status")!.outputSchema.parse(arming)).not.toThrow();

    hub.emit("HubConnected");
    await Bun.sleep(0);
    const config = hub.invoked("DebugAdapterConfigurationDone")[0]?.args[0];
    expect(config).toMatchObject({
      BreakOnError: false,
      BreakOnErrorBehaviour: 1,
      BreakOnRecordWrite: true,
      BreakOnRecordWriteBehaviour: 3,
      SkipSystemTriggers: false,
    });

    emitWrite(hub);
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(hub.invoked("SetBreakpointResponse").map((call) => call.args)).toEqual([[0]]);

    const status = await tools.get("bcdev_record_writes_status")!.handler({}) as {
      phase: string;
      summary: { matchedWrites: number };
      nextSteps: string[];
    };
    expect(status).toMatchObject({ phase: "collecting", summary: { matchedWrites: 1 } });
    expect(status.nextSteps.join(" ")).toContain("finish");

    const finishTool = tools.get("bcdev_record_writes_finish")!;
    const report = await finishTool.handler({}) as {
      complete: boolean;
      summary: { matchedWrites: number; uniqueWriters: number };
      writers: Array<{ operation: string; count: number }>;
      nextSteps: string[];
    };
    expect(report).toMatchObject({
      complete: true,
      summary: { matchedWrites: 1, uniqueWriters: 1 },
      writers: [{ operation: "modify", count: 1 }],
    });
    expect(report.nextSteps.join(" ")).toContain("grouped writer stacks");
    expect(() => finishTool.outputSchema.parse(report)).not.toThrow();
    expect(state.debugOwner).toBeNull();
    expect(state.recordWrites).toBeNull();
  });

  test("default and temporary-inclusive modes send the proven record-write wire enum", async () => {
    for (const [includeTemporary, expected] of [[false, 3], [true, 2]] as const) {
      const hub = new FakeHub();
      const { tools } = setup(hub);
      await tools.get("bcdev_record_writes_start")!.handler({
        tableId: 18,
        includeTemporary,
      });
      hub.emit("HubConnected");
      await Bun.sleep(0);
      expect(hub.invoked("DebugAdapterConfigurationDone")[0]?.args[0]).toMatchObject({
        BreakOnRecordWrite: true,
        BreakOnRecordWriteBehaviour: expected,
      });
      await tools.get("bcdev_record_writes_finish")!.handler({});
    }
  });

  test("validates target and cap before claiming the slot or opening a hub", async () => {
    const hub = new FakeHub();
    const { state, tools } = setup(hub);
    for (const params of [
      { tableId: 0 },
      { tableId: 18, maxObservedWrites: 0 },
      { tableId: 18, maxObservedWrites: 10001 },
      { tableId: 18, sessionId: 1, userId: "u" },
    ]) {
      await expect(tools.get("bcdev_record_writes_start")!.handler(params)).rejects.toThrow();
      expect(state.debugOwner).toBeNull();
    }
    expect(hub.started).toBe(false);
  });

  test("triage and manual debugger entry points share one atomic slot", async () => {
    const hub = new FakeHub();
    const { state, tools } = setup(hub);
    const first = tools.get("bcdev_record_writes_start")!.handler({ tableId: 18 });
    await expect(tools.get("bcdev_record_writes_start")!.handler({ tableId: 18 })).rejects.toThrow(
      /Record-write triage is active/,
    );
    await first;
    await expect(tools.get("bcdev_debug_attach")!.handler({})).rejects.toThrow(/Record-write triage is active/);
    await expect(tools.get("bcdev_debug_wait")!.handler({ timeoutMs: 1 })).rejects.toThrow(/Record-write triage is active/);
    await tools.get("bcdev_record_writes_finish")!.handler({});
    expect(state.debugOwner).toBeNull();

    const firstManual = tools.get("bcdev_debug_attach")!.handler({});
    await expect(tools.get("bcdev_debug_attach")!.handler({})).rejects.toThrow(/Debug session already active/);
    await firstManual;
    await expect(tools.get("bcdev_record_writes_start")!.handler({ tableId: 18 })).rejects.toThrow(
      /Debug session already active/,
    );
    await tools.get("bcdev_debug_detach")!.handler({});
  });

  test("setup failure rolls back the slot and finish/status require an active capture", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "Attach") throw new Error("attach failed");
      return undefined;
    };
    const { state, tools } = setup(hub);
    await expect(tools.get("bcdev_record_writes_start")!.handler({ tableId: 18 })).rejects.toThrow(/attach failed/);
    expect(state.debugOwner).toBeNull();
    expect(state.recordWrites).toBeNull();
    await expect(tools.get("bcdev_record_writes_status")!.handler({})).rejects.toThrow(/No active record-write triage/);
    await expect(tools.get("bcdev_record_writes_finish")!.handler({})).rejects.toThrow(/No active record-write triage/);

    hub.onInvoke = undefined;
    await tools.get("bcdev_record_writes_start")!.handler({ tableId: 18 });
    expect(state.debugOwner).toBe("recordWrites");
    await tools.get("bcdev_record_writes_finish")!.handler({});
  });

  test("cap release returns truncated guidance and clears the slot on finish", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "GetSourceContent") return { Content: SOURCE, IsALContent: true };
      if (method === "GetWatchNode") return { Name: "Customer", TypeName: "Table Customer (18)", Summary: "", HasChildren: true };
      return undefined;
    };
    const { state, tools } = setup(hub);
    await tools.get("bcdev_record_writes_start")!.handler({ tableId: 18, maxObservedWrites: 1 });
    emitWrite(hub);
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(hub.invoked("SetBreakpointResponse").map((call) => call.args)).toEqual([[4]]);
    const report = await tools.get("bcdev_record_writes_finish")!.handler({}) as {
      truncated: boolean;
      complete: boolean;
      nextSteps: string[];
    };
    expect(report).toMatchObject({ truncated: true, complete: false });
    expect(report.nextSteps.join(" ")).toContain("maxObservedWrites");
    expect(state.debugOwner).toBeNull();
    expect(hub.invoked("SetBreakpointResponse").map((call) => call.args)).toEqual([[4]]);
  });

  test("a session identity lookup warning is nonfatal and retained in status", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "GetNstSessionInfo") return {};
      return undefined;
    };
    const { tools } = setup(hub);
    await tools.get("bcdev_record_writes_start")!.handler({ tableId: 18 });
    hub.emit("HubConnected");
    await Bun.sleep(0);
    const status = await tools.get("bcdev_record_writes_status")!.handler({}) as {
      phase: string;
      sessionId: number | null;
      warning: string | null;
    };
    expect(status).toMatchObject({ phase: "collecting", sessionId: null });
    expect(status.warning).toContain("identity could not be read");
    await tools.get("bcdev_record_writes_finish")!.handler({});
  });

  test("a rejected debugger configuration fails closed instead of returning a complete zero-write report", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "DebugAdapterConfigurationDone") throw new Error("configuration rejected");
      if (method === "GetNstSessionInfo") return { SessionId: 321, HostId: null };
      return undefined;
    };
    const { tools } = setup(hub);
    await tools.get("bcdev_record_writes_start")!.handler({ tableId: 18 });
    hub.emit("HubConnected");
    await Bun.sleep(0);
    await Bun.sleep(0);

    const status = await tools.get("bcdev_record_writes_status")!.handler({}) as {
      phase: string;
    };
    expect(status.phase).toBe("failed");
    const report = await tools.get("bcdev_record_writes_finish")!.handler({}) as {
      outcome: string;
      complete: boolean;
      warnings: string[];
    };
    expect(report).toMatchObject({ outcome: "failed", complete: false });
    expect(report.warnings.join(" ")).toContain("Debugger configuration failed");
  });

  test("an unexpected clean hub close fails the retained report closed", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) =>
      method === "GetNstSessionInfo" ? { SessionId: 321, HostId: null } : undefined;
    const { tools } = setup(hub);
    await tools.get("bcdev_record_writes_start")!.handler({ tableId: 18 });
    hub.emit("HubConnected");
    await Bun.sleep(0);
    hub.close();
    await Bun.sleep(0);

    const status = await tools.get("bcdev_record_writes_status")!.handler({}) as {
      phase: string;
    };
    expect(status.phase).toBe("failed");
    const report = await tools.get("bcdev_record_writes_finish")!.handler({}) as {
      outcome: string;
      complete: boolean;
      warnings: string[];
    };
    expect(report).toMatchObject({ outcome: "failed", complete: false });
    expect(report.warnings.join(" ")).toContain("connection closed unexpectedly");
  });

  test("a mid-capture detach returns incomplete evidence and cautionary guidance", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "GetSourceContent") return { Content: SOURCE, IsALContent: true };
      if (method === "GetWatchNode") {
        return { Name: "Customer", TypeName: "Table Customer (18)", Summary: "", HasChildren: true };
      }
      return undefined;
    };
    const { tools } = setup(hub);
    await tools.get("bcdev_record_writes_start")!.handler({ tableId: 18 });
    emitWrite(hub);
    hub.emit("OnDetachedFromConnection", false);
    await Bun.sleep(0);
    await Bun.sleep(0);

    const report = await tools.get("bcdev_record_writes_finish")!.handler({}) as {
      complete: boolean;
      stopReason: string;
      warnings: string[];
      nextSteps: string[];
    };
    expect(report).toMatchObject({ complete: false, stopReason: "sessionDetached" });
    expect(report.warnings.join(" ")).toContain("detached before finish");
    expect(report.nextSteps.join(" ")).toContain("before treating");
  });

  test("an out-of-band user-filter rejection fails closed and preserves a partial report", async () => {
    const hub = new FakeHub();
    const { state, tools } = setup(hub);
    const start = await tools.get("bcdev_record_writes_start")!.handler({
      tableId: 18,
      userId: "missing-user",
    }) as { armed: boolean };
    expect(start.armed).toBe(true);

    hub.emit("OnFatalDebuggerException", "The user specified cannot be found on the tenant.");
    await Bun.sleep(0);
    await Bun.sleep(0);
    const status = await tools.get("bcdev_record_writes_status")!.handler({}) as {
      phase: string;
      warning: string | null;
    };
    expect(status.phase).toBe("failed");
    expect(status.warning).toContain("Unable to bind the requested user-filtered session");
    const report = await tools.get("bcdev_record_writes_finish")!.handler({}) as {
      outcome: string;
      complete: boolean;
    };
    expect(report).toMatchObject({ outcome: "failed", complete: false });
    expect(state.debugOwner).toBeNull();
  });
});
