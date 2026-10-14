import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BcDevError } from "../../src/core/agent-errors";
import { agentErrorBody } from "../../src/mcp/agent-errors";
import { createAuthorizationProviderFactory } from "../../src/core/authorization";
import { ServerState, type ProfileCapture } from "../../src/mcp/state";
import { createSnapshotTools } from "../../src/mcp/tools/snapshot-tools";
import type { ToolDeps } from "../../src/mcp/tools/shared";
import type { SnapshotJsonRunner } from "../../src/core/snapshot/run-converter";
import { FakeNativeMcpGateway } from "../fakes/fake-native-mcp";

const FIXTURES = join(import.meta.dir, "../fixtures/snapshot-debug");
const ZIP = readFileSync(join(FIXTURES, "page-exception.zip"));
const SNAPSHOT_JSON = JSON.parse(readFileSync(join(FIXTURES, "page-exception.snapshot.json"), "utf8"));
const conn = { server: "http://bc", serverInstance: "BC", tenant: "default" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
interface Fake { fetchFn: typeof fetch; calls: Array<{ op: string; url: URL; body: unknown; cookie: string | null }>; routes: Record<string, Route> }

function fakeServer(): Fake {
  const calls: Fake["calls"] = [];
  const routes: Record<string, Route> = {
    snapshotendpointmetadata: () => Response.json({ runtimeVersion: "18.0", webApiVersion: "5.0" }),
    attach: () => new Response('"NextSessionOnTenant"'),
    status: () => new Response('"Started"'),
    finish: () => new Response(ZIP),
  };
  const fetchFn = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(u.toString());
    const op = url.pathname.split("/").pop()!;
    calls.push({ op, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, cookie: new Headers(init?.headers).get("cookie") });
    const route = routes[op];
    if (!route) throw new Error(`unexpected ${url}`);
    return route(url, init);
  }) as unknown as typeof fetch;
  return { fetchFn, calls, routes };
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "bcsnap-proj-"));
  mkdirSync(join(dir, "src"));
  const lines = ['page 50152 "Trigger Demo Page"', ...Array.from({ length: 40 }, (_, i) => `    // ${i + 2}`)];
  writeFileSync(join(dir, "src", "TriggerDemoPage.Page.al"), lines.join("\n"));
  return dir;
}

