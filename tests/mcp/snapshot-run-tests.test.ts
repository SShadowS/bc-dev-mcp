import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BcDevError } from "../../src/core/agent-errors";
import type { NativeMcpCallResponse } from "../../src/core/native-mcp";
import type { ConnectionConfig } from "../../src/core/types";
import { agentErrorBody } from "../../src/mcp/agent-errors";
import { ServerState, type SnapshotCapture } from "../../src/mcp/state";
import { createSnapshotTools } from "../../src/mcp/tools/snapshot-tools";
import type { ToolDeps } from "../../src/mcp/tools/shared";
import { FakeNativeMcpGateway } from "../fakes/fake-native-mcp";

const FIXTURES = join(import.meta.dir, "../fixtures/snapshot-debug");
const ZIP = readFileSync(join(FIXTURES, "page-exception.zip"));
const SNAPSHOT_JSON = JSON.parse(readFileSync(join(FIXTURES, "page-exception.snapshot.json"), "utf8"));
const TOOL = "bcdev_snapshot_run_tests";

const ONPREM: ConnectionConfig = {
  environmentType: "OnPrem", authentication: "UserPassword", server: "http://Cronus29", serverInstance: "BC", tenant: "default", username: "u", password: "p",
};

// Shape observed from the Cronus29 probe (BC 29.0.56030.0, 2026-10-14): Hello Bug Demo test codeunit 50131.
const OBSERVED = {
  success: false,
  codeunitResults: [{
    codeunitId: 50131,
    success: false,
    errorMessage: "Attempted to divide by zero.",
    testResults: [
      { methodName: "FailsOnZeroPayments", status: "Failed", message: "Attempted to divide by zero." },
      { methodName: "SplitsEvenly", status: "Success", message: "" },
    ],
  }],
  snapshotDebugging: { debuggingContext: "ctx-1", attached: true, verbosity: "SnapPoint" },
};

const text = (t: string, isError = false): NativeMcpCallResponse => ({
  server: { name: "Business Central", version: "29.0" },
  result: { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) },
});

function capture(over: Partial<SnapshotCapture> = {}): SnapshotCapture {
  return {
    captureKind: "snapshot", snapshotId: "snap-1", debuggingContext: "ctx-1", affinityCookie: null, attachKind: "NextSessionOnTenant",
    snapshotPort: 7083, config: ONPREM, authorization: { getAuthorizationHeader: async () => "Basic dTpw" },
    startedAt: new Date().toISOString(), token: Symbol("snapshot"), phase: "armed", snappoints: [], verbosity: "snappoint", ...over,
  };
}

function setup(env: Record<string, string> = {}) {
  const state = new ServerState();
  state.capture = capture();
  const gateway = new FakeNativeMcpGateway();
  gateway.onCall = () => text(JSON.stringify(OBSERVED));
  const fetchFn = (async (u: RequestInfo | URL) => {
    const op = new URL(u.toString()).pathname.split("/").pop();
    if (op === "status") return new Response('"Finished"');
    if (op === "finish") return new Response(ZIP);
    throw new Error(`unexpected ${String(u)}`);
  }) as unknown as typeof fetch;
  const deps = {
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p", ...env },
    cwd: mkdtempSync(join(tmpdir(), "bcsnaprun-")),
    fetchFn,
    nativeMcpGateway: gateway,
  } as unknown as ToolDeps;
  const tools = new Map(createSnapshotTools(state, deps, {
    runJson: async () => ({ ok: true, json: structuredClone(SNAPSHOT_JSON) }),
    supports: async () => true,
    resolveConverter: async () => "C:/fake/conv.exe",
    saveDir: join(mkdtempSync(join(tmpdir(), "bcsnaprun-save-")), "s"),
  }).map((t) => [t.name, t]));
  const call = async (name: string, params: Record<string, unknown>) => (await tools.get(name)!.handler(params)) as Record<string, any>;
  const fail = async (name: string, params: Record<string, unknown>) => {
    const e = await call(name, params).then(() => { throw new Error(`${name} succeeded`); }, (x: unknown) => x);
    expect(e).toBeInstanceOf(BcDevError);
    return e as BcDevError;
  };
  return { state, gateway, call, fail };
}

const RUN = { codeunits: [{ id: 50131 }] };

