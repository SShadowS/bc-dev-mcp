import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BcDevError } from "../../src/core/agent-errors";
import { createAuthorizationProviderFactory } from "../../src/core/authorization";
import { agentErrorBody } from "../../src/mcp/agent-errors";
import { ServerState } from "../../src/mcp/state";
import { createTools, type ToolDeps } from "../../src/mcp/tools";
import { FakeHub, fakeHubFactory } from "../fakes/fake-hub";
import { FakeNativeMcpGateway } from "../fakes/fake-native-mcp";

// MCP 2026-07-28 statelessness: start tools mint an opaque handle; follow-ups accept it optionally.

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "bcmcp-handles-"));
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(
    join(dir, ".vscode", "launch.json"),
    JSON.stringify({ configurations: [{ type: "al", request: "launch", server: "http://localhost", serverInstance: "BC" }] }),
  );
  writeFileSync(join(dir, "app.json"), JSON.stringify({ runtime: "16.0" }));
  return dir;
}

function setup() {
  const hub = new FakeHub();
  hub.onInvoke = (method) => (method === "GetVariables" ? [] : undefined);
  const state = new ServerState();
  const fetchFn = (async (u: RequestInfo | URL) => {
    const url = u.toString();
    if (url.includes("attach")) return new Response('"NextSessionOnTenant"');
    if (url.includes("status")) return new Response('"Started"');
    if (url.includes("finish")) return new Response("");
    return new Response(JSON.stringify({ WebApiVersion: "7.0" }));
  }) as unknown as typeof fetch;
  const deps: ToolDeps = {
    hubFactory: fakeHubFactory(hub),
    authorizationFactory: createAuthorizationProviderFactory(),
    http10Get: async () => { throw new Error("http10Get not expected in this test"); },
    fetchFn,
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" },
    cwd: project(),
    gitChanges: async (_project, baseRef) => ({ baseRef, mergeBase: "a".repeat(40), head: "workingTree", nonAlFiles: [], unresolvedAlFiles: [], files: [] }),
    callGraph: async () => ({ nodes: [], edges: [] }),
    nativeMcpGateway: new FakeNativeMcpGateway(),
  };
  const tools = new Map(createTools(state, deps).map((t) => [t.name, t]));
  const call = (name: string, params: Record<string, unknown> = {}) => {
    const tool = tools.get(name)!;
    // Same input validation the MCP server applies, so the handle field must be in the published schema.
    return tool.handler(z.object(tool.schema).strict().parse(params));
  };
  return { state, tools, call };
}

async function rejection(promise: Promise<unknown>): Promise<BcDevError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(BcDevError);
  return error as BcDevError;
}

const flows = [
  {
    field: "debugSessionId",
    start: ["bcdev_debug_attach", {}],
    followUp: ["bcdev_debug_variables", { frameId: 0 }],
    end: ["bcdev_debug_detach", {}],
  },
  {
    field: "profileId",
    start: ["bcdev_profile_start", {}],
    followUp: ["bcdev_profile_poll", {}],
    end: ["bcdev_profile_finish", {}],
  },
  {
    field: "recordingId",
    start: ["bcdev_record_writes_start", { tableId: 18 }],
    followUp: ["bcdev_record_writes_status", {}],
    end: ["bcdev_record_writes_finish", {}],
  },
] as const;

describe("stateless handles", () => {
  for (const { field, start, followUp, end } of flows) {
    describe(field, () => {
      test(`${start[0]} returns ${field} in structuredContent matching its outputSchema`, async () => {
        const { tools, call } = setup();
        const result = await call(start[0], start[1]) as Record<string, unknown>;
        expect(typeof result[field]).toBe("string");
        expect((result[field] as string).length).toBeGreaterThan(0);
        expect(tools.get(start[0])!.outputSchema.parse(result)).toMatchObject({ [field]: result[field] });
        expect(tools.get(start[0])!.description).toContain(field);
      });

      test("a matching handle works on follow-up and end tools", async () => {
        const { call } = setup();
        const id = (await call(start[0], start[1]) as Record<string, string>)[field];
        await call(followUp[0], { ...followUp[1], [field]: id });
        await call(end[0], { ...end[1], [field]: id });
      });

      test("an omitted handle still uses the single active slot", async () => {
        const { call } = setup();
        await call(start[0], start[1]);
        await call(followUp[0], followUp[1]);
        await call(end[0], end[1]);
      });

      test("a mismatched handle is rejected NOT_FOUND and leaves the active one intact", async () => {
        const { call } = setup();
        const id = (await call(start[0], start[1]) as Record<string, string>)[field]!;
        const error = await rejection(call(followUp[0], { ...followUp[1], [field]: "stale" }));
        expect(error).toMatchObject({ code: "NOT_FOUND", category: "state" });
        expect(error.details).toMatchObject({ handle: field, given: "stale", active: id, endTool: end[0] });
        const body = agentErrorBody(followUp[0], error);
        expect(body.nextSteps[0]).toContain(id);
        // the end tool also refuses a mismatch instead of tearing down someone else's capture
        await rejection(call(end[0], { ...end[1], [field]: "stale" }));
        await call(followUp[0], { ...followUp[1], [field]: id });
      });

      test("a handle from an ended capture is rejected NOT_FOUND with active null", async () => {
        const { call } = setup();
        const first = (await call(start[0], start[1]) as Record<string, string>)[field]!;
        await call(end[0], end[1]);
        const error = await rejection(call(followUp[0], { ...followUp[1], [field]: first }));
        expect(error.details).toMatchObject({ handle: field, given: first, active: null, startTool: start[0] });
        expect(agentErrorBody(followUp[0], error).nextSteps[0]).toContain(start[0]);
        const second = (await call(start[0], start[1]) as Record<string, string>)[field];
        expect(second).not.toBe(first);
      });
    });
  }

  test("slot-busy errors name the active handle", async () => {
    const { call } = setup();
    const debugSessionId = (await call("bcdev_debug_attach") as Record<string, string>)["debugSessionId"];
    const busy = await rejection(call("bcdev_debug_attach"));
    expect(busy).toMatchObject({ code: "DEBUG_SESSION_ACTIVE", details: { debugSessionId } });
    await call("bcdev_debug_detach");

    const recordingId = (await call("bcdev_record_writes_start", { tableId: 18 }) as Record<string, string>)["recordingId"];
    const triage = await rejection(call("bcdev_debug_wait", { timeoutMs: 1 }));
    expect(triage).toMatchObject({ code: "RECORD_WRITE_TRIAGE_ACTIVE", details: { recordingId } });
    await call("bcdev_record_writes_finish");

    const profileId = (await call("bcdev_profile_start") as Record<string, string>)["profileId"];
    expect(await rejection(call("bcdev_profile_start"))).toMatchObject({ code: "PROFILE_ACTIVE", details: { profileId } });
  });

  test("native passthrough accepts debugSessionId only for context=debugging", async () => {
    const { call } = setup();
    await call("bcdev_debug_attach");
    const error = await rejection(call("bcdev_native_list", {
      environmentType: "Sandbox",
      environmentName: "dev",
      tenant: "t",
      company: "C",
      context: "business",
      debugSessionId: "x",
    }));
    expect(error.code).toBe("INVALID_ARGUMENT");
    const stale = await rejection(call("bcdev_native_list", {
      environmentType: "Sandbox",
      environmentName: "dev",
      tenant: "t",
      company: "C",
      context: "debugging",
      debugSessionId: "x",
    }));
    expect(stale).toMatchObject({ code: "NOT_FOUND", details: { handle: "debugSessionId" } });
  });
});