interface Setup {
  state: ServerState;
  fake: Fake;
  saveDir: string;
  cwd: string;
  call: (name: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  fail: (name: string, params?: Record<string, unknown>) => Promise<BcDevError>;
}

function setup(seams: Partial<Parameters<typeof createSnapshotTools>[2]> = {}, env: Record<string, string> = {}): Setup {
  const state = new ServerState();
  const fake = fakeServer();
  const cwd = project();
  const saveDir = join(mkdtempSync(join(tmpdir(), "bcsnap-save-")), "nested", "snapshots");
  const runJson: SnapshotJsonRunner = async () => ({ ok: true, json: structuredClone(SNAPSHOT_JSON) });
  const deps: ToolDeps = {
    hubFactory: (() => { throw new Error("no hub"); }) as never,
    authorizationFactory: createAuthorizationProviderFactory(),
    http10Get: async () => { throw new Error("http10Get not expected"); },
    fetchFn: fake.fetchFn,
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p", ...env },
    cwd,
    gitChanges: async () => { throw new Error("no git"); },
    callGraph: async () => ({ nodes: [], edges: [] }),
    nativeMcpGateway: new FakeNativeMcpGateway(),
  };
  const tools = new Map(createSnapshotTools(state, deps, {
    runJson, supports: async () => true, resolveConverter: async () => "C:/fake/conv.exe", saveDir, ...seams,
  }).map((t) => [t.name, t]));
  const call = async (name: string, params: Record<string, unknown> = {}) =>
    (await tools.get(name)!.handler(name === "bcdev_snapshot_status" ? params : { ...conn, ...params })) as Record<string, unknown>;
  const fail = async (name: string, params: Record<string, unknown> = {}) => {
    const e = await call(name, params).then(() => { throw new Error(`${name} succeeded`); }, (x: unknown) => x);
    expect(e).toBeInstanceOf(BcDevError);
    return e as BcDevError;
  };
  return { state, fake, saveDir, cwd, call, fail };
}

const SNAP = { snappoints: [{ file: "src/TriggerDemoPage.Page.al", line: 35 }] };
const finishes = (s: Setup) => s.fake.calls.filter((c) => c.op === "finish").length;

describe("snapshot tools", () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  test("registers the four tools", () => {
    expect([...createSnapshotTools(new ServerState(), {} as ToolDeps).map((t) => t.name)].sort()).toEqual([
      "bcdev_snapshot_finish", "bcdev_snapshot_run_tests", "bcdev_snapshot_start", "bcdev_snapshot_status",
    ]);
  });

  test("1. success: start (Line 34, ExecutionContext 1), status Started, finish decoded with points and the saved zip; slot cleared", async () => {
    const start = await s.call("bcdev_snapshot_start", SNAP);
    expect(start["snapshotId"]).toMatch(UUID);
    expect(start).toMatchObject({ attachKind: "NextSessionOnTenant", verbosity: "snappoint", snappoints: [{ objectType: "page", objectId: 50152, line: 35, unverified: false }] });
    const attach = s.fake.calls.find((c) => c.op === "attach")!.body as Record<string, any>;
    expect(attach["ExecutionContext"]).toBe(1);
    expect(attach["SourceBreakpointLocations"][0]).toEqual({ Id: { ObjectType: 8, ObjectNumber: 50152 }, Lines: [{ Position: { Line: 34, Column: 0 } }] });
    expect(attach["DebuggingContext"]).toBe(start["debuggingContext"]);
    expect(s.state.capture?.phase).toBe("armed");

    expect(await s.call("bcdev_snapshot_status", { snapshotId: start["snapshotId"] })).toEqual({ status: "Started", ready: true });

    const fin = await s.call("bcdev_snapshot_finish", { snapshotId: start["snapshotId"] });
    expect(fin["decodeStatus"]).toBe("decoded");
    expect((fin["points"] as Array<{ reasons: string[]; line: number }>).map((p) => [p.reasons, p.line])).toEqual([[["exception"], 36], [["snappoint"], 35]]);
    expect(fin["classification"]).toBe("complete");
    expect((fin["points"] as Array<{ source?: { entry: string } }>)[1]!.source?.entry).toBe("Page%50152.al");
    expect(Buffer.compare(readFileSync(fin["zipPath"] as string), ZIP)).toBe(0);
    expect(s.state.capture).toBeNull();
  });

  test("2. empty: a 0-byte finish body is decodeStatus empty, no zipPath, slot cleared", async () => {
    s.fake.routes["finish"] = () => new Response(new Uint8Array(0));
    await s.call("bcdev_snapshot_start", SNAP);
    const fin = await s.call("bcdev_snapshot_finish");
    expect(fin["decodeStatus"]).toBe("empty");
    expect(fin["zipPath"]).toBeUndefined();
    expect(typeof fin["hint"]).toBe("string");
    expect(s.state.capture).toBeNull();
  });

  test("3. raw: converter without snapshot-json, or no converter at all, saves the zip with one install warning", async () => {
    for (const seam of [{ supports: async () => false }, { resolveConverter: async () => null }]) {
      const t = setup(seam);
      await t.call("bcdev_snapshot_start", SNAP);
      const fin = await t.call("bcdev_snapshot_finish");
      expect(fin["decodeStatus"]).toBe("raw");
      expect(existsSync(fin["zipPath"] as string)).toBe(true);
      expect(fin["warnings"]).toHaveLength(1);
      expect((fin["warnings"] as string[])[0]).toContain("bc-mdc-converter 0.2.0");
      expect(t.state.capture).toBeNull();
    }
  });

  test("4. converter failure: failed at convert, zip kept", async () => {
    const t = setup({ runJson: async () => ({ ok: false, error: "x" }) });
    await t.call("bcdev_snapshot_start", SNAP);
    const fin = await t.call("bcdev_snapshot_finish");
    expect(fin).toMatchObject({ decodeStatus: "failed", failedStage: "convert", error: "x" });
    expect(existsSync(fin["zipPath"] as string)).toBe(true);
    expect(t.state.capture).toBeNull();
  });

  test("5. archive over the size limit: failed at download, nothing saved, slot released", async () => {
    const t = setup({ zipBytes: 100 });
    await t.call("bcdev_snapshot_start", SNAP);
    const fin = await t.call("bcdev_snapshot_finish");
    expect(fin).toMatchObject({ decodeStatus: "failed", failedStage: "download" });
    expect(fin["zipPath"]).toBeUndefined();
    expect(existsSync(t.saveDir)).toBe(false);
    expect(t.state.capture).toBeNull();
  });

  test("6. outPath: a bad path on an owned capture is INVALID_ARGUMENT before any finish request and keeps it armed; a retry with a good path succeeds", async () => {
    const existing = join(s.cwd, "taken.zip");
    writeFileSync(existing, "old");
    const start = await s.call("bcdev_snapshot_start", SNAP);
    const e = await s.fail("bcdev_snapshot_finish", { outPath: existing });
    expect(e.code).toBe("INVALID_ARGUMENT");
    expect(finishes(s)).toBe(0);
    expect(s.state.capture).toMatchObject({ phase: "armed", snapshotId: start["snapshotId"] });
    expect(readFileSync(existing, "utf8")).toBe("old");

    expect((await s.fail("bcdev_snapshot_finish", { outPath: join(s.cwd, "no-such-dir", "x.zip") })).code).toBe("INVALID_ARGUMENT");
    expect(finishes(s)).toBe(0);
    expect(s.state.capture?.phase).toBe("armed");

    const fin = await s.call("bcdev_snapshot_finish", { outPath: existing, overwrite: true });
    expect(fin["zipPath"]).toBe(existing);
    expect(Buffer.compare(readFileSync(existing), ZIP)).toBe(0);
    expect(finishes(s)).toBe(1);
    expect(s.state.capture).toBeNull();
  });

  test("7a. status and finish during attach are PROFILE_ACTIVE phase attaching", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    s.fake.routes["attach"] = async () => { await gate; return new Response('"NextSessionOnTenant"'); };
    const starting = s.call("bcdev_snapshot_start", SNAP);
    while (s.state.capture?.phase !== "attaching") await Bun.sleep(1);
    const st = await s.fail("bcdev_snapshot_status");
    expect(st.code).toBe("PROFILE_ACTIVE");
    expect(st.details).toMatchObject({ phase: "attaching", ownerFinishTool: "bcdev_snapshot_finish" });
    expect((await s.fail("bcdev_snapshot_finish")).details).toMatchObject({ phase: "attaching" });
    expect((await s.fail("bcdev_snapshot_start", SNAP)).code).toBe("PROFILE_ACTIVE");
    release();
    await starting;
    expect(s.state.capture?.phase as string).toBe("armed"); // TS keeps the loop's narrowing to "attaching"
  });

