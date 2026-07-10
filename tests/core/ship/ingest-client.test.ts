import { describe, expect, test } from "bun:test";
import {
  actionableFor, checkBudgets, shipIngest,
  DEFAULT_MAX_DECOMPRESSED_BYTES, MAX_COMPRESSED_BYTES, MAX_INVOCATIONS,
} from "../../../src/core/ship/ingest-client";

const REQ = {
  baseUrl: "http://alperf:3010/",
  tenant: "acme",
  token: "tok",
  activityId: "550e8400-e29b-41d4-a716-446655440001",
  manifest: { activityId: "550e8400-e29b-41d4-a716-446655440001", captureKind: "instrumentation" },
  gzippedProfile: new Uint8Array([0x1f, 0x8b, 1, 2, 3]),
  filename: "550e8400-e29b-41d4-a716-446655440001.ir.json.gz",
};
const noSleep = async () => {};

describe("checkBudgets", () => {
  test("within budgets", () => {
    expect(checkBudgets({ compressedBytes: 1, decompressedBytes: 1, invocationCount: 1 })).toEqual({ ok: true });
  });
  test("each limit trips independently", () => {
    expect(checkBudgets({ compressedBytes: MAX_COMPRESSED_BYTES + 1, decompressedBytes: 1, invocationCount: 1 }).ok).toBe(false);
    expect(checkBudgets({ compressedBytes: 1, decompressedBytes: DEFAULT_MAX_DECOMPRESSED_BYTES + 1, invocationCount: 1 }).ok).toBe(false);
    expect(checkBudgets({ compressedBytes: 1, decompressedBytes: 1, invocationCount: MAX_INVOCATIONS + 1 }).ok).toBe(false);
  });
});

describe("shipIngest", () => {
  test("posts multipart with the three headers; 202 stored", async () => {
    let sawUrl = "";
    let sawHeaders: Record<string, string> = {};
    let sawBody: FormData | null = null;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sawUrl = input.toString();
      sawHeaders = init?.headers as Record<string, string>;
      sawBody = init?.body as FormData;
      return new Response(JSON.stringify({ id: REQ.activityId, status: "stored" }), { status: 202 });
    }) as unknown as typeof fetch;

    const r = await shipIngest(fetchFn, REQ, { sleep: noSleep });
    expect(r).toEqual({ kind: "stored" });
    expect(sawUrl).toBe("http://alperf:3010/api/ingest");
    expect(sawHeaders["Authorization"]).toBe("Bearer tok");
    expect(sawHeaders["X-Tenant-Id"]).toBe("acme");
    expect(sawHeaders["X-Idempotency-Key"]).toBe(REQ.activityId);
    const manifestPart = sawBody!.get("manifest") as Blob;
    expect(JSON.parse(await manifestPart.text())).toMatchObject({ captureKind: "instrumentation" });
    const profilePart = sawBody!.get("profile") as File;
    expect(profilePart.name).toBe(REQ.filename);
    const bytes = new Uint8Array(await profilePart.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]); // gzip magic survives the part
  });

  test("202 duplicate maps to duplicate (success/no-op)", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ status: "duplicate" }), { status: 202 })) as unknown as typeof fetch;
    expect(await shipIngest(fetchFn, REQ, { sleep: noSleep })).toEqual({ kind: "duplicate" });
  });

  test("4xx maps to rejected with an actionable message, no retry", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }) as unknown as typeof fetch;
    const r = await shipIngest(fetchFn, REQ, { sleep: noSleep });
    expect(r).toMatchObject({ kind: "rejected", status: 401, errorCode: "unauthorized" });
    expect(calls).toBe(1);
  });

  test("503 retries with backoff then succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchFn = (async () => {
      calls++;
      return calls < 3
        ? new Response("bad gateway", { status: 503 })
        : new Response(JSON.stringify({ status: "stored" }), { status: 202 });
    }) as unknown as typeof fetch;
    const r = await shipIngest(fetchFn, REQ, { sleep: async (ms) => { delays.push(ms); } });
    expect(r).toEqual({ kind: "stored" });
    expect(delays).toEqual([2000, 4000]);
  });

  test("500 analyze_failed is deterministic — no retry", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "analyze_failed" }), { status: 500 });
    }) as unknown as typeof fetch;
    const r = await shipIngest(fetchFn, REQ, { sleep: noSleep });
    expect(r).toMatchObject({ kind: "rejected", status: 500, errorCode: "analyze_failed" });
    expect(calls).toBe(1);
  });

  test("network errors exhaust retries into unreachable", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchFn = (async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await shipIngest(fetchFn, REQ, { sleep: async (ms) => { delays.push(ms); } });
    expect(r).toMatchObject({ kind: "unreachable" });
    expect(calls).toBe(4); // 1 attempt + 3 retries
    expect(delays).toEqual([2000, 4000, 8000]);
  });
});

describe("actionableFor", () => {
  test("known codes give actionable guidance", () => {
    expect(actionableFor(413, "payload_too_large")).toContain("--duration");
    expect(actionableFor(401, "unauthorized")).toContain("AL_PERF_TOKEN");
    expect(actionableFor(500, "analyze_failed")).toContain("500,000");
    expect(actionableFor(404, "tenant_not_registered")).toContain("register");
    expect(actionableFor(400, "invalid_gzip")).toContain("gzip");
  });
});
