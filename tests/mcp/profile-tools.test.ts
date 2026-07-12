import { beforeEach, describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerState } from "../../src/mcp/state";
import { createProfileTools } from "../../src/mcp/tools/profile-tools";
import { createAuthorizationProviderFactory } from "../../src/core/authorization";
import type { ToolDeps } from "../../src/mcp/tools/shared";

// Reuse the zip fixture builder from the core zip test (copy the two helpers here).
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

const profileJson = JSON.stringify({
  nodes: [{ id: 1, callFrame: { functionName: "OnRun", url: "al://Codeunit_50100.dal", lineNumber: 5 } }],
  samples: [1, 1], timeDeltas: [100, 100], startTime: 0, endTime: 200,
});

function deps(fetchFn: typeof fetch): ToolDeps {
  return { hubFactory: (() => { throw new Error("no hub in profile tests"); }) as never, authorizationFactory: createAuthorizationProviderFactory(), fetchFn, env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" }, cwd: mkdtempSync(join(tmpdir(), "bcprof-")) };
}
const conn = { server: "http://bc", serverInstance: "BC", tenant: "default" };

describe("profile tools", () => {
  let state: ServerState;
  beforeEach(() => { state = new ServerState(); });

  test("registers the four tools with metadata + output schemas", () => {
    const tools = createProfileTools(state, deps((async () => new Response("{}")) as never));
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bcdev_profile_finish", "bcdev_profile_poll", "bcdev_profile_start", "bcdev_profile_status",
    ]);
    for (const t of tools) { expect(t.title.length).toBeGreaterThan(0); expect(t.annotations).toBeDefined(); expect(t.outputSchema).toBeDefined(); }
  });

  test("start attaches and stores the handle; double start guarded", async () => {
    const fetchFn = (async (u: RequestInfo | URL) => u.toString().includes("attach") ? new Response('"NextSessionOnTenant"') : new Response("{}")) as unknown as typeof fetch;
    const tools = new Map(createProfileTools(state, deps(fetchFn)).map((t) => [t.name, t]));
    const r = (await tools.get("bcdev_profile_start")!.handler({ ...conn })) as Record<string, unknown>;
    expect(r["attachKind"]).toBe("NextSessionOnTenant");
    expect(typeof r["debuggingContext"]).toBe("string");
    expect(state.profile).not.toBeNull();
    await expect(tools.get("bcdev_profile_start")!.handler({ ...conn })).rejects.toThrow(/already active/);
  });

  test("poll reports status and ready flag", async () => {
    const fetchFn = (async (u: RequestInfo | URL) => u.toString().includes("attach") ? new Response('"NextSessionOnTenant"') : new Response('"Started"')) as unknown as typeof fetch;
    const tools = new Map(createProfileTools(state, deps(fetchFn)).map((t) => [t.name, t]));
    await tools.get("bcdev_profile_start")!.handler({ ...conn });
    const p = (await tools.get("bcdev_profile_poll")!.handler({})) as Record<string, unknown>;
    expect(p).toMatchObject({ status: "Started", ready: true });
  });

  test("finish extracts the profile, writes it, returns the hotspot summary, clears state", async () => {
    // Force a known debuggingContext by driving start's fetch to echo, then finish returns a zip named for that ctx.
    let ctx = "";
    const fetchFn = (async (u: RequestInfo | URL) => {
      const url = u.toString();
      if (url.includes("attach")) { ctx = new URL(url).searchParams.get("debuggingcontext")!; return new Response('"NextSessionOnTenant"'); }
      if (url.includes("finish")) { return new Response(makeZip(`${ctx}.alcpuprofile`, Buffer.from(profileJson)), { headers: { ETag: '"Sampling"' } }); }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const d = deps(fetchFn);
    const tools = new Map(createProfileTools(state, d).map((t) => [t.name, t]));
    await tools.get("bcdev_profile_start")!.handler({ ...conn });
    const outPath = join(d.cwd, "out.alcpuprofile");
    const f = (await tools.get("bcdev_profile_finish")!.handler({ outPath })) as Record<string, unknown>;
    expect(f["captured"]).toBe(true);
    expect(f["profilePath"]).toBe(outPath);
    const summary = f["summary"] as { hotspots: Array<{ function: string }> };
    expect(summary.hotspots[0]!.function).toBe("OnRun");
    expect(JSON.parse(readFileSync(outPath, "utf8")).nodes).toHaveLength(1);
    expect(state.profile).toBeNull();
    expect((f["nextSteps"] as string[]).join(" ")).toContain("al-perf");
  });

  test("finish on empty body reports captured:false", async () => {
    const fetchFn = (async (u: RequestInfo | URL) => u.toString().includes("attach") ? new Response('"NextSessionOnTenant"') : new Response(null, { headers: { "Content-Length": "0" } })) as unknown as typeof fetch;
    const tools = new Map(createProfileTools(state, deps(fetchFn)).map((t) => [t.name, t]));
    await tools.get("bcdev_profile_start")!.handler({ ...conn });
    const f = (await tools.get("bcdev_profile_finish")!.handler({})) as Record<string, unknown>;
    expect(f["captured"]).toBe(false);
    expect(state.profile).toBeNull();
  });

  test("finish with a non-Sampling ETag reports captured:false, kind:recording", async () => {
    const fetchFn = (async (u: RequestInfo | URL) => {
      const url = u.toString();
      if (url.includes("attach")) return new Response('"NextSessionOnTenant"');
      if (url.includes("finish")) return new Response(makeZip("whatever.mdc", Buffer.from("bin")), { headers: { ETag: '"Recording"' } });
      return new Response("{}");
    }) as unknown as typeof fetch;
    const tools = new Map(createProfileTools(state, deps(fetchFn)).map((t) => [t.name, t]));
    await tools.get("bcdev_profile_start")!.handler({ ...conn });
    const f = (await tools.get("bcdev_profile_finish")!.handler({})) as Record<string, unknown>;
    expect(f["captured"]).toBe(false);
    expect(f["kind"]).toBe("recording");
    expect(state.profile).toBeNull();
  });

  test("finish with a zip missing the expected member reports captured:false", async () => {
    let ctx = "";
    const fetchFn = (async (u: RequestInfo | URL) => {
      const url = u.toString();
      if (url.includes("attach")) { ctx = new URL(url).searchParams.get("debuggingcontext")!; return new Response('"NextSessionOnTenant"'); }
      if (url.includes("finish")) { void ctx; return new Response(makeZip("unexpected-name.alcpuprofile", Buffer.from(profileJson)), { headers: { ETag: '"Sampling"' } }); }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const tools = new Map(createProfileTools(state, deps(fetchFn)).map((t) => [t.name, t]));
    await tools.get("bcdev_profile_start")!.handler({ ...conn });
    const f = (await tools.get("bcdev_profile_finish")!.handler({})) as Record<string, unknown>;
    expect(f["captured"]).toBe(false);
    expect(f["hint"]).toContain("without the expected");
    expect(state.profile).toBeNull();
  });

  test("poll/finish without an active profile throw", async () => {
    const tools = new Map(createProfileTools(state, deps((async () => new Response("{}")) as never)).map((t) => [t.name, t]));
    await expect(tools.get("bcdev_profile_poll")!.handler({})).rejects.toThrow(/No active profile/);
    await expect(tools.get("bcdev_profile_finish")!.handler({})).rejects.toThrow(/No active profile/);
  });

  test("concurrent start is blocked — the slot is claimed before the attach await resolves", async () => {
    // attach fetch never settles until we release it, so the first start is mid-await when the second fires.
    let releaseAttach: () => void = () => {};
    const attachGate = new Promise<void>((r) => { releaseAttach = r; });
    const fetchFn = (async (u: RequestInfo | URL) => {
      if (u.toString().includes("attach")) { await attachGate; return new Response('"NextSessionOnTenant"'); }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const tools = new Map(createProfileTools(state, deps(fetchFn)).map((t) => [t.name, t]));
    const first = tools.get("bcdev_profile_start")!.handler({ ...conn }); // NOT awaited — slot claimed synchronously
    await expect(tools.get("bcdev_profile_start")!.handler({ ...conn })).rejects.toThrow(/already active/);
    releaseAttach();
    await first;
    expect(state.profile).not.toBeNull();
  });

  test("start rolls back the claimed slot when attach fails", async () => {
    const fetchFn = (async (u: RequestInfo | URL) => u.toString().includes("attach") ? new Response("nope", { status: 500 }) : new Response("{}")) as unknown as typeof fetch;
    const tools = new Map(createProfileTools(state, deps(fetchFn)).map((t) => [t.name, t]));
    await expect(tools.get("bcdev_profile_start")!.handler({ ...conn })).rejects.toThrow(/attach HTTP 500/);
    expect(state.profile).toBeNull(); // slot rolled back so a retry can start
  });

  test("finish clears the profile even when finish throws", async () => {
    const fetchFn = (async (u: RequestInfo | URL) => {
      const url = u.toString();
      if (url.includes("attach")) return new Response('"NextSessionOnTenant"');
      if (url.includes("finish")) return new Response("boom", { status: 500 });
      return new Response("{}");
    }) as unknown as typeof fetch;
    const tools = new Map(createProfileTools(state, deps(fetchFn)).map((t) => [t.name, t]));
    await tools.get("bcdev_profile_start")!.handler({ ...conn });
    await expect(tools.get("bcdev_profile_finish")!.handler({})).rejects.toThrow(/finish HTTP 500/);
    expect(state.profile).toBeNull(); // finally-clears even on error
  });

  // --- kind: instrumentation ------------------------------------------------

  test("start kind:instrumentation attaches Kind=0 and reports converterAvailable", async () => {
    const fetchFn = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (u.toString().includes("attach")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ Kind: 0, SnapshotVerbosity: 1 });
        return new Response('"NextSessionOnTenant"');
      }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const tools = new Map(
      createProfileTools(state, deps(fetchFn), { resolveEnv: () => ({ converterPath: "/conv" }), run: async () => ({ code: 0, stderr: "" }) }).map((t) => [t.name, t]),
    );
    const r = (await tools.get("bcdev_profile_start")!.handler({ ...conn, kind: "instrumentation" })) as Record<string, unknown>;
    expect(r["converterAvailable"]).toBe(true);
    expect(state.profile!.kind).toBe("instrumentation");
  });

  test("start kind:instrumentation reports converterAvailable:false and warns in the hint", async () => {
    const fetchFn = (async (u: RequestInfo | URL) => (u.toString().includes("attach") ? new Response('"NextSessionOnTenant"') : new Response("{}"))) as unknown as typeof fetch;
    const tools = new Map(
      createProfileTools(state, deps(fetchFn), { resolveEnv: () => null, run: async () => ({ code: 0, stderr: "" }) }).map((t) => [t.name, t]),
    );
    const r = (await tools.get("bcdev_profile_start")!.handler({ ...conn, kind: "instrumentation" })) as Record<string, unknown>;
    expect(r["converterAvailable"]).toBe(false);
    expect(r["hint"]).toContain("WARNING: converter not found");
  });

  test("start kind:sampling (default) does not report converterAvailable", async () => {
    const fetchFn = (async (u: RequestInfo | URL) => (u.toString().includes("attach") ? new Response('"NextSessionOnTenant"') : new Response("{}"))) as unknown as typeof fetch;
    const tools = new Map(createProfileTools(state, deps(fetchFn)).map((t) => [t.name, t]));
    const r = (await tools.get("bcdev_profile_start")!.handler({ ...conn })) as Record<string, unknown>;
    expect(r["converterAvailable"]).toBeUndefined();
    expect(state.profile!.kind).toBe("sampling");
  });

  test("finish instrumentation: converts the mdc zip, summarizes, clears state", async () => {
    let ctx = "";
    const mdcZip = makeZip("x.mdc", Buffer.from("fake-flatbuffer")); // any non-empty zip; converter is stubbed
    const fetchFn = (async (u: RequestInfo | URL) => {
      const url = u.toString();
      if (url.includes("attach")) {
        ctx = new URL(url).searchParams.get("debuggingcontext")!;
        return new Response('"NextSessionOnTenant"');
      }
      if (url.includes("finish")) return new Response(mdcZip, {}); // no ETag = instrumentation
      return new Response("{}");
    }) as unknown as typeof fetch;
    const d = deps(fetchFn);
    const run = (async (_cmd: string, args: string[]) => {
      require("node:fs").writeFileSync(args[1], profileJson); // args: [zip, out, --format, v8]
      return { code: 0, stderr: "" };
    }) as never;
    const tools = new Map(
      createProfileTools(state, d, { resolveEnv: () => ({ converterPath: "/conv" }), run }).map((t) => [t.name, t]),
    );
    await tools.get("bcdev_profile_start")!.handler({ ...conn, kind: "instrumentation" });
    void ctx;
    const f = (await tools.get("bcdev_profile_finish")!.handler({})) as Record<string, unknown>;
    expect(f["captured"]).toBe(true);
    expect(f["kind"]).toBe("instrumentation");
    expect((f["summary"] as { hotspots: unknown[] }).hotspots.length).toBeGreaterThan(0);
    expect(typeof f["zipPath"]).toBe("string");
    expect(state.profile).toBeNull();
  });

  test("finish instrumentation: raw fallback when converter unavailable", async () => {
    const mdcZip = makeZip("x.mdc", Buffer.from("fb"));
    const fetchFn = (async (u: RequestInfo | URL) => {
      const url = u.toString();
      if (url.includes("attach")) return new Response('"NextSessionOnTenant"');
      if (url.includes("finish")) return new Response(mdcZip, {});
      return new Response("{}");
    }) as unknown as typeof fetch;
    const tools = new Map(
      createProfileTools(state, deps(fetchFn), { resolveEnv: () => null, run: async () => ({ code: 0, stderr: "" }) }).map((t) => [t.name, t]),
    );
    await tools.get("bcdev_profile_start")!.handler({ ...conn, kind: "instrumentation" });
    const f = (await tools.get("bcdev_profile_finish")!.handler({})) as Record<string, unknown>;
    expect(f["captured"]).toBe(true);
    expect(f["kind"]).toBe("instrumentation-raw");
    expect(typeof f["zipPath"]).toBe("string");
    expect(state.profile).toBeNull();
  });

  test("finish instrumentation: raw fallback when converter run fails (non-zero exit)", async () => {
    const mdcZip = makeZip("x.mdc", Buffer.from("fb"));
    const fetchFn = (async (u: RequestInfo | URL) => {
      const url = u.toString();
      if (url.includes("attach")) return new Response('"NextSessionOnTenant"');
      if (url.includes("finish")) return new Response(mdcZip, {});
      return new Response("{}");
    }) as unknown as typeof fetch;
    const tools = new Map(
      createProfileTools(state, deps(fetchFn), { resolveEnv: () => ({ converterPath: "/conv" }), run: async () => ({ code: 1, stderr: "boom" }) }).map((t) => [t.name, t]),
    );
    await tools.get("bcdev_profile_start")!.handler({ ...conn, kind: "instrumentation" });
    const f = (await tools.get("bcdev_profile_finish")!.handler({})) as Record<string, unknown>;
    expect(f["captured"]).toBe(true);
    expect(f["kind"]).toBe("instrumentation-raw");
    expect(f["hint"]).toContain("conversion failed");
    expect(f["hint"]).toContain("boom");
    expect(typeof f["zipPath"]).toBe("string");
    expect(state.profile).toBeNull();
  });

  test("finish instrumentation: zip without a .mdc member reports captured:false", async () => {
    const notMdcZip = makeZip("whatever.txt", Buffer.from("nope"));
    const fetchFn = (async (u: RequestInfo | URL) => {
      const url = u.toString();
      if (url.includes("attach")) return new Response('"NextSessionOnTenant"');
      if (url.includes("finish")) return new Response(notMdcZip, {});
      return new Response("{}");
    }) as unknown as typeof fetch;
    const tools = new Map(
      createProfileTools(state, deps(fetchFn), { resolveEnv: () => null, run: async () => ({ code: 0, stderr: "" }) }).map((t) => [t.name, t]),
    );
    await tools.get("bcdev_profile_start")!.handler({ ...conn, kind: "instrumentation" });
    const f = (await tools.get("bcdev_profile_finish")!.handler({})) as Record<string, unknown>;
    expect(f["captured"]).toBe(false);
    expect(f["hint"]).toContain("no .mdc members");
    expect(state.profile).toBeNull();
  });

  test("finish instrumentation on empty body reports the instrumentation-specific hint", async () => {
    const fetchFn = (async (u: RequestInfo | URL) =>
      u.toString().includes("attach") ? new Response('"NextSessionOnTenant"') : new Response(null, { headers: { "Content-Length": "0" } })) as unknown as typeof fetch;
    const tools = new Map(
      createProfileTools(state, deps(fetchFn), { resolveEnv: () => ({ converterPath: "/conv" }), run: async () => ({ code: 0, stderr: "" }) }).map((t) => [t.name, t]),
    );
    await tools.get("bcdev_profile_start")!.handler({ ...conn, kind: "instrumentation" });
    const f = (await tools.get("bcdev_profile_finish")!.handler({})) as Record<string, unknown>;
    expect(f["captured"]).toBe(false);
    expect(f["hint"]).toContain("Full verbosity");
    expect(state.profile).toBeNull();
  });

  test("sampling path unchanged: finish still extracts .alcpuprofile via the ETag:Sampling branch", async () => {
    let ctx = "";
    const fetchFn = (async (u: RequestInfo | URL) => {
      const url = u.toString();
      if (url.includes("attach")) {
        ctx = new URL(url).searchParams.get("debuggingcontext")!;
        return new Response('"NextSessionOnTenant"');
      }
      if (url.includes("finish")) return new Response(makeZip(`${ctx}.alcpuprofile`, Buffer.from(profileJson)), { headers: { ETag: '"Sampling"' } });
      return new Response("{}");
    }) as unknown as typeof fetch;
    const d = deps(fetchFn);
    const tools = new Map(createProfileTools(state, d).map((t) => [t.name, t]));
    await tools.get("bcdev_profile_start")!.handler({ ...conn }); // no kind param — defaults to sampling
    const f = (await tools.get("bcdev_profile_finish")!.handler({})) as Record<string, unknown>;
    expect(f["captured"]).toBe(true);
    expect(f["kind"]).toBe("sampling");
    expect(f["zipPath"]).toBeUndefined();
    expect(state.profile).toBeNull();
  });
});