  test("7b. two concurrent finishes: one result, one PROFILE_ACTIVE phase finishing", async () => {
    await s.call("bcdev_snapshot_start", SNAP);
    const [a, b] = await Promise.allSettled([s.call("bcdev_snapshot_finish"), s.call("bcdev_snapshot_finish")]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason).toMatchObject({ code: "PROFILE_ACTIVE", details: { phase: "finishing" } });
    expect(finishes(s)).toBe(1);
    expect(s.state.capture).toBeNull();
  });

  test("7c. finish with no answer: uncertain, start refused, a retry finishes with the same context and cookie", async () => {
    s.fake.routes["attach"] = () => new Response('"NextSessionOnTenant"', { headers: { "set-cookie": "ApplicationGatewayAffinity=node-7; Path=/" } });
    await s.call("bcdev_snapshot_start", SNAP);
    s.fake.routes["finish"] = () => { throw new TypeError("fetch failed"); };
    const e = await s.fail("bcdev_snapshot_finish");
    expect(e).toMatchObject({ code: "TIMEOUT", retryable: true, details: { phase: "uncertain" } });
    expect(agentErrorBody("bcdev_snapshot_finish", e).nextSteps[0]).toContain("bcdev_snapshot_finish again (same snapshotId)");
    expect(s.state.capture?.phase).toBe("uncertain");
    expect((await s.fail("bcdev_snapshot_start", SNAP)).code).toBe("PROFILE_ACTIVE");
    expect(await s.call("bcdev_snapshot_status")).toMatchObject({ status: "Started" });
    s.fake.routes["finish"] = () => new Response(ZIP);
    expect((await s.call("bcdev_snapshot_finish"))["decodeStatus"]).toBe("decoded");
    expect(s.state.capture).toBeNull();
    const [first, retry] = s.fake.calls.filter((c) => c.op === "finish");
    expect(retry!.url.searchParams.get("debuggingcontext")).toBe(first!.url.searchParams.get("debuggingcontext"));
    expect(first!.cookie).toBe("ApplicationGatewayAffinity=node-7");
    expect(retry!.cookie).toBe(first!.cookie);
    expect(retry!.url.searchParams.get("applicationgatewayaffinity")).toBe("node-7");
  });

