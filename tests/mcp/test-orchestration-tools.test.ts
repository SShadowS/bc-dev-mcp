import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorizationProviderFactory } from "../../src/core/authorization";
import type { AuthorizationProviderFactory } from "../../src/core/authorization";
import type { HubFactory } from "../../src/core/hubs/signalr-base";
import type { GitChangeSet } from "../../src/core/git-changes";
import { ServerState } from "../../src/mcp/state";
import { createTools, type ToolDeps } from "../../src/mcp/tools";
import { FakeHub } from "../fakes/fake-hub";
import { FakeNativeMcpGateway } from "../fakes/fake-native-mcp";

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "bcmcp-orchestration-"));
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(
    join(dir, ".vscode", "launch.json"),
    JSON.stringify({
      configurations: [{
        type: "al",
        request: "launch",
        server: "http://localhost",
        serverInstance: "BC",
      }],
    }),
  );
  writeFileSync(join(dir, "app.json"), JSON.stringify({ runtime: "16.0" }));
  writeFileSync(
    join(dir, "T.Codeunit.al"),
    'codeunit 50100 "T"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure A()\n    begin\n    end;\n}\n',
  );
  return dir;
}

interface SetupOptions {
  configureHub?: (hub: FakeHub, index: number) => void;
  fetchFn?: typeof fetch;
  authorizationFactory?: AuthorizationProviderFactory;
}

function setup(options: SetupOptions = {}) {
  const project = makeProject();
  const hubs: FakeHub[] = [];
  let active = 0;
  let maxActive = 0;
  const hubFactory: HubFactory = (url, connectOptions) => {
    const hub = new FakeHub();
    const index = hubs.length;
    hub.url = url;
    hub.opts = connectOptions;
    const start = hub.start.bind(hub);
    const stop = hub.stop.bind(hub);
    hub.start = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await start();
    };
    hub.stop = async () => {
      if (hub.started && !hub.stopped) active--;
      await stop();
    };
    options.configureHub?.(hub, index);
    hubs.push(hub);
    return hub;
  };
  const state = new ServerState();
  const gateway = new FakeNativeMcpGateway();
  const deps: ToolDeps = {
    hubFactory,
    authorizationFactory: options.authorizationFactory ?? createAuthorizationProviderFactory(),
    fetchFn: options.fetchFn
      ?? ((async () => new Response(JSON.stringify({ WebApiVersion: "7.0" }))) as unknown as typeof fetch),
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" },
    cwd: project,
    gitChanges: async (_project, baseRef): Promise<GitChangeSet> => ({
      baseRef,
      mergeBase: "a".repeat(40),
      head: "workingTree",
      files: [],
    }),
    nativeMcpGateway: gateway,
  };
  const tools = new Map(createTools(state, deps).map((tool) => [tool.name, tool]));
  return {
    project,
    state,
    gateway,
    hubs,
    tools,
    maxActive: () => maxActive,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(0);
  }
  throw new Error("condition did not become true");
}

