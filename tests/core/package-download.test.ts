import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import { BcDevError } from "../../src/core/agent-errors";
import {
  downloadPackage,
  packageDownloadUrl,
  type PackageSelector,
} from "../../src/core/package-download";
import type { ConnectionConfig } from "../../src/core/types";
import { buildAppPackage, buildStoredZip } from "../fixtures/app-package";

const APP_ID = "63ca2fa4-4f03-4f2b-a480-172fef340d3f";
const OTHER_ID = "00000000-0000-0000-0000-000000000001";
const selector: PackageSelector = {
  publisher: "Microsoft",
  appName: "System Application",
  version: "28.0.0.0",
  appId: APP_ID,
};
const config: ConnectionConfig = {
  environmentType: "OnPrem",
  authentication: "UserPassword",
  server: "http://localhost",
  serverInstance: "BC",
  tenant: "default",
  username: "u",
  password: "p",
};
const auth = new BasicAuthorizationProvider("u", "p");

function appPackage(
  overrides: Partial<{ publisher: string; name: string; appId: string; version: string }> = {},
  extra = "",
): Buffer {
  return buildAppPackage({
    publisher: overrides.publisher ?? selector.publisher,
    name: overrides.name ?? selector.appName,
    appId: overrides.appId ?? selector.appId!,
    version: overrides.version ?? "28.2.3.4",
    extra,
  });
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "bcmcp-package-"));
  writeFileSync(join(dir, "app.json"), "{}");
  return dir;
}

function responseFetch(
  body: BodyInit | Buffer | null,
  status = 200,
  capture?: { url?: string; authorization?: string; signal?: AbortSignal | null },
  headers?: HeadersInit,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (capture) {
      capture.url = input.toString();
      capture.authorization = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      capture.signal = init?.signal;
    }
    return new Response(body as BodyInit | null, { status, headers });
  }) as unknown as typeof fetch;
}

describe("packageDownloadUrl", () => {
  test("builds the official on-prem selector and tenant query", () => {
    expect(packageDownloadUrl(config, selector)).toBe(
      "http://localhost:7049/BC/dev/packages?publisher=Microsoft&appName=System+Application&versionText=28.0.0.0&appId=63ca2fa4-4f03-4f2b-a480-172fef340d3f&tenant=default",
    );
  });

  test("builds the SaaS route and omits appId for the Application concept", () => {
    const cloud: ConnectionConfig = {
      environmentType: "Sandbox",
      authentication: "EntraId",
      environmentName: "My Sandbox",
      tenant: "tenant-id",
    };
    expect(packageDownloadUrl(cloud, {
      publisher: "Microsoft",
      appName: "application",
      version: "28.0.0.0",
      appId: APP_ID,
    })).toBe(
      "https://api.businesscentral.dynamics.com/v2.0/My%20Sandbox/dev/packages?publisher=Microsoft&appName=application&versionText=28.0.0.0&tenant=tenant-id",
    );
  });

  test("rejects malformed selectors before making a request", () => {
    expect(() => packageDownloadUrl(config, { ...selector, publisher: " \n" })).toThrow(/publisher/);
    expect(() => packageDownloadUrl(config, { ...selector, version: "28.0" })).toThrow(/four-part/);
    expect(() => packageDownloadUrl(config, { ...selector, appId: "not-a-guid" })).toThrow(/GUID/);
  });
});

