import { describe, expect, test } from "bun:test";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import { listApps, uninstallApp, unpublishApp, type AppLifecycleContext } from "../../src/core/app-lifecycle";
import type { ConnectionConfig } from "../../src/core/types";

// Fixture identities are the throwaway probe apps used live on Cronus28, 2026-10-03.
export const COMPANY = "f95feb05-5f9a-f111-90dd-70a8a5531db6";
export const BASE_APP = "7a1c0001-0000-4000-8000-0000000000b1";
export const BASE_PKG = "685b0721-a3be-4563-8e8a-9853e3fbc16b";
export const DEP_APP = "7a1c0002-0000-4000-8000-0000000000d1";
export const DEP_PKG = "40aa1ead-3dca-4c10-92a4-ade9ef8ad688";
const ROOT = "http://cronus28:7048/BC/api/microsoft/automation/v2.0";

const config: ConnectionConfig = {
  environmentType: "OnPrem",
  authentication: "UserPassword",
  server: "http://cronus28",
  serverInstance: "BC",
  tenant: "default",
  username: "u",
  password: "p",
};

export interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

export function scripted(...responses: Array<() => Response>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: input.toString(),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${input.toString()}`);
    return next();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

export function ctx(fetchFn: typeof fetch, over: Partial<AppLifecycleContext> = {}): AppLifecycleContext {
  return { config, authorization: new BasicAuthorizationProvider("u", "p"), fetchFn, ...over };
}

export const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const noContent = () => () => new Response(null, { status: 204 });
export const companies = () => json({ value: [{ id: COMPANY }, { id: "de60eb05-5f9a-f111-90dd-70a8a5531db6" }] });

export function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "@odata.etag": 'W/"JzE5OzQ0MDgzNTg2OTg0MzAyNzYyNDgxOzAwOyc="',
    packageId: BASE_PKG,
    id: BASE_APP,
    displayName: "probe-base",
    publisher: "SShadowS Probe",
    versionMajor: 1,
    versionMinor: 0,
    versionBuild: 0,
    versionRevision: 0,
    isInstalled: true,
    // WIRE: Cronus28 returns " Dev" with a leading space.
    publishedAs: " Dev",
    ...over,
  };
}
export const depRow = (over: Record<string, unknown> = {}) =>
  row({ packageId: DEP_PKG, id: DEP_APP, displayName: "probe-dependent", ...over });
export const extensions = (...rows: Record<string, unknown>[]) => json({ value: rows });

describe("listApps", () => {
  test("resolves the first company and maps extension rows", async () => {
    const { fetchFn, calls } = scripted(companies(), extensions(row(), depRow({ isInstalled: false })));
    const result = await listApps(ctx(fetchFn));
    expect(result.companyId).toBe(COMPANY);
    expect(result.apps).toEqual([
      { appId: BASE_APP, packageId: BASE_PKG, name: "probe-base", publisher: "SShadowS Probe", version: "1.0.0.0", isInstalled: true, publishedAs: "Dev" },
      { appId: DEP_APP, packageId: DEP_PKG, name: "probe-dependent", publisher: "SShadowS Probe", version: "1.0.0.0", isInstalled: false, publishedAs: "Dev" },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      `${ROOT}/companies?$select=id&tenant=default`,
      `${ROOT}/companies(${COMPANY})/extensions?tenant=default`,
    ]);
    expect(calls[0]!.headers["Authorization"]).toBe("Basic dTpw");
  });

  test("an explicit companyId skips company lookup and is lower-cased", async () => {
    const { fetchFn, calls } = scripted(extensions(row()));
    const result = await listApps(ctx(fetchFn, { companyId: COMPANY.toUpperCase() }));
    expect(result.companyId).toBe(COMPANY);
    expect(calls).toHaveLength(1);
  });

  test("filters by appId case-insensitively on the client", async () => {
    const { fetchFn } = scripted(companies(), extensions(row(), depRow()));
    const result = await listApps(ctx(fetchFn), { appId: DEP_APP.toUpperCase() });
    expect(result.apps.map((a) => a.appId)).toEqual([DEP_APP]);
  });

  test("escapes apostrophes in the publisher filter", async () => {
    const { fetchFn, calls } = scripted(companies(), extensions());
    await listApps(ctx(fetchFn), { publisher: "O'Neil Apps" });
    expect(calls[1]!.url).toBe(
      `${ROOT}/companies(${COMPANY})/extensions?$filter=publisher%20eq%20'O''Neil%20Apps'&tenant=default`,
    );
  });

  test("no company → NOT_FOUND telling the caller to pass companyId", async () => {
    const { fetchFn } = scripted(json({ value: [] }));
    await expect(listApps(ctx(fetchFn))).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("companyId") });
  });

  test("malformed GUID arguments are INVALID_ARGUMENT before any request", async () => {
    const { fetchFn, calls } = scripted();
    await expect(listApps(ctx(fetchFn, { companyId: "nope" }))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(listApps(ctx(fetchFn), { appId: "nope" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls).toHaveLength(0);
  });

  test("an unexpected row shape is PROTOCOL_ERROR", async () => {
    const { fetchFn } = scripted(companies(), extensions(row({ versionMajor: "1" })));
    await expect(listApps(ctx(fetchFn))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });
});

describe("error normalization", () => {
  test("401 → AUTHENTICATION_FAILED without credentials in the error", async () => {
    const { fetchFn } = scripted(json({ error: { code: "Unauthorized", message: "nope" } }, 401));
    const error = (await listApps(ctx(fetchFn)).catch((e: unknown) => e)) as Error & { details: unknown };
    expect(error).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    const text = `${error.message} ${JSON.stringify(error.details)}`;
    expect(text).not.toContain("dTpw");
    expect(text).not.toContain("Basic");
  });

  test("Automation API error body → SERVER_REJECTED with BC code and message verbatim", async () => {
    const message = "The extension probe-base cannot be unpublished because it is installed.  CorrelationId:  1ec507bc-3747-4547-ba0d-0bf63a661ba7.";
    const { fetchFn } = scripted(json({ error: { code: "Application_DialogException", message } }, 400));
    await expect(listApps(ctx(fetchFn))).rejects.toMatchObject({
      code: "SERVER_REJECTED",
      retryable: false,
      details: { httpStatus: 400, bcErrorCode: "Application_DialogException", bcMessage: message },
    });
  });

  test("404 → NOT_FOUND carrying the BC message", async () => {
    const { fetchFn } = scripted(json({ error: { code: "BadRequest_ResourceNotFound", message: "Resource not found for the segment 'extensions'." } }, 404));
    await expect(listApps(ctx(fetchFn))).rejects.toMatchObject({
      code: "NOT_FOUND",
      details: { httpStatus: 404, bcErrorCode: "BadRequest_ResourceNotFound" },
    });
  });

  test("HTML error body from HTTP.sys is reduced to readable text", async () => {
    const html = '<HTML><HEAD><TITLE>Length Required</TITLE></HEAD><BODY><h2>Length Required</h2><hr><p>HTTP Error 411. The request must be chunked or have a content length.</p></BODY></HTML>';
    const { fetchFn } = scripted(() => new Response(html, { status: 411, headers: { "content-type": "text/html" } }));
    const error = (await listApps(ctx(fetchFn)).catch((e: unknown) => e)) as { code: string; details: Record<string, unknown> };
    expect(error.code).toBe("SERVER_REJECTED");
    expect(error.details["bcErrorCode"]).toBeNull();
    expect(String(error.details["bcMessage"])).toContain("HTTP Error 411");
    expect(String(error.details["bcMessage"])).not.toContain("<");
  });

  test("5xx is retryable", async () => {
    const { fetchFn } = scripted(() => new Response("Bad Gateway", { status: 502 }));
    await expect(listApps(ctx(fetchFn))).rejects.toMatchObject({ code: "SERVER_REJECTED", retryable: true, details: { bcMessage: "Bad Gateway" } });
  });

  test("network failure → ENDPOINT_UNREACHABLE", async () => {
    const fetchFn = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(listApps(ctx(fetchFn))).rejects.toMatchObject({ code: "ENDPOINT_UNREACHABLE", retryable: true });
  });

  test("timeout → TIMEOUT", async () => {
    const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    await expect(listApps(ctx(fetchFn, { timeoutMs: 10 }))).rejects.toMatchObject({ code: "TIMEOUT", details: { timeoutMs: 10 } });
  });
});

describe("uninstallApp", () => {
  test("reports the dependent BC uninstalled along with the target (probed cascade)", async () => {
    const { fetchFn, calls } = scripted(
      companies(),
      extensions(row(), depRow()),
      noContent(),
      extensions(row({ isInstalled: false }), depRow({ isInstalled: false })),
    );
    const result = await uninstallApp(ctx(fetchFn), { appId: BASE_APP.toUpperCase() });
    expect(result).toMatchObject({ status: "uninstalled", dataDeleted: false, app: { appId: BASE_APP, isInstalled: false } });
    expect(result.alsoUninstalled).toEqual([expect.objectContaining({ appId: DEP_APP, isInstalled: false })]);
    expect(result.warning).toBeUndefined();
    const post = calls[2]!;
    expect(post.method).toBe("POST");
    expect(post.url).toBe(`${ROOT}/companies(${COMPANY})/extensions(${BASE_PKG})/Microsoft.NAV.uninstall?tenant=default`);
    expect(post.body).toBe("");
    // Company is resolved once; the re-list reuses it.
    expect(calls.filter((c) => c.url.includes("/companies?"))).toHaveLength(1);
  });

  test("deleteData selects uninstallAndDeleteExtensionData", async () => {
    const { fetchFn, calls } = scripted(companies(), extensions(row()), noContent(), extensions(row({ isInstalled: false })));
    const result = await uninstallApp(ctx(fetchFn), { appId: BASE_APP, deleteData: true });
    expect(result.dataDeleted).toBe(true);
    expect(calls[2]!.url).toContain("/Microsoft.NAV.uninstallAndDeleteExtensionData?");
  });

  test("published but not installed → alreadyUninstalled with no POST", async () => {
    const { fetchFn, calls } = scripted(companies(), extensions(row({ isInstalled: false })));
    const result = await uninstallApp(ctx(fetchFn), { appId: BASE_APP });
    expect(result).toMatchObject({ status: "alreadyUninstalled", dataDeleted: false, alsoUninstalled: [] });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("targets the installed row when several versions are published", async () => {
    const OLD_PKG = "11111111-1111-4111-8111-111111111111";
    const { fetchFn, calls } = scripted(
      companies(),
      extensions(row({ packageId: OLD_PKG, isInstalled: false }), row({ versionMinor: 1 })),
      noContent(),
      extensions(row({ packageId: OLD_PKG, isInstalled: false }), row({ versionMinor: 1, isInstalled: false })),
    );
    const result = await uninstallApp(ctx(fetchFn), { appId: BASE_APP });
    expect(result.app.version).toBe("1.1.0.0");
    expect(calls[2]!.url).toContain(`extensions(${BASE_PKG})`);
  });

  test("a successful uninstall whose re-list fails still reports success, with a warning", async () => {
    const { fetchFn } = scripted(
      companies(),
      extensions(row(), depRow()),
      noContent(),
      () => new Response("Bad Gateway", { status: 502 }),
    );
    const result = await uninstallApp(ctx(fetchFn), { appId: BASE_APP });
    expect(result.status).toBe("uninstalled");
    expect(result.alsoUninstalled).toBeNull();
    expect(result.warning).toContain("bcdev_app_list");
  });

  test("unknown appId → NOT_FOUND", async () => {
    const { fetchFn } = scripted(companies(), extensions(depRow()));
    await expect(uninstallApp(ctx(fetchFn), { appId: BASE_APP })).rejects.toMatchObject({ code: "NOT_FOUND", details: { appId: BASE_APP } });
  });
});

describe("unpublishApp", () => {
  test("unpublishes the single published version", async () => {
    const { fetchFn, calls } = scripted(companies(), extensions(row({ isInstalled: false })), noContent());
    const result = await unpublishApp(ctx(fetchFn), { appId: BASE_APP });
    expect(result).toEqual({ status: "unpublished", app: expect.objectContaining({ appId: BASE_APP, version: "1.0.0.0" }) });
    expect(calls[2]!.url).toBe(`${ROOT}/companies(${COMPANY})/extensions(${BASE_PKG})/Microsoft.NAV.unpublish?tenant=default`);
    expect(calls[2]!.body).toBe("");
  });

  test("several versions without version → INVALID_ARGUMENT listing them, no POST", async () => {
    const OLD_PKG = "11111111-1111-4111-8111-111111111111";
    const { fetchFn, calls } = scripted(companies(), extensions(row({ packageId: OLD_PKG }), row({ versionMinor: 1 })));
    await expect(unpublishApp(ctx(fetchFn), { appId: BASE_APP })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { publishedVersions: "1.0.0.0, 1.1.0.0" },
    });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("version selects one row; leading zeros are normalized", async () => {
    const OLD_PKG = "11111111-1111-4111-8111-111111111111";
    const { fetchFn, calls } = scripted(companies(), extensions(row({ packageId: OLD_PKG }), row({ versionMinor: 1 })), noContent());
    await unpublishApp(ctx(fetchFn), { appId: BASE_APP, version: "1.01.0.0" });
    expect(calls[2]!.url).toContain(`extensions(${BASE_PKG})`);
  });

  test("version that is not published → NOT_FOUND naming the published versions", async () => {
    const { fetchFn } = scripted(companies(), extensions(row()));
    await expect(unpublishApp(ctx(fetchFn), { appId: BASE_APP, version: "2.0.0.0" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      details: { publishedVersions: "1.0.0.0", version: "2.0.0.0" },
    });
  });

  test("BC refusal while installed passes through verbatim", async () => {
    const message = "The extension probe-base cannot be unpublished because it is installed.  CorrelationId:  1ec507bc-3747-4547-ba0d-0bf63a661ba7.";
    const { fetchFn } = scripted(companies(), extensions(row()), json({ error: { code: "Application_DialogException", message } }, 400));
    await expect(unpublishApp(ctx(fetchFn), { appId: BASE_APP })).rejects.toMatchObject({
      code: "SERVER_REJECTED",
      details: { httpStatus: 400, bcErrorCode: "Application_DialogException", bcMessage: message },
    });
  });

  test("malformed version → INVALID_ARGUMENT before any request", async () => {
    const { fetchFn, calls } = scripted();
    await expect(unpublishApp(ctx(fetchFn), { appId: BASE_APP, version: "1.0" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls).toHaveLength(0);
  });
});