describe("bcdev_test_orchestrate", () => {
  test("runs sequentially, retains enriched evidence, maps failures, and flags a flake", async () => {
    const statuses = [0, 1, 0];
    const { project, state, hubs, tools, maxActive } = setup({
      configureHub: (hub, index) => {
        hub.onInvoke = (method) => {
          if (method === "RunTests") {
            queueMicrotask(() => {
              const failed = statuses[index] === 1;
              hub.emit(
                "TestCompleted",
                50100,
                "A",
                statuses[index],
                failed
                  ? 'boom\nCallStack:\n"T"(CodeUnit 50100).A() line 7'
                  : "",
                index + 1,
              );
              hub.emit("TestRunCompleted", { Tests: [] });
            });
          }
          return undefined;
        };
      },
    });

    const tool = tools.get("bcdev_test_orchestrate")!;
    const result = await tool.handler({
      codeunits: [{ id: 50100, methods: ["A"] }],
    }) as {
      outcome: string;
      complete: boolean;
      summary: { flaky: number; totalDurationMs: number };
      runs: Array<{
        run: number;
        summary: { outcome: string };
        results: Array<{ failure?: { callStack: Array<{ file: string | null }> } }>;
      }>;
      diffs: Array<{ failed: { added: unknown[]; removed: unknown[] } }>;
      tests: Array<{ classification: string }>;
      nextSteps: string[];
    };

    expect(result).toMatchObject({
      outcome: "unstable",
      complete: true,
      summary: { flaky: 1, totalDurationMs: 6 },
      tests: [{ classification: "flaky" }],
    });
    expect(result.runs.map((run) => [run.run, run.summary.outcome])).toEqual([
      [1, "passed"],
      [2, "failed"],
      [3, "passed"],
    ]);
    expect(result.runs[1]?.results[0]?.failure?.callStack[0]?.file).toBe(
      join(project, "T.Codeunit.al"),
    );
    expect(result.diffs[0]?.failed.added).toEqual([{ codeunitId: 50100, method: "A" }]);
    expect(result.diffs[1]?.failed.removed).toEqual([{ codeunitId: 50100, method: "A" }]);
    expect(result.nextSteps.join(" ")).toContain("classified flaky");
    expect(hubs).toHaveLength(3);
    expect(hubs.every((hub) => hub.stopped)).toBe(true);
    expect(maxActive()).toBe(1);
    expect(state.testRunActive).toBe(false);
    expect(() => tool.outputSchema.parse(result)).not.toThrow();
  });

  test("holds the shared singleton lock against every other test execution path", async () => {
    const { state, gateway, hubs, tools } = setup({
      configureHub: (hub, index) => {
        if (index > 0) {
          hub.onInvoke = (method) => {
            if (method === "RunTests") {
              queueMicrotask(() => {
                hub.emit("TestCompleted", 50100, "A", 0, "", 1);
                hub.emit("TestRunCompleted", { Tests: [] });
              });
            }
            return undefined;
          };
        }
      },
    });

    const orchestration = tools.get("bcdev_test_orchestrate")!.handler({
      codeunits: [{ id: 50100, methods: ["A"] }],
      runs: 2,
    });
    expect(state.testRunActive).toBe(true);

    // requireSession only needs an owned manual-session value before claimTestRun rejects.
    state.debug = {} as never;
    const errors = await Promise.all([
      tools.get("bcdev_test_run")!.handler({ codeunits: [{ id: 50100 }] }).catch((error) => error),
      tools.get("bcdev_test_orchestrate")!.handler({
        codeunits: [{ id: 50100 }],
        runs: 2,
      }).catch((error) => error),
      tools.get("bcdev_debug_run_tests")!.handler({
        codeunits: [{ id: 50100 }],
      }).catch((error) => error),
      tools.get("bcdev_native_call")!.handler({
        company: "CRONUS",
        context: "runtime",
        toolName: "run_tests",
        arguments: {},
      }).catch((error) => error),
    ]);
    for (const error of errors) {
      expect(error).toMatchObject({ code: "TEST_RUN_ACTIVE", category: "state" });
    }
    expect(gateway.toolCalls).toHaveLength(0);

    await waitFor(() => hubs.length === 1 && hubs[0]!.handlers.has("TestRunCompleted"));
    hubs[0]!.emit("TestCompleted", 50100, "A", 0, "", 1);
    hubs[0]!.emit("TestRunCompleted", { Tests: [] });
    await orchestration;

    expect(hubs).toHaveLength(2);
    expect(state.testRunActive).toBe(false);
  });

  test("stops after an aborted run and marks later requested observations missing", async () => {
    const { hubs, state, tools } = setup({
      configureHub: (hub, index) => {
        hub.onInvoke = (method) => {
          if (method === "RunTests") {
            queueMicrotask(() => {
              hub.emit("TestCompleted", 50100, "A", 0, "", 1);
              if (index === 0) hub.close(new Error("socket dropped"));
              else hub.emit("TestRunCompleted", { Tests: [] });
            });
          }
          return undefined;
        };
      },
    });

    const tool = tools.get("bcdev_test_orchestrate")!;
    const result = await tool.handler({
      codeunits: [{ id: 50100, methods: ["A"] }],
      runs: 3,
    }) as {
      runsAttempted: number;
      complete: boolean;
      outcome: string;
      runs: Array<{ runAborted?: boolean }>;
      tests: Array<{
        classification: string;
        complete: boolean;
        missingCount: number;
        observations: Array<{ status: string }>;
      }>;
      warnings: string[];
      nextSteps: string[];
    };

    expect(result).toMatchObject({
      runsAttempted: 1,
      complete: false,
      outcome: "incomplete",
    });
    expect(result.runs.map((run) => run.runAborted === true)).toEqual([true]);
    expect(result.tests[0]).toMatchObject({
      classification: "incomplete",
      complete: false,
      missingCount: 2,
      observations: [
        { status: "passed" },
        { status: "missing" },
        { status: "missing" },
      ],
    });
    expect(result.warnings.join(" ")).toContain("server-side cancellation could not be confirmed");
    expect(result.nextSteps.join(" ")).toContain("before making a stability claim");
    expect(hubs).toHaveLength(1);
    expect(state.testRunActive).toBe(false);
    expect(() => tool.outputSchema.parse(result)).not.toThrow();
  });

  test("retains earlier attempts when authorization rejects between runs", async () => {
    let authorizationCalls = 0;
    const { hubs, state, tools } = setup({
      authorizationFactory: () => ({
        getAuthorizationHeader: async () => {
          authorizationCalls++;
          if (authorizationCalls === 3) {
            throw new Error("Authorization: Bearer must-not-leak");
          }
          return "Basic dTpw";
        },
      }),
      configureHub: (hub) => {
        hub.onInvoke = (method) => {
          if (method === "RunTests") {
            queueMicrotask(() => {
              hub.emit("TestCompleted", 50100, "A", 0, "", 1);
              hub.emit("TestRunCompleted", { Tests: [] });
            });
          }
          return undefined;
        };
      },
    });

    const tool = tools.get("bcdev_test_orchestrate")!;
    const result = await tool.handler({
      codeunits: [{ id: 50100, methods: ["A"] }],
      runs: 3,
    }) as {
      runsAttempted: number;
      complete: boolean;
      outcome: string;
      runs: Array<{ run: number; runAborted?: boolean; abortReason?: string }>;
      tests: Array<{ observations: Array<{ status: string }> }>;
    };

    expect(result).toMatchObject({
      runsAttempted: 2,
      complete: false,
      outcome: "incomplete",
      runs: [
        { run: 1 },
        { run: 2, runAborted: true },
      ],
    });
    expect(result.runs[1]?.abortReason).toContain("Attempt 2 failed");
    expect(result.runs[1]?.abortReason).toContain("[REDACTED]");
    expect(result.runs[1]?.abortReason).not.toContain("must-not-leak");
    expect(result.tests[0]?.observations.map((entry) => entry.status)).toEqual([
      "passed",
      "missing",
      "missing",
    ]);
    expect(hubs).toHaveLength(1);
    expect(state.testRunActive).toBe(false);
    expect(() => tool.outputSchema.parse(result)).not.toThrow();
  });

  test("observes client cancellation between attempts without cancelling an active server run", async () => {
    const controller = new AbortController();
    const { hubs, state, tools } = setup({
      configureHub: (hub, index) => {
        hub.onInvoke = (method) => {
          if (method === "RunTests") {
            queueMicrotask(() => {
              hub.emit("TestCompleted", 50100, "A", 0, "", 1);
              if (index === 0) controller.abort();
              hub.emit("TestRunCompleted", { Tests: [] });
            });
          }
          return undefined;
        };
      },
    });

    const result = await tools.get("bcdev_test_orchestrate")!.handler({
      codeunits: [{ id: 50100, methods: ["A"] }],
      runs: 3,
    }, { signal: controller.signal }) as {
      runsAttempted: number;
      complete: boolean;
      warnings: string[];
    };

    expect(result.runsAttempted).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toContain("Client cancellation was observed between attempts");
    expect(hubs).toHaveLength(1);
    expect(state.testRunActive).toBe(false);
  });

  test("keeps source mapping nonfatal when the explicit project is unreadable", async () => {
    const { tools } = setup({
      configureHub: (hub) => {
        hub.onInvoke = (method) => {
          if (method === "RunTests") {
            queueMicrotask(() => {
              hub.emit(
                "TestCompleted",
                50100,
                "A",
                1,
                'boom\nCallStack:\n"T"(CodeUnit 50100).A() line 7',
                1,
              );
              hub.emit("TestRunCompleted", { Tests: [] });
            });
          }
          return undefined;
        };
      },
    });

    const result = await tools.get("bcdev_test_orchestrate")!.handler({
      project: join(tmpdir(), "definitely-missing-orchestration-project"),
      environmentType: "OnPrem",
      server: "http://localhost",
      serverInstance: "BC",
      codeunits: [{ id: 50100, methods: ["A"] }],
      runs: 2,
    }) as {
      outcome: string;
      runs: Array<{
        sourceMappingWarning?: string;
        results: Array<{ failure?: { callStack: Array<{ file: string | null }> } }>;
      }>;
    };

    expect(result.outcome).toBe("failed");
    for (const run of result.runs) {
      expect(run.sourceMappingWarning).toContain("call-stack file fields remain null");
      expect(run.results[0]?.failure?.callStack[0]?.file).toBeNull();
    }
  });

  test("claims before unsupported-server preflight and releases on failure", async () => {
    const { state, hubs, tools } = setup({
      fetchFn: (async () =>
        new Response(JSON.stringify({ WebApiVersion: "6.0" }))) as unknown as typeof fetch,
    });

    const pending = tools.get("bcdev_test_orchestrate")!.handler({
      codeunits: [{ id: 50100 }],
      runs: 2,
    });
    expect(state.testRunActive).toBe(true);
    const error = await pending.catch((caught) => caught);
    expect(error).toMatchObject({ code: "UNSUPPORTED_SERVER", category: "server" });
    expect(state.testRunActive).toBe(false);
    expect(hubs).toHaveLength(0);
  });

  test("publishes bounded repeat-count validation", () => {
    const { tools } = setup();
    const schema = tools.get("bcdev_test_orchestrate")!.schema["runs"] as unknown as {
      safeParse(value: unknown): { success: boolean };
    };
    expect(schema.safeParse(1).success).toBe(false);
    expect(schema.safeParse(2).success).toBe(true);
    expect(schema.safeParse(20).success).toBe(true);
    expect(schema.safeParse(21).success).toBe(false);
  });

  test("rejects overlapping codeunit selections while allowing disjoint split groups", () => {
    const { tools } = setup();
    const orchestrationSchema = tools.get("bcdev_test_orchestrate")!.schema["codeunits"] as unknown as {
      safeParse(value: unknown): { success: boolean };
    };
    const directSchema = tools.get("bcdev_test_run")!.schema["codeunits"] as unknown as {
      safeParse(value: unknown): { success: boolean };
    };
    const overlapping = [
      [{ id: 50100 }, { id: 50100, methods: ["A"] }],
      [{ id: 50100, methods: ["A"] }, { id: 50100, methods: ["a"] }],
      [{ id: 50100, methods: ["A", "A"] }],
    ];
    for (const plan of overlapping) {
      expect(orchestrationSchema.safeParse(plan).success).toBe(false);
      expect(directSchema.safeParse(plan).success).toBe(false);
    }
    expect(orchestrationSchema.safeParse([
      { id: 50100, methods: ["A"] },
      { id: 50100, methods: ["B"] },
      { id: 50101 },
    ]).success).toBe(true);
  });
});
