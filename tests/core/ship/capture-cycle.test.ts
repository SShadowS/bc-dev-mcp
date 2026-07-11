import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCaptureShipCycle, type CycleDeps } from "../../../src/core/ship/capture-cycle";
import type { ShipConfig } from "../../../src/core/ship/args";
import type { ConnectionConfig } from "../../../src/core/types";
import type { SpawnRunner } from "../../../src/core/snapshot/converter";
import { BasicAuthorizationProvider } from "../../../src/core/authorization";

// zip fixture builder (same helper as tests/core/snapshot/zip.test.ts / tests/mcp/profile-tools.test.ts)
function crc32(buf: Buffer): number { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]!; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function makeZip(name: string, content: Buffer) {
  const nameBuf = Buffer.from(name, "utf8"); const comp = deflateRawSync(content); const crc = crc32(content);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(8,8); local.writeUInt32LE(crc,14); local.writeUInt32LE(comp.length,18); local.writeUInt32LE(content.length,22); local.writeUInt16LE(nameBuf.length,26);
  const localHeader = Buffer.concat([local, nameBuf, comp]);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6); cd.writeUInt16LE(8,10); cd.writeUInt32LE(crc,16); cd.writeUInt32LE(comp.length,20); cd.writeUInt32LE(content.length,24); cd.writeUInt16LE(nameBuf.length,28); cd.writeUInt32LE(0,42);
  const cdRec = Buffer.concat([cd, nameBuf]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(1,8); eocd.writeUInt16LE(1,10); eocd.writeUInt32LE(cdRec.length,12); eocd.writeUInt32LE(localHeader.length,16);
  return Uint8Array.from(Buffer.concat([localHeader, cdRec, eocd]));
}

const CONN: ConnectionConfig = { environmentType: "OnPrem", authentication: "UserPassword", server: "http://bc", serverInstance: "BC", tenant: "default", username: "u", password: "p" };
const UUID = "550e8400-e29b-41d4-a716-446655440042";
const IR_DOC = JSON.stringify({ schemaVersion: 1, apps: [], invocations: [{}, {}, {}] });

function cfg(outDir: string, over: Partial<ShipConfig> = {}): ShipConfig {
  return {
    snapshotPort: 7083, clientType: "WebClient", captureSeconds: 10, pollSeconds: 5,
    converterPath: "conv.exe", alPerfUrl: "http://alperf:3010", alPerfTenant: "acme", alPerfToken: "tok",
    description: "test capture", outDir, dryRun: false, keepArtifacts: false, ...over,
  };
}

const okConverter: SpawnRunner = async (_cmd, args) => {
  writeFileSync(args[1]!, IR_DOC);
  return { code: 0, stderr: "" };
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000; // must track capture-cycle.ts's own default

function deps(fetchFn: typeof fetch, over: Partial<CycleDeps> = {}): CycleDeps {
  let t = 0;
  const requestTimeoutMs = over.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return {
    fetchFn,
    authorizationFactory: () => new BasicAuthorizationProvider("u", "p"),
    runConverter: okConverter,
    now: () => t,
    // Poll-interval / retry-backoff calls advance the deterministic virtual clock. A call for
    // exactly requestTimeoutMs is the per-request timeout race (see withRequestTimeout in
    // capture-cycle.ts) — it must NOT touch the shared clock (that would corrupt activityDuration
    // for every wrapped call, timed out or not), so it only yields to the macrotask queue. A
    // normal (microtask-only) mock response always drains first and wins the race regardless of
    // how many ticks it internally takes; only a genuinely hung mock loses to it.
    sleep: async (ms) => {
      if (ms === requestTimeoutMs) {
        await new Promise<void>((r) => setImmediate(r));
        return;
      }
      t += ms;
    },
    log: () => {},
    uuid: () => UUID,
    requestTimeoutMs,
    ...over,
  };
}

type Route = [substring: string, handler: (url: string, init?: RequestInit) => Response];
function fakeFetch(routes: Route[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const r = routes.find(([k]) => url.includes(k));
    if (!r) throw new Error(`no fake route for ${url}`);
    return r[1](url, init);
  }) as unknown as typeof fetch;
}

// A route handler that never resolves — simulates a hung BC request for withRequestTimeout tests.
const hang = (): Response => new Promise<Response>(() => {}) as unknown as Response;

const happyBcRoutes = (finishBody: () => Response): Route[] => [
  ["snapshotendpointmetadata", () => new Response(JSON.stringify({ runtimeVersion: "17.0", webApiVersion: "3.0" }))],
  ["attach", () => new Response('"NextSessionOnTenant"')],
  ["status", () => new Response('"Started"')],
  ["finish", finishBody],
];

