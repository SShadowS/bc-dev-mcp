import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BcDevError } from "../../src/core/agent-errors";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import { downloadPackage, type PackageSelector } from "../../src/core/package-download";
import { downloadSymbols, readPackageManifest } from "../../src/core/symbols-download";
import type { ConnectionConfig } from "../../src/core/types";
import { buildAppPackage, buildDeflatedZip, buildNavxManifest, buildStoredZip, type AppPackageFixture } from "../fixtures/app-package";

const SYSTEM = "8874ed3a-0643-4247-9ced-7a7002f7135d";
const APPLICATION = "c1335042-3002-4257-bf8a-75c898ccb1b8";
const SYSAPP = "63ca2fa4-4f03-4f2b-a480-172fef340d3f";
const BF = "f3552374-a1f2-4356-848e-196002525837";
const BASE = "437dbf0e-84ff-417a-965d-ed2bb9650972";
const DEP = "11111111-1111-1111-1111-111111111111";
const DEP2 = "22222222-2222-2222-2222-222222222222";

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

const sysApp = (v = "29.0.1.0"): AppPackageFixture => ({ publisher: "Microsoft", name: "System Application", appId: SYSAPP, version: v });
const bf: AppPackageFixture = {
  publisher: "Microsoft", name: "Business Foundation", appId: BF, version: "29.0.1.0",
  dependencies: [{ id: SYSAPP, name: "System Application", publisher: "Microsoft", minVersion: "29.0.0.0" }],
};
const base: AppPackageFixture = {
  publisher: "Microsoft", name: "Base Application", appId: BASE, version: "29.0.1.0", propagateDependencies: true,
  dependencies: [
    { id: SYSAPP, name: "System Application", publisher: "Microsoft", minVersion: "29.0.0.0" },
    { id: BF, name: "Business Foundation", publisher: "Microsoft", minVersion: "29.0.0.0" },
  ],
};
const application: AppPackageFixture = {
  publisher: "Microsoft", name: "Application", appId: APPLICATION, version: "29.0.1.0", propagateDependencies: true,
  dependencies: [
    { id: SYSAPP, name: "System Application", publisher: "Microsoft", minVersion: "29.0.0.0" },
    { id: BF, name: "Business Foundation", publisher: "Microsoft", minVersion: "29.0.0.0" },
    { id: BASE, name: "Base Application", publisher: "Microsoft", minVersion: "29.0.0.0" },
  ],
};
const system: AppPackageFixture = { publisher: "Microsoft", name: "System", appId: SYSTEM, version: "29.0.56030.0" };

function project(appJson: Record<string, unknown>, cached: Record<string, AppPackageFixture> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "bcmcp-symbols-"));
  writeFileSync(join(dir, "app.json"), "﻿" + JSON.stringify(appJson));
  if (Object.keys(cached).length > 0) {
    mkdirSync(join(dir, ".alpackages"));
    for (const [file, fixture] of Object.entries(cached)) writeFileSync(join(dir, ".alpackages", file), buildAppPackage(fixture));
  }
  return dir;
}

/** A fake dev/packages server: serves fixtures by appName, records each request's query. */
function server(packages: AppPackageFixture[], statusFor: Record<string, number> = {}) {
  const requests: URLSearchParams[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const query = new URL(input.toString()).searchParams;
    requests.push(query);
    const name = query.get("appName")!;
    if (statusFor[name]) return new Response("{}", { status: statusFor[name] });
    const fixture = packages.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!fixture) return new Response('{"Message":"No published package matches the provided arguments."}', { status: 404 });
    return new Response(Uint8Array.from(buildAppPackage(fixture)));
  }) as unknown as typeof fetch;
  const fetchPackage = (dir: string) => (selector: PackageSelector) => downloadPackage(config, auth, dir, selector, fetchFn);
  return { requests, fetchPackage, names: () => requests.map((q) => q.get("appName")) };
}

const ALL = [system, application, sysApp(), bf, base];

