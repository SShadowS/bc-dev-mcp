import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BcDevError } from "../../src/core/agent-errors";
import type { GitChangeSet } from "../../src/core/git-changes";
import { agentErrorBody } from "../../src/mcp/agent-errors";
import { ServerState } from "../../src/mcp/state";
import { createTools, type ToolDeps } from "../../src/mcp/tools";
import { FakeHub, fakeHubFactory } from "../fakes/fake-hub";
import { FakeNativeMcpGateway } from "../fakes/fake-native-mcp";

function project(environmentType: "Sandbox" | "Production" | "OnPrem" = "Sandbox"): string {
  const dir = mkdtempSync(join(tmpdir(), "bcmcp-native-"));
  mkdirSync(join(dir, ".vscode"));
  const connection = environmentType === "OnPrem"
    ? {
        type: "al",
        request: "launch",
        environmentType: "OnPrem",
        server: "http://localhost",
        serverInstance: "BC",
      }
    : {
        type: "al",
        request: "launch",
        environmentType,
        environmentName: environmentType,
        tenant: "tenant.example",
      };
  writeFileSync(
    join(dir, ".vscode", "launch.json"),
    JSON.stringify({ configurations: [connection] }),
  );
  writeFileSync(join(dir, "app.json"), JSON.stringify({ runtime: "17.0" }));
  writeFileSync(
    join(dir, "T.Codeunit.al"),
    "codeunit 50100 T\n{\n    procedure Run()\n    begin\n    end;\n}\n",
  );
  return dir;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function emitBreak(hub: FakeHub): void {
  hub.emit(
    "Break",
    { ObjectType: 5, ObjectNumber: 50100 },
    [{
      ObjectId: { ObjectType: 5, ObjectNumber: 50100 },
      ObjectName: "T",
      MethodName: "Run",
      StatementSpan: {
        From: { Line: 3, Column: 4 },
        To: { Line: 3, Column: 9 },
      },
    }],
    "",
  );
}

function setup(options: {
  environmentType?: "Sandbox" | "Production" | "OnPrem";
  gateway?: FakeNativeMcpGateway;
  hub?: FakeHub;
} = {}) {
  const state = new ServerState();
  const hub = options.hub ?? new FakeHub();
  const gateway = options.gateway ?? new FakeNativeMcpGateway();
  const deps: ToolDeps = {
    hubFactory: fakeHubFactory(hub),
    authorizationFactory: () => ({
      getAuthorizationHeader: async () => "Bearer unit-test-token",
    }),
    fetchFn: (async () => new Response(JSON.stringify({ WebApiVersion: "7.0" }))) as unknown as typeof fetch,
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" },
    cwd: project(options.environmentType),
    gitChanges: async (_project, baseRef): Promise<GitChangeSet> => ({
      baseRef,
      mergeBase: "a".repeat(40),
      head: "workingTree",
      files: [],
    }),
    nativeMcpGateway: gateway,
  };
  return {
    state,
    hub,
    gateway,
    tools: new Map(createTools(state, deps).map((tool) => [tool.name, tool])),
  };
}

async function attachAndPause(
  tools: Map<string, ReturnType<typeof createTools>[number]>,
  hub: FakeHub,
  hostId: string | null = "host-1",
): Promise<void> {
  hub.onInvoke = (method) => {
    if (method === "GetNstSessionInfo") return { SessionId: 321, HostId: hostId };
    return undefined;
  };
  await tools.get("bcdev_debug_attach")!.handler({ sessionId: 321, breakpoints: [] });
  hub.emit("HubConnected");
  await Bun.sleep(0);
  emitBreak(hub);
}

describe("BC native MCP tools", () => {
  test("lists a paged business catalog and returns agent guidance", async () => {
    const gateway = new FakeNativeMcpGateway();
    gateway.onList = () => ({
      server: { name: "Business Central", version: "28.0" },
      catalog: {
        tools: [{
          name: "bc_actions_search",
          description: "Search",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
          futureField: "preserved",
        }],
        nextCursor: "page-2",
        _meta: { source: "native" },
      },
    });
    const { tools } = setup({ gateway });
    const result = await tools.get("bcdev_native_list")!.handler({
      company: "CRONUS",
      context: "business",
      configurationName: "Read only",
      cursor: "page-1",
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      context: "business",
      server: { name: "Business Central", version: "28.0" },
      catalog: {
        nextCursor: "page-2",
        _meta: { source: "native" },
      },
    });
    expect(gateway.listCalls[0]?.cursor).toBe("page-1");
    expect(gateway.listCalls[0]?.target).toMatchObject({
      company: "CRONUS",
      context: "business",
      configurationName: "Read only",
      config: {
        environmentType: "Sandbox",
        environmentName: "Sandbox",
        tenant: "tenant.example",
      },
    });
    expect((result["nextSteps"] as string[]).join(" ")).toContain("bcdev_native_call");
    expect(() => tools.get("bcdev_native_list")!.outputSchema.parse(result)).not.toThrow();
  });

  test("preserves native isError results while making the failure explicit in next steps", async () => {
    const gateway = new FakeNativeMcpGateway();
    gateway.onCall = () => ({
      server: { name: "Business Central", version: "28.0" },
      result: {
        content: [{ type: "text", text: "Business Central rejected this action" }],
        structuredContent: { code: "native" },
        isError: true,
        futureField: { retained: true },
      },
    });
    const { tools } = setup({ gateway });
    const result = await tools.get("bcdev_native_call")!.handler({
      company: "CRONUS",
      context: "business",
      toolName: "bc_actions_invoke",
      arguments: { request: { id: 7 } },
    }) as Record<string, unknown>;

    expect(result["result"]).toMatchObject({
      isError: true,
      futureField: { retained: true },
    });
    expect(gateway.toolCalls[0]).toMatchObject({
      name: "bc_actions_invoke",
      args: { request: { id: 7 } },
    });
    expect((result["nextSteps"] as string[]).join(" ")).toContain("preserved native error");
    expect(() => tools.get("bcdev_native_call")!.outputSchema.parse(result)).not.toThrow();
  });

  test("rejects on-premises targets and configuration names outside business context", async () => {
    const onPrem = setup({ environmentType: "OnPrem" });
    const unsupported = await onPrem.tools.get("bcdev_native_list")!.handler({
      company: "CRONUS",
      context: "business",
    }).catch((caught) => caught);
    expect(unsupported).toMatchObject({
      code: "UNSUPPORTED_SERVER",
      category: "server",
    });
    expect(onPrem.gateway.listCalls).toHaveLength(0);

    const cloud = setup();
    const invalid = await cloud.tools.get("bcdev_native_list")!.handler({
      company: "CRONUS",
      context: "runtime",
      configurationName: "business-only",
    }).catch((caught) => caught);
    expect(invalid).toMatchObject({
      code: "INVALID_ARGUMENT",
      category: "validation",
    });
    expect(cloud.gateway.listCalls).toHaveLength(0);
  });

  test("requires a paused manual debugger with confirmed host identity", async () => {
    const { tools, hub, gateway } = setup();
    await tools.get("bcdev_debug_attach")!.handler({ sessionId: 321, breakpoints: [] });

    const running = await tools.get("bcdev_native_list")!.handler({
      company: "CRONUS",
      context: "debugging",
    }).catch((caught) => caught);
    expect(running).toMatchObject({ code: "DEBUG_SESSION_NOT_PAUSED" });

    hub.onInvoke = (method) =>
      method === "GetNstSessionInfo" ? { SessionId: 321, HostId: null } : undefined;
    hub.emit("HubConnected");
    await Bun.sleep(0);
    hub.emit(
      "Break",
      { ObjectType: 5, ObjectNumber: 50100 },
      [{
        ObjectId: { ObjectType: 5, ObjectNumber: 50100 },
        ObjectName: "T",
        MethodName: "Run",
        StatementSpan: { From: { Line: 3, Column: 0 }, To: { Line: 3, Column: 4 } },
      }],
      "",
    );
    const missingIdentity = await tools.get("bcdev_native_list")!.handler({
      company: "CRONUS",
      context: "debugging",
    }).catch((caught) => caught);
    expect(missingIdentity).toMatchObject({ code: "DEBUG_SESSION_IDENTITY_UNAVAILABLE" });
    expect(gateway.listCalls).toHaveLength(0);
  });

  test("passes active paused debugger identity and becomes unavailable after continue", async () => {
    const { tools, hub, gateway } = setup();
    await attachAndPause(tools, hub);

    const result = await tools.get("bcdev_native_list")!.handler({
      company: "CRONUS",
      context: "debugging",
    }) as Record<string, unknown>;
    expect(result["context"]).toBe("debugging");
    expect(gateway.listCalls[0]?.target.debugIdentity).toEqual({
      sessionId: 321,
      hostId: "host-1",
    });

    await tools.get("bcdev_debug_continue")!.handler({ action: "continue" });
    const running = await tools.get("bcdev_native_list")!.handler({
      company: "CRONUS",
      context: "debugging",
    }).catch((caught) => caught);
    expect(running).toMatchObject({ code: "DEBUG_SESSION_NOT_PAUSED" });
    expect(gateway.listCalls).toHaveLength(1);
  });

  test("keeps a newer break paused when it arrives before a step invocation resolves", async () => {
    const { tools, hub, gateway } = setup();
    await attachAndPause(tools, hub);
    hub.onInvoke = async (method) => {
      if (method === "SetBreakpointResponse") emitBreak(hub);
      return undefined;
    };

    await tools.get("bcdev_debug_continue")!.handler({ action: "stepOver" });
    await tools.get("bcdev_native_list")!.handler({
      company: "CRONUS",
      context: "debugging",
    });
    expect(gateway.listCalls).toHaveLength(1);
    expect(gateway.listCalls[0]?.target.debugIdentity).toEqual({
      sessionId: 321,
      hostId: "host-1",
    });
  });

  test("restores paused native debugging when a resume invocation is rejected", async () => {
    const { tools, hub, gateway } = setup();
    await attachAndPause(tools, hub);
    hub.onInvoke = async (method) => {
      if (method === "SetBreakpointResponse") throw new Error("resume rejected");
      return undefined;
    };

    await expect(
      tools.get("bcdev_debug_continue")!.handler({ action: "continue" }),
    ).rejects.toThrow("resume rejected");
    await tools.get("bcdev_native_list")!.handler({
      company: "CRONUS",
      context: "debugging",
    });
    expect(gateway.listCalls).toHaveLength(1);
  });

  test("keeps a fast break paused when asynchronous session identity arrives afterward", async () => {
    const { tools, hub, gateway } = setup();
    hub.onInvoke = (method) =>
      method === "GetNstSessionInfo" ? { SessionId: 321, HostId: "host-1" } : undefined;
    await tools.get("bcdev_debug_attach")!.handler({ sessionId: 321, breakpoints: [] });
    hub.emit(
      "Break",
      { ObjectType: 5, ObjectNumber: 50100 },
      [{
        ObjectId: { ObjectType: 5, ObjectNumber: 50100 },
        ObjectName: "T",
        MethodName: "Run",
        StatementSpan: { From: { Line: 3, Column: 0 }, To: { Line: 3, Column: 4 } },
      }],
      "",
    );
    hub.emit("HubConnected");
    await Bun.sleep(0);

    await tools.get("bcdev_native_list")!.handler({
      company: "CRONUS",
      context: "debugging",
    });
    expect(gateway.listCalls[0]?.target.debugIdentity).toEqual({
      sessionId: 321,
      hostId: "host-1",
    });
  });

  test("shares one atomic test-run lock across native, direct, and debug-bound execution", async () => {
    const pending = deferred<{
      server: { name: string; version: string };
      result: Record<string, unknown>;
    }>();
    const gateway = new FakeNativeMcpGateway();
    gateway.onCall = () => pending.promise;
    const { state, tools, hub } = setup({ gateway });
    await attachAndPause(tools, hub);

    const nativeRun = tools.get("bcdev_native_call")!.handler({
      company: "CRONUS",
      context: "runtime",
      toolName: "run_tests",
      arguments: { codeunitId: 50100 },
    });
    expect(state.testRunActive).toBe(true);

    const secondNative = await tools.get("bcdev_native_call")!.handler({
      company: "CRONUS",
      context: "runtime",
      toolName: "run_tests",
      arguments: {},
    }).catch((caught) => caught);
    const direct = await tools.get("bcdev_test_run")!.handler({
      codeunits: [{ id: 50100 }],
    }).catch((caught) => caught);
    const debugBound = await tools.get("bcdev_debug_run_tests")!.handler({
      codeunits: [{ id: 50100 }],
    }).catch((caught) => caught);

    for (const error of [secondNative, direct, debugBound]) {
      expect(error).toMatchObject({ code: "TEST_RUN_ACTIVE", category: "state" });
    }
    expect(gateway.toolCalls).toHaveLength(1);

    pending.resolve({
      server: { name: "Business Central", version: "28.0" },
      result: { content: [{ type: "text", text: "done" }] },
    });
    await nativeRun;
    expect(state.testRunActive).toBe(false);
  });

  test("runtime operation timeout releases the lock with explicit unknown server state", async () => {
    const gateway = new FakeNativeMcpGateway();
    gateway.onCall = () => {
      throw new BcDevError(
        "TIMEOUT",
        "native operation timed out",
        "network",
        true,
        { timeoutPhase: "operation" },
      );
    };
    const { state, tools } = setup({ gateway });

    const error = await tools.get("bcdev_native_call")!.handler({
      company: "CRONUS",
      context: "runtime",
      toolName: "run_tests",
      arguments: {},
    }).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "TIMEOUT",
      retryable: false,
      details: {
        timeoutPhase: "operation",
        upstreamRunCancelled: false,
      },
    });
    expect(state.testRunActive).toBe(false);
    const body = agentErrorBody("bcdev_native_call", error);
    expect(body.error).toMatchObject({
      retryable: false,
      details: {
        upstreamRunCancelled: false,
        warning: expect.stringContaining("may still be executing"),
      },
    });
    expect(body.nextSteps.join(" ")).toContain("Do not start another test run");
  });

  test("runtime setup timeout releases the lock without claiming a server run started", async () => {
    const gateway = new FakeNativeMcpGateway();
    gateway.onCall = () => {
      throw new BcDevError(
        "TIMEOUT",
        "native authorization timed out",
        "network",
        true,
        { timeoutPhase: "authorization" },
      );
    };
    const { state, tools } = setup({ gateway });

    const error = await tools.get("bcdev_native_call")!.handler({
      company: "CRONUS",
      context: "runtime",
      toolName: "run_tests",
      arguments: {},
    }).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "TIMEOUT",
      retryable: true,
      details: { timeoutPhase: "authorization" },
    });
    expect((error as BcDevError).details["upstreamRunCancelled"]).toBeUndefined();
    expect(state.testRunActive).toBe(false);
  });

  test("accepts a null optional native server identity in the public output", async () => {
    const gateway = new FakeNativeMcpGateway();
    gateway.onList = () => ({ server: null, catalog: { tools: [] } });
    const { tools } = setup({ gateway });
    const tool = tools.get("bcdev_native_list")!;

    const result = await tool.handler({
      company: "CRONUS",
      context: "business",
    }) as Record<string, unknown>;
    expect(result["server"]).toBeNull();
    expect(() => tool.outputSchema.parse(result)).not.toThrow();
  });

  test("accepts Production configuration without making any direct network decision in the tool layer", async () => {
    const { tools, gateway } = setup({ environmentType: "Production" });
    await tools.get("bcdev_native_list")!.handler({
      company: "CRONUS",
      context: "business",
    });
    expect(gateway.listCalls[0]?.target.config.environmentType).toBe("Production");
  });
});