describe("runCaptureShipCycle", () => {
  test("full cycle: capture -> convert -> gzip -> ship (stored); artifacts cleaned up", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    let ingestInit: RequestInit | undefined;
    const fetchFn = fakeFetch([
      ...happyBcRoutes(() => new Response(makeZip("0.mdc", Buffer.from("fb")))),
      ["/api/ingest", (_u, init) => { ingestInit = init; return new Response(JSON.stringify({ status: "stored" }), { status: 202 }); }],
    ]);
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "shipped", activityId: UUID });

    const headers = ingestInit!.headers as Record<string, string>;
    expect(headers["X-Idempotency-Key"]).toBe(UUID);
    const profilePart = (ingestInit!.body as FormData).get("profile") as File;
    const bytes = new Uint8Array(await profilePart.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]); // part-level gzip

    expect(existsSync(join(outDir, `${UUID}.snapshot.zip`))).toBe(false);
    expect(existsSync(join(outDir, `${UUID}.ir.json`))).toBe(false);
  });

  test("empty finish body -> no-capture; nothing is POSTed", async () => {
    let ingestCalled = false;
    const fetchFn = fakeFetch([
      ...happyBcRoutes(() => new Response(null, { headers: { "Content-Length": "0" } })),
      ["/api/ingest", () => { ingestCalled = true; return new Response("{}", { status: 202 }); }],
    ]);
    const r = await runCaptureShipCycle(cfg(mkdtempSync(join(tmpdir(), "ship-"))), CONN, deps(fetchFn));
    expect(r).toEqual({ kind: "no-capture" });
    expect(ingestCalled).toBe(false);
  });

  test("preflight failure is stage preflight with the port in the message", async () => {
    const fetchFn = fakeFetch([["snapshotendpointmetadata", () => new Response("nope", { status: 404 })]]);
    const r = await runCaptureShipCycle(cfg(mkdtempSync(join(tmpdir(), "ship-"))), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "error", stage: "preflight" });
    if (r.kind === "error") expect(r.message).toContain("7083");
  });

  test("preflight request timeout (hung BC request) aborts with stage preflight", async () => {
    const fetchFn = fakeFetch([["snapshotendpointmetadata", hang]]);
    const r = await runCaptureShipCycle(cfg(mkdtempSync(join(tmpdir(), "ship-"))), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "error", stage: "preflight" });
    if (r.kind === "error") expect(r.message).toContain("timed out");
  });

  test("status Failed aborts with stage capture", async () => {
    const fetchFn = fakeFetch([
      ["snapshotendpointmetadata", () => new Response(JSON.stringify({ webApiVersion: "3.0" }))],
      ["attach", () => new Response('"NextSessionOnTenant"')],
      ["status", () => new Response('"Failed"')],
      ["finish", () => new Response(null, { headers: { "Content-Length": "0" } })],
    ]);
    const r = await runCaptureShipCycle(cfg(mkdtempSync(join(tmpdir(), "ship-"))), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "error", stage: "capture" });
  });

  test("converter failure keeps the raw zip, stage convert", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    const fetchFn = fakeFetch(happyBcRoutes(() => new Response(makeZip("0.mdc", Buffer.from("fb")))));
    const failing: SpawnRunner = async () => ({ code: 1, stderr: "error: unsupported snapshot version" });
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn, { runConverter: failing }));
    expect(r).toMatchObject({ kind: "error", stage: "convert" });
    if (r.kind === "error") expect(r.message).toContain("unsupported");
    expect(existsSync(join(outDir, `${UUID}.snapshot.zip`))).toBe(true);
  });

  test("over-budget ir-json fails at stage budget with artifacts + manifest retained", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    const fetchFn = fakeFetch(happyBcRoutes(() => new Response(makeZip("0.mdc", Buffer.from("fb")))));
    const big: SpawnRunner = async (_c, args) => {
      writeFileSync(args[1]!, JSON.stringify({ schemaVersion: 1, invocations: new Array(500_001).fill(0) }));
      return { code: 0, stderr: "" };
    };
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn, { runConverter: big }));
    expect(r).toMatchObject({ kind: "error", stage: "budget" });
    expect(existsSync(join(outDir, `${UUID}.snapshot.zip`))).toBe(true);
    expect(existsSync(join(outDir, `${UUID}.ir.json`))).toBe(true);
    // Same manual re-ship pattern as a ship-stage failure: the manifest must be on disk too.
    const manifestPath = join(outDir, `${UUID}.manifest.json`);
    expect(existsSync(manifestPath)).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({ activityId: UUID, captureKind: "instrumentation" });
    if (r.kind === "error") expect(r.artifacts?.manifestPath).toBe(manifestPath);
  });

  test("dry-run captures + converts, prints, never POSTs, keeps artifacts", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    let ingestCalled = false;
    const fetchFn = fakeFetch([
      ...happyBcRoutes(() => new Response(makeZip("0.mdc", Buffer.from("fb")))),
      ["/api/ingest", () => { ingestCalled = true; return new Response("{}", { status: 202 }); }],
    ]);
    const r = await runCaptureShipCycle(cfg(outDir, { dryRun: true, scheduleId: "550e8400-e29b-41d4-a716-446655440002" }), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "dry-run", activityId: UUID });
    if (r.kind !== "dry-run") return;
    expect(r.manifest).toMatchObject({
      activityId: UUID,
      captureKind: "instrumentation",
      activityType: "WebClient",
      scheduleId: "550e8400-e29b-41d4-a716-446655440002",
      startTime: "1970-01-01T00:00:00.000Z", // deps.now() starts at 0
      activityDuration: 10000, // two 5s polls on the fake clock
    });
    expect(ingestCalled).toBe(false);
    expect(existsSync(r.zipPath)).toBe(true);
    expect(existsSync(r.irPath)).toBe(true);
  });

  test("ship rejection keeps artifacts and writes the manifest for manual re-ship", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    const fetchFn = fakeFetch([
      ...happyBcRoutes(() => new Response(makeZip("0.mdc", Buffer.from("fb")))),
      ["/api/ingest", () => new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413 })],
    ]);
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "error", stage: "ship" });
    if (r.kind !== "error") return;
    expect(r.message).toContain("payload_too_large");
    expect(existsSync(join(outDir, `${UUID}.snapshot.zip`))).toBe(true);
    expect(existsSync(join(outDir, `${UUID}.ir.json`))).toBe(true);
    expect(existsSync(join(outDir, `${UUID}.manifest.json`))).toBe(true);
  });

  test("keepArtifacts on success also writes the manifest (needed for manual re-ship / E2E re-POST)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    const fetchFn = fakeFetch([
      ...happyBcRoutes(() => new Response(makeZip("0.mdc", Buffer.from("fb")))),
      ["/api/ingest", () => new Response(JSON.stringify({ status: "stored" }), { status: 202 })],
    ]);
    const r = await runCaptureShipCycle(cfg(outDir, { keepArtifacts: true }), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "shipped", activityId: UUID });
    expect(existsSync(join(outDir, `${UUID}.snapshot.zip`))).toBe(true);
    expect(existsSync(join(outDir, `${UUID}.ir.json`))).toBe(true);
    const manifestPath = join(outDir, `${UUID}.manifest.json`);
    expect(existsSync(manifestPath)).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({ activityId: UUID, captureKind: "instrumentation" });
  });

  test("202 duplicate maps to duplicate outcome; artifacts cleaned up", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    const fetchFn = fakeFetch([
      ...happyBcRoutes(() => new Response(makeZip("0.mdc", Buffer.from("fb")))),
      ["/api/ingest", () => new Response(JSON.stringify({ status: "duplicate" }), { status: 202 })],
    ]);
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn));
    expect(r).toEqual({ kind: "duplicate", activityId: UUID });
    expect(existsSync(join(outDir, `${UUID}.snapshot.zip`))).toBe(false);
    expect(existsSync(join(outDir, `${UUID}.ir.json`))).toBe(false);
  });

  test("attach network failure (HTTP error) aborts with stage attach", async () => {
    const fetchFn = fakeFetch([
      ["snapshotendpointmetadata", () => new Response(JSON.stringify({ webApiVersion: "3.0" }))],
      ["attach", () => new Response("server error", { status: 500 })],
    ]);
    const r = await runCaptureShipCycle(cfg(mkdtempSync(join(tmpdir(), "ship-"))), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "error", stage: "attach" });
  });

  test("attach request timeout (hung BC request) aborts with stage attach", async () => {
    const fetchFn = fakeFetch([
      ["snapshotendpointmetadata", () => new Response(JSON.stringify({ webApiVersion: "3.0" }))],
      ["attach", hang],
    ]);
    const r = await runCaptureShipCycle(cfg(mkdtempSync(join(tmpdir(), "ship-"))), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "error", stage: "attach" });
    if (r.kind === "error") expect(r.message).toContain("timed out");
  });

  test("status poll timeout is treated as transient — the cycle continues to deadline and still ships", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    let statusCalls = 0;
    const fetchFn = fakeFetch([
      ["snapshotendpointmetadata", () => new Response(JSON.stringify({ webApiVersion: "3.0" }))],
      ["attach", () => new Response('"NextSessionOnTenant"')],
      ["status", () => { statusCalls++; return statusCalls === 1 ? hang() : new Response('"Started"'); }],
      ["finish", () => new Response(makeZip("0.mdc", Buffer.from("fb")))],
      ["/api/ingest", () => new Response(JSON.stringify({ status: "stored" }), { status: 202 })],
    ]);
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn));
    expect(statusCalls).toBe(2); // captureSeconds=10, pollSeconds=5 -> both iterations still ran
    expect(r).toMatchObject({ kind: "shipped" });
  });

  test("status poll network error is treated as transient — the cycle continues to deadline", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    let statusCalls = 0;
    const fetchFn = fakeFetch([
      ["snapshotendpointmetadata", () => new Response(JSON.stringify({ webApiVersion: "3.0" }))],
      ["attach", () => new Response('"NextSessionOnTenant"')],
      ["status", () => { statusCalls++; return statusCalls === 1 ? new Response("bad gateway", { status: 502 }) : new Response('"Started"'); }],
      ["finish", () => new Response(makeZip("0.mdc", Buffer.from("fb")))],
      ["/api/ingest", () => new Response(JSON.stringify({ status: "stored" }), { status: 202 })],
    ]);
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn));
    expect(statusCalls).toBe(2);
    expect(r).toMatchObject({ kind: "shipped" });
  });

  test("Finished status breaks the poll loop early instead of running to the full deadline", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    let statusCalls = 0;
    const fetchFn = fakeFetch([
      ["snapshotendpointmetadata", () => new Response(JSON.stringify({ webApiVersion: "3.0" }))],
      ["attach", () => new Response('"NextSessionOnTenant"')],
      ["status", () => { statusCalls++; return new Response('"Finished"'); }],
      ["finish", () => new Response(makeZip("0.mdc", Buffer.from("fb")))],
      ["/api/ingest", () => new Response(JSON.stringify({ status: "stored" }), { status: 202 })],
    ]);
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn));
    // captureSeconds=10, pollSeconds=5 -> 2 iterations if not broken early; Finished on the
    // first poll must exit the loop immediately.
    expect(statusCalls).toBe(1);
    expect(r).toMatchObject({ kind: "shipped" });
  });

  test("finish network failure (HTTP error) aborts with stage finish, distinct from empty-body no-capture", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    const fetchFn = fakeFetch([
      ["snapshotendpointmetadata", () => new Response(JSON.stringify({ webApiVersion: "3.0" }))],
      ["attach", () => new Response('"NextSessionOnTenant"')],
      ["status", () => new Response('"Started"')],
      ["finish", () => new Response("boom", { status: 500 })],
    ]);
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "error", stage: "finish" });
    if (r.kind === "error") expect(r.message).toContain("500");
  });

  test("finish request timeout (hung BC request) aborts with stage finish", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    const fetchFn = fakeFetch([
      ["snapshotendpointmetadata", () => new Response(JSON.stringify({ webApiVersion: "3.0" }))],
      ["attach", () => new Response('"NextSessionOnTenant"')],
      ["status", () => new Response('"Started"')],
      ["finish", hang],
    ]);
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "error", stage: "finish" });
    if (r.kind === "error") expect(r.message).toContain("timed out");
  });

  test("finish archive without .mdc member aborts with stage finish", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    const fetchFn = fakeFetch(happyBcRoutes(() => new Response(makeZip("readme.txt", Buffer.from("hi")))));
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "error", stage: "finish" });
    if (r.kind === "error") expect(r.message).toContain(".mdc");
  });

  test("ship unreachable (network failure exhausting retries) maps to stage ship, distinct from rejected", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ship-"));
    const fetchFn = fakeFetch([
      ...happyBcRoutes(() => new Response(makeZip("0.mdc", Buffer.from("fb")))),
      ["/api/ingest", () => { throw new Error("ECONNREFUSED"); }],
    ]);
    const r = await runCaptureShipCycle(cfg(outDir), CONN, deps(fetchFn));
    expect(r).toMatchObject({ kind: "error", stage: "ship" });
    if (r.kind !== "error") return;
    expect(r.message).toContain("unreachable");
    expect(existsSync(join(outDir, `${UUID}.snapshot.zip`))).toBe(true);
    expect(existsSync(join(outDir, `${UUID}.ir.json`))).toBe(true);
    expect(existsSync(join(outDir, `${UUID}.manifest.json`))).toBe(true);
  });
});