describe("bcdev_snapshot_run_tests", () => {
  test("1. happy path: run_tests on the snapshot context with the capture's debuggingContext; output mapped; armed + lock released", async () => {
    const s = setup();
    const out = await s.call(TOOL, RUN);
    expect(s.gateway.toolCalls).toHaveLength(1);
    const { target, name, args } = s.gateway.toolCalls[0]!;
    expect(name).toBe("run_tests");
    expect(args).toEqual({ debuggingContext: "ctx-1", testCases: [{ codeunitId: 50131 }] });
    expect(target).toMatchObject({ kind: "onprem", context: "snapshot", apiPort: 7048, config: ONPREM });
    expect((target as { company?: string }).company).toBeUndefined();
    expect(await target.authorization.getAuthorizationHeader()).toBe("Basic dTpw");
    expect(out).toEqual({
      attached: true,
      verbosity: "SnapPoint",
      success: false,
      codeunits: [{
        id: 50131,
        success: false,
        errorMessage: "Attempted to divide by zero.",
        methods: [
          { name: "FailsOnZeroPayments", status: "Failed", message: "Attempted to divide by zero." },
          { name: "SplitsEvenly", status: "Success", message: "" },
        ],
      }],
    });
    expect(s.state.capture?.phase).toBe("armed");
    expect(s.state.testRunActive).toBe(false);
  });

  test("2. methods -> testMethods, company -> companyName (and target company); apiPort from BC_DEV_API_PORT", async () => {
    const s = setup({ BC_DEV_API_PORT: "7148" });
    await s.call(TOOL, { codeunits: [{ id: 50131, methods: ["FailsOnZeroPayments"] }], company: "CRONUS Danmark A/S" });
    const { target, args } = s.gateway.toolCalls[0]!;
    expect(args).toEqual({ debuggingContext: "ctx-1", testCases: [{ codeunitId: 50131, testMethods: ["FailsOnZeroPayments"] }], companyName: "CRONUS Danmark A/S" });
    expect(target).toMatchObject({ company: "CRONUS Danmark A/S", apiPort: 7148 });
  });

  test("3. snapshotDebugging missing -> attached null + warning; attached false -> not-attached warning", async () => {
    const s = setup();
    const { snapshotDebugging: _, ...noSnap } = OBSERVED;
    s.gateway.onCall = () => text(JSON.stringify(noSnap));
    const a = await s.call(TOOL, RUN);
    expect(a["attached"]).toBeNull();
    expect(a["warnings"]).toHaveLength(1);
    s.gateway.onCall = () => text(JSON.stringify({ ...OBSERVED, snapshotDebugging: { attached: false } }));
    const b = await s.call(TOOL, RUN);
    expect(b["attached"]).toBe(false);
    expect(b["warnings"]).toEqual(["this test run was not attached to the capture"]);
  });

  test("4. unreadable results -> PROTOCOL_ERROR with a fixed message, no body echo", async () => {
    const s = setup();
    s.gateway.onCall = () => text("not json SECRETBODY");
    const e = await s.fail(TOOL, RUN);
    expect(e.code).toBe("PROTOCOL_ERROR");
    expect(e.message).toBe("bc-dev-mcp could not read the run_tests result");
    expect(JSON.stringify(e.details)).not.toContain("SECRETBODY");
    s.gateway.onCall = () => text('{"success":true}');
    const e2 = await s.fail(TOOL, RUN);
    expect(e2.code).toBe("PROTOCOL_ERROR");
    expect(e2.message).toBe("bc-dev-mcp could not read the run_tests result");
    expect(s.state.capture?.phase).toBe("armed");
    expect(s.state.testRunActive).toBe(false);
  });

  test("5. isError -> SERVER_REJECTED, redacted, at most 300 chars", async () => {
    const s = setup();
    s.gateway.onCall = () => text(`Request failed. Authorization: Basic xyz ${"x".repeat(1000)}`, true);
    const e = await s.fail(TOOL, RUN);
    expect(e.code).toBe("SERVER_REJECTED");
    expect(e.message.length).toBeLessThanOrEqual(300);
    expect(e.message).not.toContain("xyz");
  });

  test("6. preconditions in order", async () => {
    const s = setup();
    const snap = s.state.capture!;
    s.state.capture = { ...snap, captureKind: "profile", profileId: "p-1", profileKind: "sampling" } as never;
    expect((await s.fail(TOOL, { ...RUN, snapshotId: "other" })).code).toBe("PROFILE_ACTIVE");
    s.state.capture = snap;
    expect((await s.fail(TOOL, { ...RUN, snapshotId: "other" })).code).toBe("NOT_FOUND");
    s.state.capture = null;
    expect((await s.fail(TOOL, RUN)).code).toBe("SNAPSHOT_NOT_ACTIVE");
    s.state.capture = capture({ phase: "attaching", config: { environmentType: "Sandbox", authentication: "EntraId", environmentName: "s", tenant: "t" } });
    s.state.testRunActive = true;
    const attaching = await s.fail(TOOL, RUN);
    expect(attaching.code).toBe("PROFILE_ACTIVE");
    expect(attaching.details["phase"]).toBe("attaching");
    s.state.capture.phase = "armed";
    const cloud = await s.fail(TOOL, RUN);
    expect(cloud.code).toBe("UNSUPPORTED_SERVER");
    expect(cloud.message).toContain("verified on-prem only");
    s.state.capture = capture();
    expect((await s.fail(TOOL, RUN)).code).toBe("TEST_RUN_ACTIVE");
    expect(s.state.testRunActive).toBe(true); // a refused call never releases someone else's lock
    expect(s.state.capture.phase).toBe("armed");
    expect(s.gateway.toolCalls).toHaveLength(0);
  });

  test("7. while the run is pending, finish and status refuse phase testing with a wait step; afterwards finish works", async () => {
    const s = setup();
    let release!: (r: NativeMcpCallResponse) => void;
    s.gateway.onCall = () => new Promise((r) => { release = r; });
    const run = s.call(TOOL, RUN);
    expect(s.state.capture?.phase).toBe("testing");
    expect(s.state.testRunActive).toBe(true);
    for (const name of ["bcdev_snapshot_finish", "bcdev_snapshot_status"]) {
      const e = await s.fail(name, {});
      expect(e.code).toBe("PROFILE_ACTIVE");
      expect(e.details["phase"]).toBe("testing");
      expect(agentErrorBody(name, e).nextSteps.join(" ").toLowerCase()).toContain("wait");
    }
    expect((await s.fail(TOOL, RUN)).code).toBe("PROFILE_ACTIVE");
    await new Promise((r) => setTimeout(r, 0));
    release(text(JSON.stringify(OBSERVED)));
    expect((await run)["attached"]).toBe(true);
    expect(s.state.capture?.phase).toBe("armed");
    expect(s.state.testRunActive).toBe(false);
    const fin = await s.call("bcdev_snapshot_finish", {});
    expect(fin["decodeStatus"]).toBe("decoded");
    expect(s.state.capture).toBeNull();
  });

  test("8. operation timeout -> TIMEOUT not retryable, upstreamRunCancelled false; connect timeout stays retryable", async () => {
    const s = setup();
    s.gateway.onCall = () => { throw new BcDevError("TIMEOUT", "native call timed out", "network", true, { timeoutPhase: "operation" }); };
    const e = await s.fail(TOOL, RUN);
    expect(e.code).toBe("TIMEOUT");
    expect(e.retryable).toBe(false);
    expect(e.details["upstreamRunCancelled"]).toBe(false);
    expect(agentErrorBody(TOOL, e).nextSteps.join(" ")).toContain("bcdev_snapshot_finish");
    expect(s.state.capture?.phase).toBe("armed");
    expect(s.state.testRunActive).toBe(false);

    s.gateway.onCall = () => { throw new BcDevError("TIMEOUT", "connect timed out", "network", true, { timeoutPhase: "connect" }); };
    const c = await s.fail(TOOL, RUN);
    expect(c.retryable).toBe(true);
    expect(c.details["upstreamRunCancelled"]).toBeUndefined();
    expect(s.state.capture?.phase).toBe("armed");
  });

  test("9. caps: 500 methods per codeunit with omittedMethods; messages cut at 2,000 chars", async () => {
    const s = setup();
    const many = Array.from({ length: 600 }, (_, i) => ({ methodName: `M${i}`, status: "Success" }));
    many[0] = { methodName: "M0", status: "Failed", message: "m".repeat(5000) } as never;
    s.gateway.onCall = () => text(JSON.stringify({ ...OBSERVED, codeunitResults: [{ codeunitId: 1, success: false, errorMessage: "e".repeat(5000), testResults: many }] }));
    const out = await s.call(TOOL, RUN);
    const cu = out["codeunits"][0];
    expect(cu.methods).toHaveLength(500);
    expect(cu.omittedMethods).toBe(100);
    expect(cu.methods[0].message).toHaveLength(2000);
    expect(cu.errorMessage).toHaveLength(2000);
  });
});