describe("readPackageManifest", () => {
  test("reads the App identity, PropagateDependencies and Dependency elements with entity decoding", () => {
    const bytes = buildAppPackage({
      publisher: "Fabrikam & Co", name: "Tools <Core>", appId: DEP, version: "1.2.3.4", propagateDependencies: true,
      dependencies: [{ id: DEP2.toUpperCase(), name: 'He said "hi"', publisher: "A&B", minVersion: "2.0.0.0" }],
    });
    expect(readPackageManifest(bytes)).toEqual({
      appId: DEP, publisher: "Fabrikam & Co", name: "Tools <Core>", version: "1.2.3.4", propagateDependencies: true,
      dependencies: [{ appId: DEP2, name: 'He said "hi"', publisher: "A&B", minVersion: "2.0.0.0" }],
    });
  });

  test("returns null for a package without a usable manifest", () => {
    expect(readPackageManifest(buildStoredZip([{ name: "NavxManifest.xml", content: Buffer.from("<Package />") }]))).toBeNull();
    expect(readPackageManifest(Buffer.from("not a zip"))).toBeNull();
  });

  test("returns null for an oversized NavxManifest instead of inflating it unbounded", () => {
    const manifest = buildNavxManifest({ publisher: "P", name: "A", appId: DEP, version: "1.0.0.0" });
    const small = buildDeflatedZip([{ name: "NavxManifest.xml", content: Buffer.from(manifest) }]);
    expect(readPackageManifest(small)).not.toBeNull();
    const huge = buildDeflatedZip([{ name: "NavxManifest.xml", content: Buffer.from(manifest + " ".repeat(2 * 1024 * 1024)) }]);
    expect(huge.length).toBeLessThan(64 * 1024);
    expect(readPackageManifest(huge)).toBeNull();
  });
});