  test("converter without deps.converter: BC_MDC_CONVERTER is used; with it unset and nothing on PATH the result is raw", async () => {
    const exe = join(mkdtempSync(join(tmpdir(), "bcsnap-conv-")), "bc-mdc-converter.exe");
    writeFileSync(exe, "");
    const seen: string[] = [];
    const runJson: SnapshotJsonRunner = async (binary) => { seen.push(binary); return { ok: true, json: structuredClone(SNAPSHOT_JSON) }; };
    const t = setup({ resolveConverter: undefined, runJson }, { BC_MDC_CONVERTER: exe });
    await t.call("bcdev_snapshot_start", SNAP);
    expect((await t.call("bcdev_snapshot_finish"))["decodeStatus"]).toBe("decoded");
    expect(seen).toEqual([exe]);

    const none = setup({ resolveConverter: undefined, runJson }, { PATH: mkdtempSync(join(tmpdir(), "bcsnap-path-")) });
    await none.call("bcdev_snapshot_start", SNAP);
    expect((await none.call("bcdev_snapshot_finish"))["decodeStatus"]).toBe("raw");
    expect(seen).toHaveLength(1);
  });

  test("7d. finish 401 and 500 put the slot back to armed with its handle; a retry works", async () => {
    const start = await s.call("bcdev_snapshot_start", SNAP);
    s.fake.routes["finish"] = () => new Response("denied", { status: 401 });
    expect((await s.fail("bcdev_snapshot_finish")).code).toBe("AUTHENTICATION_FAILED");
    expect(s.state.capture).toMatchObject({ phase: "armed", snapshotId: start["snapshotId"] });
    s.fake.routes["finish"] = () => new Response("boom", { status: 500 });
    expect((await s.fail("bcdev_snapshot_finish")).code).toBe("SERVER_REJECTED");
    expect(s.state.capture).toMatchObject({ phase: "armed", snapshotId: start["snapshotId"] });
    s.fake.routes["finish"] = () => new Response(ZIP);
    expect((await s.call("bcdev_snapshot_finish", { snapshotId: start["snapshotId"] }))["decodeStatus"]).toBe("decoded");
  });

  test("7e. finish 404 (lost context) is SERVER_REJECTED and releases the slot; status lost context releases too", async () => {
    await s.call("bcdev_snapshot_start", SNAP);
    s.fake.routes["finish"] = () => new Response("", { status: 404 });
    const e = await s.fail("bcdev_snapshot_finish");
    expect(e).toMatchObject({ code: "SERVER_REJECTED", retryable: false, details: { lostContext: true } });
    expect(agentErrorBody("bcdev_snapshot_finish", e).nextSteps[0]).toBe("The capture ended on the server; call bcdev_snapshot_start to arm a new one.");
    expect(s.state.capture).toBeNull();

    await s.call("bcdev_snapshot_start", SNAP);
    s.fake.routes["status"] = () => Response.json({ Message: "The debugging context could not be retrieved." });
    expect((await s.fail("bcdev_snapshot_status")).details).toMatchObject({ lostContext: true });
    expect(s.state.capture).toBeNull();
  });