describe("downloadPackage", () => {
  test("downloads, validates, safely names, hashes, and installs one package", async () => {
    const capture: { url?: string; authorization?: string } = {};
    const bytes = appPackage();
    const result = await downloadPackage(config, auth, project(), selector, responseFetch(bytes, 200, capture));

    expect(result).toMatchObject({
      status: "downloaded",
      publisher: "Microsoft",
      appName: "System Application",
      appId: APP_ID,
      requestedVersion: "28.0.0.0",
      resolvedVersion: "28.2.3.4",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(basename(result.packagePath)).toBe("Microsoft_System Application_28.2.3.4.app");
    expect(readFileSync(result.packagePath).equals(bytes)).toBe(true);
    expect(capture.authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    expect(capture.url).toContain("dev/packages?");
  });

  test("treats Application as a concept selector and does not enforce a supplied app ID", async () => {
    const application = {
      publisher: "Microsoft",
      appName: "Application",
      version: "28.0.0.0",
      appId: APP_ID,
    };
    const capture: { url?: string } = {};
    const result = await downloadPackage(
      config,
      auth,
      project(),
      application,
      responseFetch(
        appPackage({ name: "Application", appId: OTHER_ID }),
        200,
        capture,
      ),
    );
    expect(capture.url).not.toContain("appId=");
    expect(result.appId).toBe(OTHER_ID);
  });

  test("returns unchanged for identical bytes and replaces only with another validated package", async () => {
    const dir = project();
    const firstBytes = appPackage({}, "first");
    const secondBytes = appPackage({}, "second");
    const first = await downloadPackage(config, auth, dir, selector, responseFetch(firstBytes));
    const unchanged = await downloadPackage(config, auth, dir, selector, responseFetch(firstBytes));
    const replaced = await downloadPackage(config, auth, dir, selector, responseFetch(secondBytes));

    expect(first.status).toBe("downloaded");
    expect(unchanged.status).toBe("unchanged");
    expect(replaced.status).toBe("replaced");
    expect(replaced.packagePath).toBe(first.packagePath);
    expect(readFileSync(replaced.packagePath).equals(secondBytes)).toBe(true);
  });

  test("serializes simultaneous identical installs into downloaded then unchanged", async () => {
    const dir = project();
    const bytes = appPackage();
    const [first, second] = await Promise.all([
      downloadPackage(config, auth, dir, selector, responseFetch(bytes)),
      downloadPackage(config, auth, dir, selector, responseFetch(bytes)),
    ]);

    expect([first.status, second.status].sort()).toEqual(["downloaded", "unchanged"]);
    const names = readdirSync(join(dir, ".alpackages"));
    expect(names.filter((name) => name.endsWith(".app"))).toHaveLength(1);
    expect(names.filter((name) => name.endsWith(".tmp") || name.endsWith(".backup"))).toEqual([]);
  });

  test("uses only validated metadata for the destination filename", async () => {
    const unsafe = {
      publisher: "Pub/lish:er",
      appName: "App<Name>.",
      version: "1.0.0.0",
      appId: APP_ID,
    };
    const result = await downloadPackage(
      config,
      auth,
      project(),
      unsafe,
      responseFetch(appPackage({ publisher: unsafe.publisher, name: unsafe.appName, version: unsafe.version })),
    );
    expect(basename(result.packagePath)).toBe("Publisher_AppName._1.0.0.0.app");
  });

  test("accepts a higher resolved version but rejects wrong identity and an older package", async () => {
    const higher = await downloadPackage(config, auth, project(), selector, responseFetch(appPackage()));
    expect(higher.resolvedVersion).toBe("28.2.3.4");

    await expect(downloadPackage(
      config,
      auth,
      project(),
      selector,
      responseFetch(appPackage({ appId: OTHER_ID })),
    )).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(downloadPackage(
      config,
      auth,
      project(),
      selector,
      responseFetch(appPackage({ name: "Other App" })),
    )).rejects.toThrow(/different publisher or name/);
    await expect(downloadPackage(
      config,
      auth,
      project(),
      selector,
      responseFetch(appPackage({ version: "27.9.9.9" })),
    )).rejects.toThrow(/older than/);
    await expect(downloadPackage(
      config,
      auth,
      project(),
      { ...selector, appName: "Straße" },
      responseFetch(appPackage({ name: "Strasse" })),
    )).rejects.toThrow(/different publisher or name/);
  });

  test("rejects invalid archives and symbols without leaving a package or temporary file", async () => {
    for (const bytes of [
      Buffer.from("not a package"),
      Buffer.concat([Buffer.from("NAVX"), Buffer.alloc(36), buildStoredZip([{ name: "other.txt", content: Buffer.from("x") }])]),
      Buffer.concat([
        Buffer.from("NAVX"),
        Buffer.alloc(36),
        buildStoredZip([{ name: "SymbolReference.json", content: Buffer.from("{") }]),
      ]),
    ]) {
      const dir = project();
      await expect(downloadPackage(config, auth, dir, selector, responseFetch(bytes))).rejects.toMatchObject({
        code: "PROTOCOL_ERROR",
      });
      expect(readdirSync(dir)).toEqual(["app.json"]);
    }
  });

  test("does not replace an existing package when the new response fails validation", async () => {
    const dir = project();
    const good = appPackage();
    const installed = await downloadPackage(config, auth, dir, selector, responseFetch(good));
    await expect(downloadPackage(config, auth, dir, selector, responseFetch(Buffer.from("bad")))).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
    });
    expect(readFileSync(installed.packagePath).equals(good)).toBe(true);
    expect(readdirSync(join(dir, ".alpackages")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("returns typed authentication, not-found, server, and network errors", async () => {
    await expect(downloadPackage(config, auth, project(), selector, responseFetch(null, 401))).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await expect(downloadPackage(config, auth, project(), selector, responseFetch(null, 404))).rejects.toMatchObject({
      code: "NOT_FOUND",
      details: { appId: APP_ID },
    });
    await expect(downloadPackage(config, auth, project(), selector, responseFetch(null, 503))).rejects.toMatchObject({
      code: "SERVER_REJECTED",
      retryable: true,
    });
    const offline = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    await expect(downloadPackage(config, auth, project(), selector, offline)).rejects.toMatchObject({
      code: "ENDPOINT_UNREACHABLE",
      retryable: true,
    });
  });

  test("preserves authorization failures and does not start a package request", async () => {
    const authFailure = new BcDevError(
      "AUTHENTICATION_FAILED",
      "Azure CLI login is unavailable",
      "auth",
    );
    let fetched = false;
    const fetchFn = (async () => {
      fetched = true;
      return new Response();
    }) as unknown as typeof fetch;
    const rejectingAuth = {
      getAuthorizationHeader: async () => {
        throw authFailure;
      },
    };

    const error = await downloadPackage(config, rejectingAuth, project(), selector, fetchFn).catch((caught) => caught);
    expect(error).toBe(authFailure);
    expect(fetched).toBe(false);
  });

  test("cancels an unused error response body", async () => {
    let cancelled = false;
    const fetchFn = (async () => ({
      status: 404,
      ok: false,
      headers: new Headers(),
      body: {
        cancel: async () => {
          cancelled = true;
        },
      },
    })) as unknown as typeof fetch;
    await expect(downloadPackage(config, auth, project(), selector, fetchFn)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(cancelled).toBe(true);
  });

  test("enforces both declared and streamed size bounds", async () => {
    await expect(downloadPackage(
      config,
      auth,
      project(),
      selector,
      responseFetch("12345", 200, undefined, { "Content-Length": "5" }),
      { maxBytes: 4 },
    )).rejects.toMatchObject({ code: "PROTOCOL_ERROR", details: { maxBytes: 4, contentLength: 5 } });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    await expect(downloadPackage(
      config,
      auth,
      project(),
      selector,
      responseFetch(body),
      { maxBytes: 4 },
    )).rejects.toMatchObject({ code: "PROTOCOL_ERROR", details: { maxBytes: 4, receivedBytes: 6 } });
  });

  test("times out an unfinished request and passes an abort signal", async () => {
    let signal: AbortSignal | null | undefined;
    const pending = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as unknown as typeof fetch;
    await expect(downloadPackage(
      config,
      auth,
      project(),
      selector,
      pending,
      { timeoutMs: 5 },
    )).rejects.toMatchObject({ code: "TIMEOUT", retryable: true, details: { timeoutMs: 5 } });
    expect(signal?.aborted).toBe(true);
  });

  test("rejects a non-directory project before making a package request", async () => {
    const file = join(project(), "not-a-directory");
    writeFileSync(file, "x");
    let fetched = false;
    const fetchFn = (async () => {
      fetched = true;
      return new Response(Uint8Array.from(appPackage()));
    }) as unknown as typeof fetch;
    await expect(downloadPackage(config, auth, file, selector, fetchFn)).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    expect(fetched).toBe(false);
  });

  test("rejects a missing or non-AL project without creating directories or fetching", async () => {
    const parent = project();
    const missing = join(parent, "typo-project");
    const noManifest = mkdtempSync(join(tmpdir(), "bcmcp-not-al-"));
    let authorizations = 0;
    let fetches = 0;
    const countingAuth = {
      getAuthorizationHeader: async () => {
        authorizations += 1;
        return "Basic test";
      },
    };
    const fetchFn = (async () => {
      fetches += 1;
      return new Response(Uint8Array.from(appPackage()));
    }) as unknown as typeof fetch;

    for (const candidate of [missing, noManifest]) {
      await expect(downloadPackage(config, countingAuth, candidate, selector, fetchFn)).rejects.toMatchObject({
        code: "CONFIGURATION_ERROR",
      });
    }
    expect(existsSync(missing)).toBe(false);
    expect(authorizations).toBe(0);
    expect(fetches).toBe(0);
  });

  if (process.platform !== "win32") {
    test("rejects a symlinked .alpackages directory instead of writing outside the project", async () => {
      const dir = project();
      const outside = project();
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(dir, ".alpackages"), "dir");
      await expect(downloadPackage(config, auth, dir, selector, responseFetch(appPackage()))).rejects.toMatchObject({
        code: "CONFIGURATION_ERROR",
      });
      expect(readdirSync(outside).filter((name) => name.endsWith(".app"))).toEqual([]);
    });
  }
});
