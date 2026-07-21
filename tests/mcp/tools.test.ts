import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools, type ToolDeps } from "../../src/mcp/tools";
import { BcDevError } from "../../src/core/agent-errors";
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

function setup(
  hub: FakeHub,
  fetchFn?: typeof fetch,
  hubFactory: ToolDeps["hubFactory"] = fakeHubFactory(hub),
  overrides: Partial<ToolDeps> = {},
) {
  const state = new ServerState();
  const deps: ToolDeps = {
    hubFactory,
    authorizationFactory: createAuthorizationProviderFactory(),
    fetchFn: fetchFn ?? ((async () => new Response(JSON.stringify({ WebApiVersion: "7.0" }))) as unknown as typeof fetch),
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" },
    cwd: makeProject(),
    ...overrides,
  };
  const tools = new Map(createTools(state, deps).map((t) => [t.name, t]));
  return { state, tools };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("tools", () => {
  let hub: FakeHub;
  beforeEach(() => {
    hub = new FakeHub();
  });

  test("registers all 17 tools", () => {
    const { tools } = setup(hub);
    expect([...tools.keys()].sort()).toEqual([
      "bcdev_debug_attach",
      "bcdev_debug_breakpoints",
      "bcdev_debug_continue",
      "bcdev_debug_detach",
      "bcdev_debug_eval",
      "bcdev_debug_run_tests",
      "bcdev_debug_sql",
      "bcdev_debug_variables",
      "bcdev_debug_wait",
      "bcdev_profile_finish",
      "bcdev_profile_poll",
      "bcdev_profile_start",
      "bcdev_profile_status",
      "bcdev_source",
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
      const result = await tool.handler(params) as { nextSteps?: unknown };
      expect(Array.isArray(result.nextSteps), `${name} nextSteps`).toBe(true);
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

  test("bcdev_test_run rejects an unsupported developer API with a typed error", async () => {
    const oldServer = setup(hub, (async () =>
      new Response(JSON.stringify({ WebApiVersion: "6.0" }))) as unknown as typeof fetch);
    const error = await oldServer.tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 50100 }] }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BcDevError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_SERVER", category: "server" });
    expect(oldServer.state.testRunActive).toBe(false);
    expect(hub.invoked("RunTests")).toHaveLength(0);
  });

  test("bcdev_test_run claims the singleton lock before a deferred metadata preflight", async () => {
    const metadata = deferred<Response>();
    const { state, tools } = setup(hub, (async () => await metadata.promise) as unknown as typeof fetch);
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        queueMicrotask(() => {
          hub.emit("TestCompleted", 50100, "A", 0, "", 5);
          hub.emit("TestRunCompleted", { Tests: [] });
        });
      }
      return undefined;
    };

    const first = tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 50100 }] });
    const secondError = await tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 50100 }] }).catch((caught) => caught);
    expect(secondError).toBeInstanceOf(BcDevError);
    expect(secondError).toMatchObject({ code: "TEST_RUN_ACTIVE", category: "state" });
    metadata.resolve(new Response(JSON.stringify({ WebApiVersion: "7.0" })));
    await first;

    expect(hub.invoked("RunTests")).toHaveLength(1);
    expect(state.testRunActive).toBe(false);
  });

  test("test-running support cache expires and rechecks the server version", async () => {
    let now = 0;
    let webApiVersion = "7.0";
    let metadataCalls = 0;
    const fetchFn = (async () => {
      metadataCalls++;
      return new Response(JSON.stringify({ WebApiVersion: webApiVersion }));
    }) as unknown as typeof fetch;
    const { tools } = setup(hub, fetchFn, undefined, { now: () => now, serverInfoCacheTtlMs: 100 });
    hub.onInvoke = (method) => {
      if (method === "RunTests") queueMicrotask(() => hub.emit("TestRunCompleted", { Tests: [] }));
      return undefined;
    };

    await tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 50100 }] });
    now = 50;
    await tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 50100 }] });
    expect(metadataCalls).toBe(1);

    webApiVersion = "6.0";
    now = 101;
    const error = await tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 50100 }] }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "UNSUPPORTED_SERVER" });
    expect(metadataCalls).toBe(2);
    expect(hub.invoked("RunTests")).toHaveLength(2);
  });

  test("a timed-out metadata preflight releases the singleton test-run lock", async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as typeof fetch;
    const { state, tools } = setup(hub, hanging, undefined, { serverInfoTimeoutMs: 5 });
    const error = await tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 50100 }] }).catch((caught) => caught);
    expect(error).toMatchObject({ kind: "unreachable", message: expect.stringContaining("timed out") });
    expect(state.testRunActive).toBe(false);
    expect(hub.invoked("RunTests")).toHaveLength(0);
  });

  test("bcdev_test_run returns a summary and parsed, source-mapped failure", async () => {
    const { tools } = setup(hub);
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        queueMicrotask(() => {
          hub.emit("TestCompleted", 50100, "A", 1, 'boom\r\nAL Callstack:\r\n"T"(CodeUnit 50100).A() line 7 - Local app', 6);
          hub.emit("TestCompleted", 50100, "", 1, "rollup", 99);
          hub.emit("TestRunCompleted", { Tests: [] });
        });
      }
      return undefined;
    };
    const result = (await tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 50100 }] })) as {
      summary: Record<string, unknown>;
      results: Array<{ failure?: { parsed: boolean; callStack: Array<{ file: string | null }> } }>;
      nextSteps: string[];
    };
    expect(result.summary).toMatchObject({ outcome: "failed", total: 1, failed: 1, syntheticResults: 1, durationMs: 6 });
    expect(result.results[0]?.failure?.parsed).toBe(true);
    expect(result.results[0]?.failure?.callStack[0]?.file).toEndWith("T.Codeunit.al");
    expect(result.nextSteps.join(" ")).toContain("bcdev_debug_attach");
    expect(() => tools.get("bcdev_test_run")!.outputSchema.parse(result)).not.toThrow();
  });

  test("bcdev_debug_attach maps file/line breakpoints and stores session", async () => {
    const { state, tools } = setup(hub);
    hub.onInvoke = (method) => (method === "AddBreakpoint" ? { BreakpointId: 7 } : undefined);
    const attach = (await tools.get("bcdev_debug_attach")!.handler({
      breakpoints: [{ file: "T.Codeunit.al", line: 6 }],
    })) as Record<string, unknown>;
    expect(attach["breakpoints"]).toEqual([{
      breakpointId: 7,
      file: "T.Codeunit.al",
      line: 6,
      verification: {
        status: "unverified",
        methodName: null,
        internalMethodName: null,
        objectType: null,
        objectId: null,
        span: null,
      },
    }]);
    expect(state.debug).not.toBeNull();
  });

  test("bcdev_debug_attach guidance distinguishes next-session and exact-session modes", async () => {
    const next = setup(new FakeHub());
    const nextResult = await next.tools.get("bcdev_debug_attach")!.handler({}) as { nextSteps: string[] };
    expect(nextResult.nextSteps.join(" ")).toContain("Create or trigger the matching session");

    const user = setup(new FakeHub());
    const userResult = await user.tools.get("bcdev_debug_attach")!.handler({ userId: "alice" }) as { nextSteps: string[] };
    expect(userResult.nextSteps.join(" ")).toContain("Create or trigger the matching session");

    const exact = setup(new FakeHub());
    const exactResult = await exact.tools.get("bcdev_debug_attach")!.handler({ sessionId: 43210 }) as { nextSteps: string[] };
    expect(exactResult.nextSteps.join(" ")).toContain("confirm attachment");
  });

  test("bcdev_debug_breakpoints returns verified server location metadata", async () => {
    const { tools } = setup(hub);
    hub.onInvoke = (method) => method === "AddBreakpoint"
      ? {
          BreakpointId: 8,
          MethodName: "A",
          InternalMethodName: "A@0",
          ObjectId: { ObjectType: 5, ObjectNumber: 50100 },
          SourceSpan: { From: { Line: 5, Column: 0 }, To: { Line: 5, Column: 8 } },
        }
      : undefined;
    await tools.get("bcdev_debug_attach")!.handler({});
    const result = (await tools.get("bcdev_debug_breakpoints")!.handler({
      add: [{ file: "T.Codeunit.al", line: 6 }],
    })) as { added: Array<{ verification: Record<string, unknown> }> };
    expect(result.added[0]?.verification).toMatchObject({
      status: "verified",
      methodName: "A",
      internalMethodName: "A@0",
      objectType: 5,
      objectId: 50100,
      span: { from: { line: 6, column: 1 }, to: { line: 6, column: 9 } },
    });
    expect(() => tools.get("bcdev_debug_breakpoints")!.outputSchema.parse(result)).not.toThrow();
  });

  test("bcdev_debug_variables exposes server change flags", async () => {
    const { tools } = setup(hub);
    hub.onInvoke = (method) => method === "GetVariables"
      ? [{ Name: "Counter", TypeName: "Integer", Summary: "2", HasChildren: false, ChangeState: 2 }]
      : undefined;
    await tools.get("bcdev_debug_attach")!.handler({});
    const result = (await tools.get("bcdev_debug_variables")!.handler({ frameId: 0 })) as {
      variables: Array<{ changeState: string; changed: boolean }>;
    };
    expect(result.variables[0]).toMatchObject({ changeState: "valueChanged", changed: true });
    expect(() => tools.get("bcdev_debug_variables")!.outputSchema.parse(result)).not.toThrow();
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

  test("bcdev_debug_sql structures the statistics scope and fails actionably when insight is off", async () => {
    const { tools } = setup(hub);
    hub.onInvoke = (method, args) => {
      if (method === "GetVariables") {
        return [{ name: "<Database Statistics>", typeName: "", summary: "", hasChildren: true }];
      }
      if (method === "ExpandNode" && args[1] === "<Database Statistics>") {
        return [
          { name: "Current SQL Latency (ms)", typeName: "", summary: "0.5", hasChildren: false },
          { name: "Number of SQL Executes", typeName: "", summary: "3", hasChildren: false },
          { name: "<Last SQL Statements>", typeName: "", summary: "", hasChildren: false },
          { name: "<Last Long Running SQL Statements>", typeName: "", summary: "", hasChildren: false },
        ];
      }
      return undefined;
    };
    await tools.get("bcdev_debug_attach")!.handler({ sqlInsight: true });
    const insight = (await tools.get("bcdev_debug_sql")!.handler({})) as Record<string, unknown>;
    expect(insight).toMatchObject({ currentLatencyMs: 0.5, sqlExecutes: 3, lastStatements: [], lastLongRunning: [] });
    expect(() => tools.get("bcdev_debug_sql")!.outputSchema.parse(insight)).not.toThrow();

    hub.onInvoke = (method) => (method === "GetVariables" ? [] : undefined);
    const error = await tools.get("bcdev_debug_sql")!.handler({}).catch((caught) => caught);
    expect(error).toBeInstanceOf(BcDevError);
    expect(error).toMatchObject({ code: "SQL_INSIGHT_NOT_ENABLED", category: "state" });
    expect((error as Error).message).toMatch(/sqlInsight: true/);
  });

  test("bcdev_source uses the REST endpoint and reports empty base-app content as a message", async () => {
    const restFetch = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("dev/sourcecontent")) {
        const id = new URL(url).searchParams.get("id");
        return new Response(JSON.stringify(id === "1" ? { Content: "", IsALContent: false } : { Content: "codeunit 50130 X {}", IsALContent: true }));
      }
      return new Response(JSON.stringify({ WebApiVersion: "7.0" }));
    }) as unknown as typeof fetch;
    const { tools } = setup(hub, restFetch);
    const published = (await tools.get("bcdev_source")!.handler({ objectType: 5, objectId: 50130 })) as Record<string, unknown>;
    expect(published).toMatchObject({ content: "codeunit 50130 X {}", isAlContent: true, source: "rest" });
    expect(published["message"]).toBeUndefined();
    const baseApp = (await tools.get("bcdev_source")!.handler({ objectType: 5, objectId: 1 })) as Record<string, unknown>;
    expect(baseApp).toMatchObject({ content: "", isAlContent: false, source: "rest" });
    expect(baseApp["message"]).toContain("No deployed source");
    expect(hub.invoked("GetSourceContent")).toHaveLength(0);
  });

  test("bcdev_source falls back to the hub when REST has no source and a session is live", async () => {
    const notFoundFetch = (async (input: RequestInfo | URL) =>
      new Response(null, { status: input.toString().includes("sourcecontent") ? 404 : 200 })) as unknown as typeof fetch;
    const { tools } = setup(hub, notFoundFetch);
    // no session: 404 surfaces as the empty no-source result
    const empty = (await tools.get("bcdev_source")!.handler({ objectType: 5, objectId: 50130 })) as Record<string, unknown>;
    expect(empty).toMatchObject({ content: "", isAlContent: false, source: "rest" });
    expect(empty["message"]).toContain("No deployed source");

    hub.onInvoke = (method) => (method === "GetSourceContent" ? { Content: "from hub", IsALContent: true } : undefined);
    await tools.get("bcdev_debug_attach")!.handler({});
    const viaHub = (await tools.get("bcdev_source")!.handler({ objectType: 5, objectId: 50130 })) as Record<string, unknown>;
    expect(viaHub).toMatchObject({ content: "from hub", source: "hub" });
  });

  test("profiling next steps reflect unreachable, unsupported, and empty-capture results", async () => {
    const unreachable = setup(hub, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    const unreachableStatus = await unreachable.tools.get("bcdev_profile_status")!.handler({
      server: "http://localhost",
      serverInstance: "BC",
    }) as { reachable: boolean; nextSteps: string[] };
    expect(unreachableStatus.reachable).toBe(false);
    expect(unreachableStatus.nextSteps.join(" ")).toContain("Correct connectivity");

    const unsupported = setup(new FakeHub(), (async () =>
      new Response(JSON.stringify({ runtimeVersion: "2.0", webApiVersion: "2.0" }))) as unknown as typeof fetch);
    const unsupportedStatus = await unsupported.tools.get("bcdev_profile_status")!.handler({
      server: "http://localhost",
      serverInstance: "BC",
    }) as { sampleProfilingSupported: boolean; nextSteps: string[] };
    expect(unsupportedStatus.sampleProfilingSupported).toBe(false);
    expect(unsupportedStatus.nextSteps.join(" ")).toContain("supports the requested profile mode");

    const emptyCapture = setup(new FakeHub(), (async (input: RequestInfo | URL) =>
      input.toString().includes("attach")
        ? new Response('"NextSessionOnTenant"')
        : new Response(null, { headers: { "Content-Length": "0" } })) as unknown as typeof fetch);
    await emptyCapture.tools.get("bcdev_profile_start")!.handler({ server: "http://localhost", serverInstance: "BC" });
    const finished = await emptyCapture.tools.get("bcdev_profile_finish")!.handler({}) as { captured: boolean; nextSteps: string[] };
    expect(finished.captured).toBe(false);
    expect(finished.nextSteps.join(" ")).toContain("Start a new capture");
  });

  test("profile polling guidance handles every snapshot status", async () => {
    const cases = [
      ["Initialized", "Trigger or continue the target workload, then call bcdev_profile_poll again."],
      ["Started", "Call bcdev_profile_finish to save and summarize the capture."],
      ["Finished", "Call bcdev_profile_finish to retrieve and clear the completed capture."],
      ["Failed", "Call bcdev_profile_finish to clear the failed capture, then review the result before starting another capture."],
    ] as const;

    for (const [status, nextStep] of cases) {
      const current = setup(new FakeHub(), (async (input: RequestInfo | URL) =>
        input.toString().includes("attach")
          ? new Response('"NextSessionOnTenant"')
          : new Response(`"${status}"`)) as unknown as typeof fetch);
      await current.tools.get("bcdev_profile_start")!.handler({});
      const polled = await current.tools.get("bcdev_profile_poll")!.handler({}) as {
        status: string;
        ready: boolean;
        nextSteps: string[];
      };
      expect(polled.status).toBe(status);
      expect(polled.ready).toBe(status === "Started");
      expect(polled.nextSteps).toEqual([nextStep]);
    }
  });

  test("bcdev_debug_attach forwards precision break modes to the wire enums", async () => {
    const precisionHub = new FakeHub();
    const { tools } = setup(precisionHub);
    await tools.get("bcdev_debug_attach")!.handler({ breakOnError: "unhandled", breakOnRecordWrite: "nonTemporary" });
    precisionHub.emit("HubConnected");
    await Bun.sleep(0);
    expect(precisionHub.invoked("DebugAdapterConfigurationDone")[0]?.args[0]).toMatchObject({
      BreakOnError: true,
      BreakOnErrorBehaviour: 3,
      BreakOnRecordWrite: true,
      BreakOnRecordWriteBehaviour: 3,
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
      nextSteps: ["Drive the operation you want to inspect, if it has not already begun, then call bcdev_debug_wait again."],
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
    expect(timedOut).toEqual({
      timedOut: true,
      nextSteps: ["Confirm that the matching session or workload has been triggered, then call bcdev_debug_wait again."],
    });
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

  test("bcdev_debug_run_tests claims the singleton lock before a deferred metadata preflight", async () => {
    const metadata = deferred<Response>();
    const { state, tools } = setup(hub, (async () => await metadata.promise) as unknown as typeof fetch);
    hub.onInvoke = (method) => {
      if (method === "RunTests") queueMicrotask(() => hub.emit("TestRunCompleted", { Tests: [] }));
      return undefined;
    };
    await tools.get("bcdev_debug_attach")!.handler({});

    const first = tools.get("bcdev_debug_run_tests")!.handler({ codeunits: [{ id: 50100 }] });
    const secondError = await tools.get("bcdev_debug_run_tests")!.handler({ codeunits: [{ id: 50100 }] }).catch((caught) => caught);
    expect(secondError).toBeInstanceOf(BcDevError);
    expect(secondError).toMatchObject({ code: "TEST_RUN_ACTIVE", category: "state" });
    metadata.resolve(new Response(JSON.stringify({ WebApiVersion: "7.0" })));
    await first;
    const event = await tools.get("bcdev_debug_wait")!.handler({ timeoutMs: 200 }) as Record<string, unknown>;

    expect(event["kind"]).toBe("testRunFinished");
    expect(hub.invoked("RunTests")).toHaveLength(1);
    expect(state.testRunActive).toBe(false);
  });

  test("bcdev_debug_run_tests releases its claim when metadata preflight fails", async () => {
    const { state, tools } = setup(hub, (async () =>
      new Response(JSON.stringify({ WebApiVersion: "6.0" }))) as unknown as typeof fetch);
    await tools.get("bcdev_debug_attach")!.handler({});

    const error = await tools.get("bcdev_debug_run_tests")!.handler({ codeunits: [{ id: 50100 }] }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BcDevError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_SERVER" });
    expect(hub.invoked("RunTests")).toHaveLength(0);
    expect(state.testRunActive).toBe(false);
  });

  test("direct and debug-bound test entry points share the preflight lock", async () => {
    const metadata = deferred<Response>();
    const { state, tools } = setup(hub, (async () => await metadata.promise) as unknown as typeof fetch);
    hub.onInvoke = (method) => {
      if (method === "RunTests") queueMicrotask(() => hub.emit("TestRunCompleted", { Tests: [] }));
      return undefined;
    };
    await tools.get("bcdev_debug_attach")!.handler({});

    const direct = tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 50100 }] });
    const debugError = await tools.get("bcdev_debug_run_tests")!.handler({ codeunits: [{ id: 50100 }] }).catch((caught) => caught);
    expect(debugError).toBeInstanceOf(BcDevError);
    expect(debugError).toMatchObject({ code: "TEST_RUN_ACTIVE" });
    metadata.resolve(new Response(JSON.stringify({ WebApiVersion: "7.0" })));
    await direct;

    expect(hub.invoked("RunTests")).toHaveLength(1);
    expect(state.testRunActive).toBe(false);
  });

  test("debug-bound testRunFinished carries the same enriched result contract", async () => {
    const { tools } = setup(hub);
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        queueMicrotask(() => {
          hub.emit("TestCompleted", 50100, "A", 1, 'boom\nAL Callstack:\n"T"(CodeUnit 50100).A() line 7', 4);
          hub.emit("TestRunCompleted", { Tests: [] });
        });
      }
      return undefined;
    };
    await tools.get("bcdev_debug_attach")!.handler({});
    await tools.get("bcdev_debug_run_tests")!.handler({ codeunits: [{ id: 50100 }] });
    const event = (await tools.get("bcdev_debug_wait")!.handler({ timeoutMs: 500 })) as {
      kind: string;
      results: { summary: { outcome: string }; results: Array<{ failure?: { parsed: boolean } }> };
    };
    expect(event.kind).toBe("testRunFinished");
    expect(event.results.summary.outcome).toBe("failed");
    expect(event.results.results[0]?.failure?.parsed).toBe(true);
    expect(() => tools.get("bcdev_debug_wait")!.outputSchema.parse(event)).not.toThrow();
  });

  test("bcdev_debug_run_tests: a rejected background run surfaces a fatal event instead of an unhandled rejection", async () => {
    const normalFactory = fakeHubFactory(hub);
    const throwingFactory: ToolDeps["hubFactory"] = (url, options) => {
      if (url.includes("TestRunnerHub")) throw new Error("could not create test hub");
      return normalFactory(url, options);
    };
    const { state, tools } = setup(hub, undefined, throwingFactory);
    await tools.get("bcdev_debug_attach")!.handler({});
    const started = (await tools.get("bcdev_debug_run_tests")!.handler({ codeunits: [{ id: 1 }] })) as Record<string, unknown>;
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

  test("a passing remote test result does not require a readable local AL project", async () => {
    const { tools } = setup(hub);
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        queueMicrotask(() => {
          hub.emit("TestCompleted", 50100, "A", 0, "", 5);
          hub.emit("TestRunCompleted", { Tests: [] });
        });
      }
      return undefined;
    };
    const result = await tools.get("bcdev_test_run")!.handler({
      project: "/definitely/missing/al-project",
      environmentType: "OnPrem",
      server: "http://localhost",
      serverInstance: "BC",
      codeunits: [{ id: 50100 }],
    }) as Record<string, unknown>;
    expect(result["summary"]).toMatchObject({ outcome: "passed", total: 1 });
    expect(result["sourceMappingWarning"]).toBeUndefined();
  });

  test("local source-index failure is nonfatal when a failed stack needs mapping", async () => {
    const { tools } = setup(hub);
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        queueMicrotask(() => {
          hub.emit("TestCompleted", 50100, "A", 1, 'boom\nAL Callstack:\n"T"(CodeUnit 50100).A() line 7', 5);
          hub.emit("TestRunCompleted", { Tests: [] });
        });
      }
      return undefined;
    };
    const result = await tools.get("bcdev_test_run")!.handler({
      project: "/definitely/missing/al-project-with-stack",
      environmentType: "OnPrem",
      server: "http://localhost",
      serverInstance: "BC",
      codeunits: [{ id: 50100 }],
    }) as {
      summary: { outcome: string };
      results: Array<{ failure?: { callStack: Array<{ file: string | null }> } }>;
      sourceMappingWarning?: string;
    };
    expect(result.summary.outcome).toBe("failed");
    expect(result.results[0]?.failure?.callStack[0]?.file).toBeNull();
    expect(result.sourceMappingWarning).toContain("server test results are complete");
    expect(() => tools.get("bcdev_test_run")!.outputSchema.parse(result)).not.toThrow();
  });

  test("coverage mapping failure is nonfatal and names the unmapped coverage fields", async () => {
    const { tools } = setup(hub);
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        queueMicrotask(() => hub.emit("TestRunCompleted", {
          Tests: [{
            ApplicationObjectId: 50100,
            MethodId: 1,
            CoveredProcedures: [{ ObjectType: 5, ObjectId: 50100, MethodId: 2 }],
          }],
        }));
      }
      return undefined;
    };
    const result = await tools.get("bcdev_test_run")!.handler({
      project: "/definitely/missing/al-project-with-coverage",
      environmentType: "OnPrem",
      server: "http://localhost",
      serverInstance: "BC",
      codeunits: [{ id: 50100 }],
      coverage: "procedure",
    }) as {
      coverage: Array<{ coveredProcedures: Array<{ file?: string }> }>;
      sourceMappingWarning?: string;
    };
    expect(result.coverage[0]?.coveredProcedures[0]?.file).toBeUndefined();
    expect(result.sourceMappingWarning).toContain("coverage procedure file fields remain unset");
    expect(result.sourceMappingWarning).not.toContain("call-stack");
    expect(() => tools.get("bcdev_test_run")!.outputSchema.parse(result)).not.toThrow();
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

  test("bcdev_debug_attach rolls back and stops debugging when a user fatal arrives during Attach", async () => {
    const { state, tools } = setup(hub);
    hub.onInvoke = (method) => {
      if (method === "Attach") {
        hub.emit("OnFatalDebuggerException", "The user specified in your launch.json file cannot be found on the tenant.");
      }
      return undefined;
    };
    await expect(tools.get("bcdev_debug_attach")!.handler({ userId: "ghost-user" })).rejects.toThrow(/user-filtered session/);
    expect(state.debug).toBeNull();
    expect(hub.invoked("StopDebugging")).toHaveLength(1);
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
