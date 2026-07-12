import { describe, expect, test } from "bun:test";
import { SnapshotClient } from "../../../src/core/snapshot/snapshot-client";
import { BasicAuthorizationProvider } from "../../../src/core/authorization";

const cfg = { environmentType: "OnPrem", authentication: "UserPassword", server: "http://bc", serverInstance: "BC", tenant: "default", username: "u", password: "p" } as const;
const auth = new BasicAuthorizationProvider("u", "p");

function fakeFetch(routes: Array<{ match: RegExp; res: () => Response }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = routes.find((x) => x.match.test(url));
    if (!r) throw new Error(`no fake route for ${url}`);
    return r.res();
  }) as unknown as typeof fetch;
}

describe("SnapshotClient", () => {
  test("uses the injected authorization provider for HTTP requests", async () => {
    let calls = 0;
    let sent = "";
    const authorization = { getAuthorizationHeader: async () => { calls++; return "Bearer fake"; } };
    const c = new SnapshotClient(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = (init?.headers as Record<string, string>)["Authorization"]!;
        return new Response(JSON.stringify({ runtimeVersion: "17.0", webApiVersion: "3.0" }));
      }) as unknown as typeof fetch,
      cfg,
      7083,
      authorization,
    );
    await c.metadata();
    expect(sent).toBe("Bearer fake");
    expect(calls).toBe(1);
  });

  test("metadata parses ServerInfo", async () => {
    const c = new SnapshotClient(
      fakeFetch([{ match: /snapshotendpointmetadata/, res: () => new Response(JSON.stringify({ runtimeVersion: "17.0", webApiVersion: "3.0", webEndpoint: "http://bc/BC/" })) }]),
      cfg, 7083, auth,
    );
    expect(await c.metadata()).toMatchObject({ webApiVersion: "3.0" });
  });

  test("attach returns kind and captures Set-Cookie affinity", async () => {
    const c = new SnapshotClient(
      fakeFetch([{ match: /attach/, res: () => new Response('"NextSessionOnTenant"', { headers: { "Set-Cookie": "ApplicationGatewayAffinity=abc123; path=/" } }) }]),
      cfg, 7083, auth,
    );
    const r = await c.attachSampling({ debuggingContext: "ctx", clientType: "WebClient", samplingIntervalMs: 100, sessionId: -1 });
    expect(r.attachKind).toBe("NextSessionOnTenant");
    expect(r.affinityCookie).toBe("abc123");
  });

  test("attach tolerates a missing affinity cookie (single-node)", async () => {
    const c = new SnapshotClient(fakeFetch([{ match: /attach/, res: () => new Response('"NextSessionOnTenant"') }]), cfg, 7083, auth);
    expect((await c.attachSampling({ debuggingContext: "ctx", clientType: "WebClient", samplingIntervalMs: 100, sessionId: -1 })).affinityCookie).toBeNull();
  });

  test("attach errors retain redacted diagnostic response text", async () => {
    const body = "denied Authorization: Bearer eyJSECRET.rest; check consent";
    const c = new SnapshotClient(fakeFetch([{ match: /attach/, res: () => new Response(body, { status: 401 }) }]), cfg, 7083, auth);
    const error = await c.attachSampling({ debuggingContext: "ctx", clientType: "WebClient", samplingIntervalMs: 100, sessionId: -1 })
      .then(
        () => { throw new Error("expected attach to fail"); },
        (caught: unknown) => caught as Error,
      );
    expect(error.message).toContain("snapshot attach HTTP 401");
    expect(error.message).toContain("check consent");
    expect(error.message).not.toContain("eyJSECRET.rest");
  });

  test("status parses the enum; affinity cookie is resent when present", async () => {
    // re-wrap to capture the request; simpler: use a capturing fake
    let sawCookie = "";
    let sawQuery = "";
    const capturing = new SnapshotClient(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        sawCookie = (init?.headers as Record<string, string>)?.["Cookie"] ?? "";
        sawQuery = input.toString();
        return new Response('"Started"');
      }) as unknown as typeof fetch,
      cfg, 7083, auth,
    );
    expect(await capturing.status("ctx", "abc123")).toBe("Started");
    expect(sawCookie).toBe("ApplicationGatewayAffinity=abc123");
    expect(sawQuery).toContain("applicationgatewayaffinity=abc123");
  });

  test("finish returns empty flag on zero-length body", async () => {
    const c = new SnapshotClient(fakeFetch([{ match: /finish/, res: () => new Response(null, { headers: { "Content-Length": "0" } }) }]), cfg, 7083, auth);
    expect((await c.finish("ctx", null)).empty).toBe(true);
  });

  test("finish returns etag + bytes for a sampling body", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4]);
    const c = new SnapshotClient(fakeFetch([{ match: /finish/, res: () => new Response(bytes, { headers: { ETag: '"Sampling"' } }) }]), cfg, 7083, auth);
    const r = await c.finish("ctx", null);
    expect(r.empty).toBe(false);
    expect(r.etag).toBe("Sampling");
    expect(Array.from(r.body)).toEqual([0x50, 0x4b, 3, 4]);
  });

  test("finish resends the affinity cookie as header + query when present", async () => {
    let sawCookie = "";
    let sawQuery = "";
    const capturing = new SnapshotClient(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        sawCookie = (init?.headers as Record<string, string>)?.["Cookie"] ?? "";
        sawQuery = input.toString();
        return new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { headers: { ETag: '"Sampling"' } });
      }) as unknown as typeof fetch,
      cfg, 7083, auth,
    );
    const r = await capturing.finish("ctx", "abc123");
    expect(r.empty).toBe(false);
    expect(sawCookie).toBe("ApplicationGatewayAffinity=abc123");
    expect(sawQuery).toContain("applicationgatewayaffinity=abc123");
  });

  test("attach reads the affinity cookie via getSetCookie() when .get('set-cookie') is null", async () => {
    // Some runtimes (undici/Bun) return null from headers.get('set-cookie') even when a
    // Set-Cookie is present, exposing it only via getSetCookie(). Simulate that shape.
    const fakeRes = {
      ok: true,
      status: 200,
      headers: {
        get: (_name: string) => null,
        getSetCookie: () => ["ApplicationGatewayAffinity=xyz; path=/"],
      },
      text: async () => '"NextSessionOnTenant"',
    } as unknown as Response;
    const c = new SnapshotClient(fakeFetch([{ match: /attach/, res: () => fakeRes }]), cfg, 7083, auth);
    const r = await c.attachSampling({ debuggingContext: "ctx", clientType: "WebClient", samplingIntervalMs: 100, sessionId: -1 });
    expect(r.affinityCookie).toBe("xyz");
  });

  test("attachInstrumentation posts Kind=0 body and returns kind + cookie", async () => {
    let sentBody = "";
    const c = new SnapshotClient(
      (async (u: RequestInfo | URL, init?: RequestInit) => { if (u.toString().includes("attach")) { sentBody = String(init?.body); return new Response('"NextSessionOnTenant"'); } return new Response("{}"); }) as unknown as typeof fetch,
      cfg, 7083, auth,
    );
    const r = await c.attachInstrumentation({ debuggingContext: "ctx", clientType: "WebClient", sessionId: -1 });
    expect(r.attachKind).toBe("NextSessionOnTenant");
    expect(JSON.parse(sentBody)).toMatchObject({ Kind: 0, SnapshotVerbosity: 1 });
  });

  test("attachInstrumentation captures Set-Cookie affinity like attachSampling", async () => {
    const c = new SnapshotClient(
      fakeFetch([{ match: /attach/, res: () => new Response('"NextSessionOnTenant"', { headers: { "Set-Cookie": "ApplicationGatewayAffinity=abc123; path=/" } }) }]),
      cfg, 7083, auth,
    );
    const r = await c.attachInstrumentation({ debuggingContext: "ctx", clientType: "WebClient", sessionId: -1 });
    expect(r.affinityCookie).toBe("abc123");
  });

  test("attachInstrumentation tolerates a missing affinity cookie (single-node)", async () => {
    const c = new SnapshotClient(fakeFetch([{ match: /attach/, res: () => new Response('"NextSessionOnTenant"') }]), cfg, 7083, auth);
    expect((await c.attachInstrumentation({ debuggingContext: "ctx", clientType: "WebClient", sessionId: -1 })).affinityCookie).toBeNull();
  });

  describe("non-2xx responses throw with the status", () => {
    const cases: Array<{ name: string; verb: RegExp; call: (c: SnapshotClient) => Promise<unknown> }> = [
      { name: "metadata", verb: /snapshotendpointmetadata/, call: (c) => c.metadata() },
      { name: "attachSampling", verb: /attach/, call: (c) => c.attachSampling({ debuggingContext: "ctx", clientType: "WebClient", samplingIntervalMs: 100, sessionId: -1 }) },
      { name: "attachInstrumentation", verb: /attach/, call: (c) => c.attachInstrumentation({ debuggingContext: "ctx", clientType: "WebClient", sessionId: -1 }) },
      { name: "status", verb: /status/, call: (c) => c.status("ctx", null) },
      { name: "finish", verb: /finish/, call: (c) => c.finish("ctx", null) },
    ];
    for (const { name, verb, call } of cases) {
      test(`${name} rejects on HTTP 500`, async () => {
        const c = new SnapshotClient(fakeFetch([{ match: verb, res: () => new Response(null, { status: 500 }) }]), cfg, 7083, auth);
        await expect(call(c)).rejects.toThrow(/500/);
      });
    }
  });
});
