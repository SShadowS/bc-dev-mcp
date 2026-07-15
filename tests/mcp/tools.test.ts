import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools, type ToolDeps } from "../../src/mcp/tools";
import { createAuthorizationProviderFactory } from "../../src/core/authorization";
import { ServerState } from "../../src/mcp/state";
import { FakeHub, fakeHubFactory } from "../fakes/fake-hub";

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "bcmcp-tools-"));
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(
    join(dir, ".vscode", "launch.json"),
    JSON.stringify({ configurations: [{ type: "al", request: "launch", server: "http://localhost", serverInstance: "BC" }] }),
  );
  writeFileSync(
    join(dir, "T.Codeunit.al"),
    'codeunit 50100 "T"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure A()\n    begin\n    end;\n}\n',
  );
  return dir;
}

function setup(hub: FakeHub, fetchFn?: typeof fetch) {
  const state = new ServerState();
  const deps: ToolDeps = {
    hubFactory: fakeHubFactory(hub),
    authorizationFactory: createAuthorizationProviderFactory(),
    fetchFn: fetchFn ?? ((async () => new Response(JSON.stringify({ WebApiVersion: "7.0" }))) as unknown as typeof fetch),
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" },
    cwd: makeProject(),
  };
  const tools = new Map(createTools(state, deps).map((t) => [t.name, t]));
  return { state, tools };
}