  test("8a. attach 400 already started -> PROFILE_ACTIVE heldElsewhere naming bcdev_snapshot_finish", async () => {
    s.fake.routes["attach"] = () => new Response('"A snapshot debugging session has already started on this tenant."', { status: 400 });
    const e = await s.fail("bcdev_snapshot_start", SNAP);
    expect(e.code).toBe("PROFILE_ACTIVE");
    expect(e.details).toMatchObject({ heldElsewhere: true, ownerFinishTool: "bcdev_snapshot_finish", capture: "snapshot" });
    expect(s.state.capture).toBeNull();
  });

  test("8b. attach with no answer releases the slot and returns the debuggingContext for orphan recovery", async () => {
    s.fake.routes["attach"] = () => { throw new TypeError("fetch failed"); };
    const e = await s.fail("bcdev_snapshot_start", SNAP);
    expect(e).toMatchObject({ code: "TIMEOUT", retryable: false, details: { attachUncertain: true } });
    const sent = s.fake.calls.find((c) => c.op === "attach")!.url.searchParams.get("debuggingcontext");
    expect(e.details["debuggingContext"]).toBe(sent);
    expect(agentErrorBody("bcdev_snapshot_start", e).nextSteps[0]).toContain(`bcdev_snapshot_finish { debuggingContext: '${sent}' }`);
    expect(s.state.capture).toBeNull();
  });

  test("9. an active profile blocks snapshot start, naming bcdev_profile_finish", async () => {
    s.state.capture = {
      captureKind: "profile", profileId: "p1", profileKind: "sampling", debuggingContext: "c", affinityCookie: null, attachKind: "x",
      snapshotPort: 7083, config: conn as never, authorization: {} as never, startedAt: "t", token: Symbol(), phase: "armed",
    } satisfies ProfileCapture;
    const e = await s.fail("bcdev_snapshot_start", SNAP);
    expect(e.code).toBe("PROFILE_ACTIVE");
    expect(e.details).toMatchObject({ ownerFinishTool: "bcdev_profile_finish", capture: "profile" });
    expect((await s.fail("bcdev_snapshot_status")).details).toMatchObject({ ownerFinishTool: "bcdev_profile_finish" });
    expect(s.fake.calls).toHaveLength(0);
  });

  test("10. orphan recovery: with snappoints complete, without partial; conflicts are INVALID_ARGUMENT", async () => {
    const withPoints = await s.call("bcdev_snapshot_finish", { debuggingContext: "orphan-1", ...SNAP });
    expect(withPoints).toMatchObject({ decodeStatus: "decoded", classification: "complete" });
    const finishCall = s.fake.calls.at(-1)!;
    expect(finishCall.op).toBe("finish");
    expect(finishCall.url.searchParams.get("debuggingcontext")).toBe("orphan-1");
    const without = await s.call("bcdev_snapshot_finish", { debuggingContext: "orphan-2" });
    expect(without).toMatchObject({ decodeStatus: "decoded", classification: "partial" });

    const start = await s.call("bcdev_snapshot_start", SNAP);
    expect((await s.fail("bcdev_snapshot_finish", { debuggingContext: start["debuggingContext"] })).code).toBe("INVALID_ARGUMENT");
    expect((await s.fail("bcdev_snapshot_finish", { debuggingContext: "other", snapshotId: start["snapshotId"] })).code).toBe("INVALID_ARGUMENT");
    expect(s.state.capture?.phase).toBe("armed");
  });

  test("11. metadata: webApiVersion 2.0 is UNSUPPORTED_SERVER, 401 is AUTHENTICATION_FAILED; neither arms", async () => {
    s.fake.routes["snapshotendpointmetadata"] = () => Response.json({ runtimeVersion: "14.0", webApiVersion: "2.0" });
    const e = await s.fail("bcdev_snapshot_start", SNAP);
    expect(e.code).toBe("UNSUPPORTED_SERVER");
    expect(e.message).toContain("2.0");
    s.fake.routes["snapshotendpointmetadata"] = () => new Response("no", { status: 401 });
    expect((await s.fail("bcdev_snapshot_start", SNAP)).code).toBe("AUTHENTICATION_FAILED");
    expect(s.fake.calls.some((c) => c.op === "attach")).toBe(false);
    expect(s.state.capture).toBeNull();
  });