describe("downloadSymbols", () => {
  test("requests System (appId), Application (no appId), then dependencies in app.json order", async () => {
    const dir = project({
      platform: "28.0.0.0", application: "28.0.0.0",
      dependencies: [{ id: DEP, name: "Dep", publisher: "Fabrikam", version: "1.0.0.0" }],
    });
    const fake = server([system, { ...application, dependencies: [] }, { publisher: "Fabrikam", name: "Dep", appId: DEP, version: "1.0.0.5" }]);
    const result = await downloadSymbols(dir, {}, fake.fetchPackage(dir));

    expect(fake.names()).toEqual(["System", "Application", "Dep"]);
    expect(fake.requests[0]!.get("appId")).toBe(SYSTEM);
    expect(fake.requests[1]!.has("appId")).toBe(false);
    expect(fake.requests[2]!.get("appId")).toBe(DEP);
    expect(result.packageDir).toBe(join(dir, ".alpackages"));
    expect(result.packages.map((p) => [p.appName, p.source, p.status, p.requiredBy])).toEqual([
      ["System", "platform", "downloaded", "app.json"],
      ["Application", "application", "downloaded", "app.json"],
      ["Dep", "dependency", "downloaded", "app.json"],
    ]);
    expect(result.packages[1]!.appId).toBeUndefined();
    expect(result.packages[2]).toMatchObject({ minVersion: "1.0.0.0", resolvedVersion: "1.0.0.5" });
    expect(result.summary).toEqual({ downloaded: 3, replaced: 0, unchanged: 0, skipped: 0, missing: 0, failed: 0 });
  });

  test("follows the transitive closure, fetching a dependency listed by two parents once", async () => {
    const dir = project({ application: "28.0.0.0" });
    const fake = server(ALL);
    const result = await downloadSymbols(dir, {}, fake.fetchPackage(dir));

    expect(fake.names()).toEqual(["Application", "System Application", "Business Foundation", "Base Application"]);
    expect(result.packages.slice(1).map((p) => [p.appName, p.source, p.requiredBy, p.appId])).toEqual([
      ["System Application", "transitive", "Microsoft/Application", SYSAPP],
      ["Business Foundation", "transitive", "Microsoft/Application", BF],
      ["Base Application", "transitive", "Microsoft/Application", BASE],
    ]);
  });

  test("skips a cached package under a non-canonical filename at a satisfying version", async () => {
    const cachedSystem = { ...system, version: "28.0.50283.0" };
    const ok = project({ platform: "28.0.0.0" }, { "System.app": cachedSystem });
    const fake = server(ALL);
    const result = await downloadSymbols(ok, {}, fake.fetchPackage(ok));
    expect(fake.requests).toHaveLength(0);
    expect(result.packages[0]).toMatchObject({
      status: "skipped", resolvedVersion: "28.0.50283.0", packagePath: join(ok, ".alpackages", "System.app"),
    });

    const newer = project({ platform: "29.0.0.0" }, { "System.app": cachedSystem });
    const again = server(ALL);
    const upgraded = await downloadSymbols(newer, {}, again.fetchPackage(newer));
    expect(again.names()).toEqual(["System"]);
    expect(upgraded.packages[0]).toMatchObject({ status: "downloaded", resolvedVersion: "29.0.56030.0" });
  });

  test("a skipped cached package still contributes its manifest dependencies", async () => {
    const dir = project({ application: "28.0.0.0" }, { "Application.app": application, "Base.app": base });
    const fake = server(ALL);
    const result = await downloadSymbols(dir, {}, fake.fetchPackage(dir));
    expect(fake.names()).toEqual(["System Application", "Business Foundation"]);
    expect(result.summary).toMatchObject({ skipped: 2, downloaded: 2 });
  });

  test("a 404 fails only that package; its dependencies are not explored", async () => {
    const dir = project({
      platform: "28.0.0.0",
      dependencies: [
        { id: DEP, name: "Missing", publisher: "Nobody", version: "1.0.0.0" },
        { appId: BF, name: "Business Foundation", publisher: "Microsoft", version: "29.0.0.0" },
      ],
    });
    const fake = server([system, bf, sysApp()]);
    const result = await downloadSymbols(dir, {}, fake.fetchPackage(dir));
    expect(fake.names()).toEqual(["System", "Missing", "Business Foundation", "System Application"]);
    expect(result.packages[1]).toMatchObject({ appName: "Missing", status: "failed", error: { code: "NOT_FOUND" } });
    expect(result.packages[1]!.error!.message).toContain("Nobody/Missing");
    expect(result.summary).toEqual({ downloaded: 3, replaced: 0, unchanged: 0, skipped: 0, missing: 0, failed: 1 });

    const parentFails = project({ application: "28.0.0.0" });
    const down = server(ALL, { Application: 500 });
    const failed = await downloadSymbols(parentFails, {}, down.fetchPackage(parentFails));
    expect(down.names()).toEqual(["Application"]);
    expect(failed.packages[0]).toMatchObject({ status: "failed", error: { code: "SERVER_REJECTED" } });
  });

  test("401 aborts the whole call with AUTHENTICATION_FAILED", async () => {
    const dir = project({ platform: "28.0.0.0", application: "28.0.0.0" });
    const fake = server(ALL, { System: 401 });
    const error = await downloadSymbols(dir, {}, fake.fetchPackage(dir)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BcDevError);
    expect((error as BcDevError).code).toBe("AUTHENTICATION_FAILED");
    expect(fake.requests).toHaveLength(1);
  });

  test("force re-requests cached packages; identical bytes report unchanged", async () => {
    const dir = project({ platform: "28.0.0.0" });
    const fake = server(ALL);
    await downloadSymbols(dir, {}, fake.fetchPackage(dir));
    const forced = await downloadSymbols(dir, { force: true }, fake.fetchPackage(dir));
    expect(fake.names()).toEqual(["System", "System"]);
    expect(forced.packages[0]!.status).toBe("unchanged");
    expect(forced.summary.unchanged).toBe(1);
  });

  test("dryRun makes no requests, needs no downloader, and reports direct references only", async () => {
    const dir = project(
      { platform: "28.0.0.0", application: "28.0.0.0", dependencies: [{ id: DEP, name: "Dep", publisher: "Fabrikam", version: "1.0.0.0" }] },
      { "System.app": { ...system, version: "28.0.50283.0" }, "Application.app": application },
    );
    const result = await downloadSymbols(dir, { dryRun: true }, null);
    expect(result.packages.map((p) => [p.appName, p.status])).toEqual([
      ["System", "skipped"], ["Application", "skipped"], ["Dep", "missing"],
    ]);
    expect(result.summary).toMatchObject({ skipped: 2, missing: 1 });
  });

  test("invalid app.json references are INVALID_ARGUMENT naming the field; missing app.json is CONFIGURATION_ERROR", async () => {
    const codeOf = async (dir: string) => {
      const e = await downloadSymbols(dir, { dryRun: true }, null).catch((x: unknown) => x) as BcDevError;
      return [e.code, e.message];
    };
    const [badVersionCode, badVersion] = await codeOf(project({ platform: "28.0" }));
    expect(badVersionCode).toBe("INVALID_ARGUMENT");
    expect(badVersion).toContain("platform");
    const [noIdCode, noId] = await codeOf(project({ dependencies: [{ name: "Dep", publisher: "Fabrikam", version: "1.0.0.0" }] }));
    expect(noIdCode).toBe("INVALID_ARGUMENT");
    expect(noId).toContain("dependencies[0]");
    const empty = mkdtempSync(join(tmpdir(), "bcmcp-symbols-"));
    expect((await codeOf(empty))[0]).toBe("CONFIGURATION_ERROR");
    const broken = mkdtempSync(join(tmpdir(), "bcmcp-symbols-"));
    writeFileSync(join(broken, "app.json"), "{ nope");
    expect((await codeOf(broken))[0]).toBe("CONFIGURATION_ERROR");
  });

  test("a higher minimum found after the package was processed warns on that entry", async () => {
    const a: AppPackageFixture = { publisher: "P", name: "A", appId: DEP, version: "1.0.0.0" };
    const b: AppPackageFixture = { publisher: "P", name: "B", appId: DEP2, version: "1.0.0.0", dependencies: [{ id: DEP, name: "A", publisher: "P", minVersion: "2.0.0.0" }] };
    const dir = project({ dependencies: [
      { id: DEP, name: "A", publisher: "P", version: "1.0.0.0" },
      { id: DEP2, name: "B", publisher: "P", version: "1.0.0.0" },
    ] });
    const fake = server([a, b]);
    const result = await downloadSymbols(dir, {}, fake.fetchPackage(dir));
    expect(fake.names()).toEqual(["A", "B"]);
    expect(result.packages[0]!.warning).toContain("P/B requires >= 2.0.0.0");
    expect(result.packages[0]!.warning).toContain("force");
    expect(result.packages[1]!.warning).toBeUndefined();
  });

  test("a dependency on Application by appId dedups with the app.json Application concept", async () => {
    const dep: AppPackageFixture = {
      publisher: "Fabrikam", name: "Dep", appId: DEP, version: "1.0.0.0",
      dependencies: [{ id: APPLICATION, name: "Application", publisher: "Microsoft", minVersion: "28.0.0.0" }],
    };
    const dir = project({ application: "28.0.0.0", dependencies: [{ id: DEP, name: "Dep", publisher: "Fabrikam", version: "1.0.0.0" }] });
    const fake = server([{ ...application, dependencies: [] }, dep]);
    const result = await downloadSymbols(dir, {}, fake.fetchPackage(dir));
    expect(fake.names()).toEqual(["Application", "Dep"]);
    expect(result.packages).toHaveLength(2);
  });

  test("a transitive reference with an unusable selector fails only that package", async () => {
    const long = "X".repeat(300);
    const dep: AppPackageFixture = {
      publisher: "Fabrikam", name: "Dep", appId: DEP, version: "1.0.0.0",
      dependencies: [{ id: DEP2, name: long, publisher: "Fabrikam", minVersion: "1.0.0.0" }],
    };
    const dir = project({ platform: "28.0.0.0", dependencies: [{ id: DEP, name: "Dep", publisher: "Fabrikam", version: "1.0.0.0" }] });
    const fake = server([system, dep]);
    const result = await downloadSymbols(dir, {}, fake.fetchPackage(dir));
    expect(fake.names()).toEqual(["System", "Dep"]);
    expect(result.packages[2]).toMatchObject({ appName: long, source: "transitive", status: "failed", error: { code: "INVALID_ARGUMENT" } });
    expect(result.summary).toMatchObject({ downloaded: 2, failed: 1 });
  });

  test("a dependency cycle terminates", async () => {
    const a: AppPackageFixture = { publisher: "P", name: "A", appId: DEP, version: "1.0.0.0", dependencies: [{ id: DEP2, name: "B", publisher: "P", minVersion: "1.0.0.0" }] };
    const b: AppPackageFixture = { publisher: "P", name: "B", appId: DEP2, version: "1.0.0.0", dependencies: [{ id: DEP, name: "A", publisher: "P", minVersion: "1.0.0.0" }] };
    const dir = project({ dependencies: [{ id: DEP, name: "A", publisher: "P", version: "1.0.0.0" }] });
    const fake = server([a, b]);
    const result = await downloadSymbols(dir, {}, fake.fetchPackage(dir));
    expect(fake.names()).toEqual(["A", "B"]);
    expect(result.packages).toHaveLength(2);
  });
});