describe("tools", () => {
  let hub: FakeHub;
  beforeEach(() => {
    hub = new FakeHub();
  });

  test("registers all 15 tools", () => {
    const { tools } = setup(hub);
    expect([...tools.keys()].sort()).toEqual([
      "bcdev_debug_attach",
      "bcdev_debug_breakpoints",
      "bcdev_debug_continue",
      "bcdev_debug_detach",
      "bcdev_debug_eval",
      "bcdev_debug_run_tests",
      "bcdev_debug_variables",
      "bcdev_debug_wait",
      "bcdev_profile_finish",
      "bcdev_profile_poll",
      "bcdev_profile_start",
      "bcdev_profile_status",
      "bcdev_status",
      "bcdev_test_discover",
      "bcdev_test_run",
    ]);
  });

  function fieldDescription(schema: unknown): string | undefined {
    // zod v4: .describe() sets description on the outermost wrapper; walk unwrap chain
    let s = schema as { description?: string; unwrap?: () => unknown; element?: unknown };
    for (let i = 0; i < 5 && s; i++) {
      if (typeof s.description === "string" && s.description.length > 0) return s.description;
      s = (typeof s.unwrap === "function" ? s.unwrap() : undefined) as typeof s;
    }
    return undefined;
  }

  // Peels ZodOptional/ZodNullable/ZodDefault wrappers (via .unwrap()) down to the
  // underlying ZodArray/ZodObject so we can inspect its .element / .shape.
  function unwrapToCore(schema: unknown): { element?: unknown; shape?: Record<string, unknown> } {
    let s = schema as { unwrap?: () => unknown; element?: unknown; shape?: Record<string, unknown> };
    for (let i = 0; i < 5 && s && typeof s.unwrap === "function"; i++) {
      s = s.unwrap() as typeof s;
    }
    return s;
  }

  // Recursively asserts every field — including nested z.object({...}) shapes and
  // z.array(z.object({...})) elements — carries a .describe(). Depth-capped to guard
  // against recursive/self-referential schemas.
  function assertDescribedRecursively(path: string, schema: unknown, depth = 0): void {
    expect(fieldDescription(schema), `${path} needs .describe()`).toBeDefined();
    if (depth >= 4) return;
    const core = unwrapToCore(schema);
    const elementCore = core.element ? unwrapToCore(core.element) : undefined;
    if (elementCore?.shape) {
      for (const [key, sub] of Object.entries(elementCore.shape)) {
        assertDescribedRecursively(`${path}[].${key}`, sub, depth + 1);
      }
    } else if (core.shape) {
      for (const [key, sub] of Object.entries(core.shape)) {
        assertDescribedRecursively(`${path}.${key}`, sub, depth + 1);
      }
    }
  }

  test("every tool has title, annotations, and described params", () => {
    const { tools } = setup(hub);
    for (const tool of tools.values()) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.annotations).toBeDefined();
      for (const [param, schema] of Object.entries(tool.schema)) {
        assertDescribedRecursively(`${tool.name}.${param}`, schema);
      }
    }
  });

  test("bcdev_status reports feature gates", async () => {
    const { tools } = setup(hub);
    const status = (await tools.get("bcdev_status")!.handler({})) as Record<string, unknown>;
    expect(status["supportsTestRunning"]).toBe(true);
  });

  test("bcdev_test_discover finds test codeunits", async () => {
    const { tools } = setup(hub);
    const found = (await tools.get("bcdev_test_discover")!.handler({})) as { tests: unknown[] };
    expect(found.tests).toHaveLength(1);
  });

  test("every tool result validates against its own outputSchema", async () => {
    const { tools } = setup(hub);
    hub.onInvoke = (method) => {
      if (method === "AddBreakpoint") return { BreakpointId: 7 };
      if (method === "RunTests") {
        queueMicrotask(() => {
          hub.emit("TestCompleted", 50100, "A", 0, "", 5);
          hub.emit("TestRunCompleted", { Tests: [] });
        });
      }
      if (method === "GetVariables") return [{ Name: "X", TypeName: "Integer", Summary: "1", HasChildren: false }];
      if (method === "GetWatchNode") return { Name: "X", TypeName: "Integer", Summary: "1", HasChildren: false };
      return undefined;
    };
    const check = async (name: string, params: Record<string, unknown>) => {
      const tool = tools.get(name)!;
      const result = await tool.handler(params);
      expect(() => tool.outputSchema.parse(result), `${name} output`).not.toThrow();
    };
    await check("bcdev_status", {});
    await check("bcdev_test_discover", {});
    await check("bcdev_test_run", { codeunits: [{ id: 50100 }] });
    await check("bcdev_debug_attach", { breakpoints: [] });
    await check("bcdev_debug_variables", { frameId: 0 });
    await check("bcdev_debug_eval", { frameId: 0, expression: "X" });
    await check("bcdev_debug_breakpoints", { add: [{ file: "T.Codeunit.al", line: 6 }] });
    await check("bcdev_debug_continue", { action: "continue" });
    await check("bcdev_debug_run_tests", { codeunits: [{ id: 50100 }] });
    // drain testRunFinished then validate bcdev_debug_wait's output
    await check("bcdev_debug_wait", { timeoutMs: 500 });
    await check("bcdev_debug_detach", {});
  });

  test("bcdev_test_run runs plan and clears lock", async () => {
    const { state, tools } = setup(hub);
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        queueMicrotask(() => {
          hub.emit("TestCompleted", 50100, "A", 0, "", 5);
          hub.emit("TestRunCompleted", { Tests: [] });
        });
      }
      return undefined;
    };
    const result = (await tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 50100 }] })) as Record<string, unknown>;
    expect(result["results"]).toHaveLength(1);
    expect(state.testRunActive).toBe(false);
  });

  test("bcdev_debug_attach maps file/line breakpoints and stores session", async () => {
    const { state, tools } = setup(hub);
    hub.onInvoke = (method) => (method === "AddBreakpoint" ? { BreakpointId: 7 } : undefined);
    const attach = (await tools.get("bcdev_debug_attach")!.handler({
      breakpoints: [{ file: "T.Codeunit.al", line: 6 }],
    })) as Record<string, unknown>;
    expect(attach["breakpoints"]).toEqual([{ breakpointId: 7, file: "T.Codeunit.al", line: 6 }]);
    expect(state.debug).not.toBeNull();
  });

  test("bcdev_debug_attach forwards exact-session and trimmed user targeting", async () => {
    const exactHub = new FakeHub();
    const exact = setup(exactHub);
    await exact.tools.get("bcdev_debug_attach")!.handler({ sessionId: 43210, breakOnNext: "Background" });
    expect(exactHub.invoked("Attach")[0]?.args[0]).toEqual({
      BreakOnNextClient: 2,
      SessionId: 43210,
      UserId: null,
    });

    const userHub = new FakeHub();
    const user = setup(userHub);
    await user.tools.get("bcdev_debug_attach")!.handler({ userId: "  alice@example.com  ", breakOnNext: "WebServiceClient" });
    expect(userHub.invoked("Attach")[0]?.args[0]).toEqual({
      BreakOnNextClient: 0,
      SessionId: -1,
      UserId: "alice@example.com",
    });
  });

  test("bcdev_debug_attach rejects invalid targeting before claiming state or starting a hub", async () => {
    const invalid: Array<Record<string, unknown>> = [
      { sessionId: 1, userId: "alice" },
      { sessionId: 0 },
      { sessionId: -1 },
      { sessionId: 1.5 },
      { sessionId: "1" },
      { userId: "   " },
      { userId: 42 },
    ];
    for (const params of invalid) {
      const invalidHub = new FakeHub();
      const { state, tools } = setup(invalidHub);
      await expect(tools.get("bcdev_debug_attach")!.handler(params)).rejects.toThrow(/mutually exclusive|positive integer|nonblank/);
      expect(state.debug).toBeNull();
      expect(invalidHub.started).toBe(false);
      expect(invalidHub.invoked("Attach")).toHaveLength(0);
    }
  });

  test("bcdev_debug_wait drains events pushed by client", async () => {
    const { state, tools } = setup(hub);
    await tools.get("bcdev_debug_attach")!.handler({});
    hub.emit("Break", { ObjectType: 5, ObjectNumber: 50100 }, [], "");
    const event = (await tools.get("bcdev_debug_wait")!.handler({ timeoutMs: 100 })) as Record<string, unknown>;
    expect(event["kind"]).toBe("break");
  });

  test("bcdev_debug_wait returns a schema-valid sessionBound identity event", async () => {
    const { tools } = setup(hub);
    hub.onInvoke = (method) =>
      method === "GetNstSessionInfo"
        ? { SessionId: 43210, HostId: "11111111-1111-1111-1111-111111111111" }
        : undefined;
    await tools.get("bcdev_debug_attach")!.handler({});
    hub.emit("HubConnected");
    const event = await tools.get("bcdev_debug_wait")!.handler({ timeoutMs: 100 });
    expect(event).toEqual({
      kind: "sessionBound",
      sessionId: 43210,
      hostId: "11111111-1111-1111-1111-111111111111",
    });
    expect(() => tools.get("bcdev_debug_wait")!.outputSchema.parse(event)).not.toThrow();
  });

  test("bcdev_debug_wait returns one schema-valid nonfatal sessionBound warning", async () => {
    const { state, tools } = setup(hub);
    hub.onInvoke = (method) => {
      if (method === "GetNstSessionInfo") throw new Error("identity unavailable");
      return undefined;
    };
    await tools.get("bcdev_debug_attach")!.handler({});
    hub.emit("OnAttachedToConnection");
    hub.emit("HubConnected");
    const event = await tools.get("bcdev_debug_wait")!.handler({ timeoutMs: 100 });
    expect(event).toMatchObject({ kind: "sessionBound", sessionId: null, hostId: null });
    expect(() => tools.get("bcdev_debug_wait")!.outputSchema.parse(event)).not.toThrow();
    const timedOut = await tools.get("bcdev_debug_wait")!.handler({ timeoutMs: 5 });
    expect(timedOut).toEqual({ timedOut: true });
    expect(state.debug).not.toBeNull();
    expect(hub.invoked("GetNstSessionInfo")).toHaveLength(1);
  });

  test("bcdev_debug_wait reports droppedEvents once the queue has overflowed", async () => {
    const { state, tools } = setup(hub);
    await tools.get("bcdev_debug_attach")!.handler({});
    for (let i = 0; i < 105; i++) state.debug!.push({ kind: "fatal", message: `m${i}` });
    const event = (await tools.get("bcdev_debug_wait")!.handler({ timeoutMs: 100 })) as Record<string, unknown>;
    expect(event["droppedEvents"]).toBe(5);
  });

  test("guards: double attach, run while running, wait without session", async () => {
    const { state, tools } = setup(hub);
    await tools.get("bcdev_debug_attach")!.handler({});
    await expect(tools.get("bcdev_debug_attach")!.handler({ sessionId: 0 })).rejects.toThrow(/active/);
    await expect(tools.get("bcdev_debug_attach")!.handler({})).rejects.toThrow(/active/);
    state.testRunActive = true;
    await expect(tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 1 }] })).rejects.toThrow(/already running/);
    state.debug = null;
    await expect(tools.get("bcdev_debug_wait")!.handler({})).rejects.toThrow(/No debug session/);
  });

  test("bcdev_debug_run_tests passes connectionId as debuggingContext", async () => {
    const { tools } = setup(hub);
    hub.onInvoke = (method) => {
      if (method === "RunTests") queueMicrotask(() => hub.emit("TestRunCompleted", { Tests: [] }));
      return undefined;
    };
    await tools.get("bcdev_debug_attach")!.handler({});
    await tools.get("bcdev_debug_run_tests")!.handler({ codeunits: [{ id: 50100 }] });
    await Bun.sleep(0); // authorization acquisition is asynchronous before the background hub starts
    expect(hub.invoked("Initialize")[0]?.args[1]).toBe("fake-conn-1");
  });

  test("bcdev_debug_run_tests: a synchronously-throwing background run surfaces a fatal event instead of an unhandled rejection", async () => {
    const { state, tools } = setup(hub);
    await tools.get("bcdev_debug_attach")!.handler({});
    // "not a url at all" makes hubUrl()'s `new URL(c.server)` throw synchronously inside
    // TestRunnerClient.run(), rejecting the floating background promise.
    const started = (await tools.get("bcdev_debug_run_tests")!.handler({
      codeunits: [{ id: 1 }],
      server: "not a url at all",
    })) as Record<string, unknown>;
    expect(started["started"]).toBe(true);
    const event = (await tools.get("bcdev_debug_wait")!.handler({ timeoutMs: 200 })) as Record<string, unknown>;
    expect(event["kind"]).toBe("fatal");
    expect(state.testRunActive).toBe(false);
  });

  test("bcdev_debug_attach rolls back the claimed session when mapBreakpoints throws, and a retry succeeds", async () => {
    const { state, tools } = setup(hub);
    await expect(
      tools.get("bcdev_debug_attach")!.handler({ breakpoints: [{ file: "DoesNotExist.al", line: 1 }] }),
    ).rejects.toThrow(/No AL object declaration/);
    expect(state.debug).toBeNull();
    expect(hub.stopped).toBe(true);
    const attach = (await tools.get("bcdev_debug_attach")!.handler({})) as Record<string, unknown>;
    expect(attach["attached"]).toBe(true);
  });

  test("bcdev_debug_attach rolls back an unavailable exact session and allows retry", async () => {
    const { state, tools } = setup(hub);
    let rejectExact = true;
    hub.onInvoke = (method) => {
      if (method === "Attach" && rejectExact) {
        throw new Error("not found?Authentication=Bearer%20secret-token&tenant=default");
      }
      return undefined;
    };
    let message = "";
    try {
      await tools.get("bcdev_debug_attach")!.handler({ sessionId: 43210 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Unable to attach to NST session 43210");
    expect(message).not.toContain("secret-token");
    expect(state.debug).toBeNull();
    expect(hub.stopped).toBe(true);

    rejectExact = false;
    const attach = (await tools.get("bcdev_debug_attach")!.handler({})) as Record<string, unknown>;
    expect(attach["attached"]).toBe(true);
  });

  test("bcdev_debug_attach rolls back when the server signals fatal during exact Attach", async () => {
    const { state, tools } = setup(hub);
    hub.onInvoke = (method) => {
      if (method === "Attach") hub.emit("OnFatalDebuggerException", "The requested session is unavailable");
      return undefined;
    };
    await expect(tools.get("bcdev_debug_attach")!.handler({ sessionId: 43210 })).rejects.toThrow(/active and accessible/);
    expect(state.debug).toBeNull();
    expect(hub.stopped).toBe(true);
  });

  test("bcdev_debug_attach surfaces a user-filter fatal and suppresses binding", async () => {
    const { state, tools } = setup(hub);
    await tools.get("bcdev_debug_attach")!.handler({ userId: "ghost-user" });
    hub.emit("OnFatalDebuggerException", "The user specified in your launch.json file cannot be found on the tenant.");
    await Bun.sleep(0);
    await Bun.sleep(0);
    hub.emit("HubConnected");
    const event = (await tools.get("bcdev_debug_wait")!.handler({ timeoutMs: 200 })) as Record<string, unknown>;
    expect(event["kind"]).toBe("fatal");
    expect(String(event["message"])).toContain("user-filtered session");
    expect(state.debug).not.toBeNull();
    expect(hub.invoked("StopDebugging")).toHaveLength(1);
    expect(hub.stopped).toBe(true);
    await tools.get("bcdev_debug_detach")!.handler({});
    expect(state.debug).toBeNull();
  });
});