  test("12. the saved zip has a fresh UUID name (not the debugging context) in a created save dir", async () => {
    expect(existsSync(s.saveDir)).toBe(false);
    const start = await s.call("bcdev_snapshot_start", SNAP);
    const fin = await s.call("bcdev_snapshot_finish");
    const name = basename(fin["zipPath"] as string, ".zip");
    expect(name).toMatch(UUID);
    expect(name).not.toBe(start["debuggingContext"]);
    expect(readdirSync(s.saveDir)).toEqual([`${name}.zip`]);
  });

  test("bad snappoint input is INVALID_ARGUMENT before anything is sent", async () => {
    const e = await s.fail("bcdev_snapshot_start", { snappoints: [{ file: "src/TriggerDemoPage.Page.al", line: 99 }] });
    expect(e.code).toBe("INVALID_ARGUMENT");
    expect(s.fake.calls).toHaveLength(0);
  });

  test("M11. sessionId 0 and negatives other than -1 are INVALID_ARGUMENT before anything is sent; -1 and >= 1 pass", async () => {
    for (const sessionId of [0, -2]) expect((await s.fail("bcdev_snapshot_start", { sessionId })).code).toBe("INVALID_ARGUMENT");
    expect(s.fake.calls).toHaveLength(0);
    await s.call("bcdev_snapshot_start", { sessionId: 7 });
    expect((s.fake.calls.find((c) => c.op === "attach")!.body as Record<string, unknown>)["SessionId"]).toBe(7);
  });

  test("M7. an orphan debuggingContext equal to the active profile's context names bcdev_profile_finish", async () => {
    s.state.capture = {
      captureKind: "profile", profileId: "p1", profileKind: "sampling", debuggingContext: "ctx-p", affinityCookie: null, attachKind: "x",
      snapshotPort: 7083, config: conn as never, authorization: {} as never, startedAt: "t", token: Symbol(), phase: "armed",
    } satisfies ProfileCapture;
    const e = await s.fail("bcdev_snapshot_finish", { debuggingContext: "ctx-p" });
    expect(e.code).toBe("PROFILE_ACTIVE");
    expect(e.details).toMatchObject({ capture: "profile", ownerFinishTool: "bcdev_profile_finish" });
    expect(s.fake.calls).toHaveLength(0);
  });

  test("M8. the raw warning carries the resolver's reason when the converter is unavailable", async () => {
    const converter = { binary: async () => null, resolve: async () => ({ source: "unavailable" as const, path: null, reason: "download disabled (BC_MDC_CONVERTER_DOWNLOAD=0)" }) };
    const t = setup({ resolveConverter: async () => null });
    const state = new ServerState();
    const tools = new Map(createSnapshotTools(state, { ...({ hubFactory: null, authorizationFactory: createAuthorizationProviderFactory(), fetchFn: t.fake.fetchFn, env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" }, cwd: t.cwd, converter } as unknown as ToolDeps) }, {
      runJson: async () => ({ ok: true, json: {} }), saveDir: t.saveDir, resolveConverter: async () => null,
    }).map((x) => [x.name, x]));
    await tools.get("bcdev_snapshot_start")!.handler({ ...conn, ...SNAP });
    const fin = (await tools.get("bcdev_snapshot_finish")!.handler({ ...conn })) as Record<string, unknown>;
    expect(fin["decodeStatus"]).toBe("raw");
    expect((fin["warnings"] as string[])[0]).toContain("download disabled");
  });

  test("M4. an attach that times out is TIMEOUT attachUncertain (not a generic error)", async () => {
    s.fake.routes["attach"] = () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
    const e = await s.fail("bcdev_snapshot_start", SNAP);
    expect(e).toMatchObject({ code: "TIMEOUT", details: { attachUncertain: true } });
    expect(s.state.capture).toBeNull();
  });
});
