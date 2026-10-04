import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import { listApps, publishApp, uninstallApp, unpublishApp, type AppLifecycleContext } from "../../src/core/app-lifecycle";
import { BcDevError } from "../../src/core/agent-errors";
import type { ConnectionConfig } from "../../src/core/types";
import { buildAppPackage } from "../fixtures/app-package";

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
  return {
    config,
    authorization: new BasicAuthorizationProvider("u", "p"),
    fetchFn,
    // Route the HTTP/1.0 read path through the same scripted queue so tests see one call log.
    http10Get: async (url, headers, signal) => {
      const response = await fetchFn(url, { method: "GET", headers, signal });
      return { status: response.status, body: await response.text() };
    },
    ...over,
  };
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

describe("publishApp", () => {
  function appFile(name = "probe.app", bytes?: Buffer): { path: string; bytes: Buffer } {
    const content = bytes ?? buildAppPackage({ publisher: "SShadowS Probe", name: "probe-base", appId: BASE_APP, version: "1.0.0.0" });
    const path = join(mkdtempSync(join(tmpdir(), "bcmcp-publish-")), name);
    writeFileSync(path, content);
    return { path, bytes: content };
  }

  test("posts one multipart part named after the file and reports the package identity", async () => {
    const file = appFile();
    const { fetchFn, calls } = scripted(() => new Response(null, { status: 200 }));
    const result = await publishApp(ctx(fetchFn), { appPath: file.path, schemaUpdateMode: "recreate", dependencyPublishingOption: "strict" });
    expect(result).toEqual({
      status: "published",
      appId: BASE_APP,
      name: "probe-base",
      publisher: "SShadowS Probe",
      version: "1.0.0.0",
      bytes: file.bytes.length,
      schemaUpdateMode: "recreate",
      dependencyPublishingOption: "strict",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://cronus28:7049/BC/dev/apps?tenant=default&SchemaUpdateMode=recreate&DependencyPublishingOption=strict");
    const form = calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const part = form.get("probe.app") as File;
    expect(part.name).toBe("probe.app");
    expect(part.size).toBe(file.bytes.length);
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
  });

  test("defaults to synchronize and default dependency publishing", async () => {
    const file = appFile();
    const { fetchFn, calls } = scripted(() => new Response("", { status: 200 }));
    const result = await publishApp(ctx(fetchFn), { appPath: file.path });
    expect(result).toMatchObject({ schemaUpdateMode: "synchronize", dependencyPublishingOption: "default" });
    expect(calls[0]!.url).toContain("SchemaUpdateMode=synchronize&DependencyPublishingOption=default");
  });

  test("422 compile failure passes through as SERVER_REJECTED with BC's message", async () => {
    const file = appFile();
    const message = "Publishing failed due to 'Extension compilation failed\r\nerror AL1024: A package with publisher 'SShadowS Probe', name 'probe-base' ... could not be loaded.'. The original extensions have been restored.";
    const { fetchFn } = scripted(json({ Message: message, ErrorType: "InvalidOperation" }, 422));
    const error = (await publishApp(ctx(fetchFn), { appPath: file.path }).catch((e: unknown) => e)) as Error & { code: string; details: Record<string, unknown> };
    expect(error.code).toBe("SERVER_REJECTED");
    expect(error.details).toMatchObject({ httpStatus: 422, bcErrorCode: "InvalidOperation" });
    expect(String(error.details["bcMessage"])).toContain("AL1024");
  });

  test("relative, non-.app, missing, and invalid files are INVALID_ARGUMENT with no request", async () => {
    const { fetchFn, calls } = scripted();
    await expect(publishApp(ctx(fetchFn), { appPath: "probe.app" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(publishApp(ctx(fetchFn), { appPath: appFile("probe.zip").path })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(publishApp(ctx(fetchFn), { appPath: join(tmpdir(), "does-not-exist-bcmcp.app") })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(publishApp(ctx(fetchFn), { appPath: appFile("bad.app", Buffer.from("not a zip")).path })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("not a valid AL .app package"),
    });
    expect(calls).toHaveLength(0);
  });
});


describe("transport selection", () => {
  test("on-prem GETs use http10Get and POSTs use fetch", async () => {
    const reads: string[] = [];
    const http10Get = async (url: string) => {
      reads.push(url);
      return url.includes("/companies?")
        ? { status: 200, body: JSON.stringify({ value: [{ id: COMPANY }] }) }
        : { status: 200, body: JSON.stringify({ value: [row({ isInstalled: false })] }) };
    };
    const { fetchFn, calls } = scripted(noContent());
    await unpublishApp(ctx(fetchFn, { http10Get }), { appId: BASE_APP });
    expect(reads).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
  });

  test("SaaS GETs use fetch, never http10Get", async () => {
    const cloud: ConnectionConfig = { environmentType: "Sandbox", authentication: "EntraId", environmentName: "Sandbox", tenant: "contoso.onmicrosoft.com" };
    const http10Get = async () => { throw new Error("http10Get must not be used for SaaS"); };
    const { fetchFn, calls } = scripted(companies(), extensions(row()));
    const result = await listApps({ config: cloud, authorization: new BasicAuthorizationProvider("u", "p"), fetchFn, http10Get });
    expect(result.apps).toHaveLength(1);
    expect(calls[0]!.url).toStartWith("https://api.businesscentral.dynamics.com/v2.0/Sandbox/api/microsoft/automation/v2.0/companies");
  });

  test("an HTTP/1.0 protocol failure surfaces as PROTOCOL_ERROR, not ENDPOINT_UNREACHABLE", async () => {
    const http10Get = async () => { throw new BcDevError("PROTOCOL_ERROR", "Business Central response was truncated (10 of 50 bytes)", "protocol"); };
    const { fetchFn } = scripted();
    await expect(listApps(ctx(fetchFn, { http10Get }))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });
});

describe("listApps paging", () => {
  test("follows @odata.nextLink on the same origin", async () => {
    const { fetchFn, calls } = scripted(
      companies(),
      json({ value: [row()], "@odata.nextLink": `${ROOT}/companies(${COMPANY})/extensions?tenant=default&$skiptoken=abc` }),
      extensions(depRow()),
    );
    const result = await listApps(ctx(fetchFn));
    expect(result.apps.map((a) => a.appId)).toEqual([BASE_APP, DEP_APP]);
    expect(calls[2]!.url).toContain("$skiptoken=abc");
  });

  test("a nextLink to another origin is PROTOCOL_ERROR and is not requested", async () => {
    const { fetchFn, calls } = scripted(
      companies(),
      json({ value: [row()], "@odata.nextLink": "http://evil.example/steal" }),
    );
    await expect(listApps(ctx(fetchFn))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(calls).toHaveLength(2);
  });
});

describe("listApps malformed nextLink", () => {
  test("an unparseable nextLink is PROTOCOL_ERROR, not a raw TypeError", async () => {
    const { fetchFn } = scripted(companies(), json({ value: [row()], "@odata.nextLink": "http://[" }));
    await expect(listApps(ctx(fetchFn))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });
});

describe("uninstallApp vanished rows", () => {
  test("an app installed before but missing afterwards produces a warning naming it", async () => {
    const { fetchFn } = scripted(
      companies(),
      extensions(row(), depRow()),
      noContent(),
      extensions(row({ isInstalled: false })),
    );
    const result = await uninstallApp(ctx(fetchFn), { appId: BASE_APP });
    expect(result.status).toBe("uninstalled");
    expect(result.alsoUninstalled).toEqual([]);
    expect(result.warning).toContain("probe-dependent");
    expect(result.warning).toContain("bcdev_app_list");
  });
});
