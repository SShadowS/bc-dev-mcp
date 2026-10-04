import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools, type ToolDeps } from "../../src/mcp/tools";
import { createAuthorizationProviderFactory } from "../../src/core/authorization";
import { ServerState } from "../../src/mcp/state";
import { FakeHub, fakeHubFactory } from "../fakes/fake-hub";
import { FakeNativeMcpGateway } from "../fakes/fake-native-mcp";

const COMPANY = "f95feb05-5f9a-f111-90dd-70a8a5531db6";
const BASE_APP = "7a1c0001-0000-4000-8000-0000000000b1";
const DEP_APP = "7a1c0002-0000-4000-8000-0000000000d1";

function row(id: string, packageId: string, name: string, isInstalled: boolean) {
  return { packageId, id, displayName: name, publisher: "SShadowS Probe", versionMajor: 1, versionMinor: 0, versionBuild: 0, versionRevision: 0, isInstalled, publishedAs: " Dev" };
}

function setup(responses: Array<() => Response>, env: Record<string, string> = {}) {
  const urls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    urls.push(input.toString());
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${input.toString()}`);
    return next();
  }) as unknown as typeof fetch;
  const project = mkdtempSync(join(tmpdir(), "bcmcp-app-tools-"));
  mkdirSync(join(project, ".vscode"));
  writeFileSync(join(project, ".vscode", "launch.json"), JSON.stringify({
    configurations: [{ type: "al", request: "launch", server: "http://cronus28", serverInstance: "BC" }],
  }));
  const deps: ToolDeps = {
    hubFactory: fakeHubFactory(new FakeHub()),
    authorizationFactory: createAuthorizationProviderFactory(),
    fetchFn,
    http10Get: async (url, headers, signal) => {
      const response = await fetchFn(url, { method: "GET", headers, signal });
      return { status: response.status, body: await response.text() };
    },
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p", ...env },
    cwd: project,
    gitChanges: async () => { throw new Error("unused"); },
    nativeMcpGateway: new FakeNativeMcpGateway(),
  };
  const tools = new Map(createTools(new ServerState(), deps).map((t) => [t.name, t]));
  return { tools, urls };
}

const json = (body: unknown) => () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("app tools", () => {
  test("registers four tools with read-only/destructive annotations", () => {
    const { tools } = setup([]);
    expect(tools.get("bcdev_app_list")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const name of ["bcdev_app_publish", "bcdev_app_uninstall", "bcdev_app_unpublish"]) {
      expect(tools.get(name)!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(tools.get("bcdev_app_uninstall")!.description).toContain("dependent");
  });

  test("bcdev_app_list uses BC_DEV_API_PORT and the result matches the output schema", async () => {
    const { tools, urls } = setup([json({ value: [{ id: COMPANY }] }), json({ value: [row(BASE_APP, "685b0721-a3be-4563-8e8a-9853e3fbc16b", "probe-base", true)] })], { BC_DEV_API_PORT: "7148" });
    const tool = tools.get("bcdev_app_list")!;
    const result = await tool.handler({});
    expect(urls[0]).toStartWith("http://cronus28:7148/BC/api/microsoft/automation/v2.0/companies");
    expect(() => tool.outputSchema.parse(result)).not.toThrow();
    expect(result).toMatchObject({ companyId: COMPANY, apps: [{ appId: BASE_APP, publishedAs: "Dev" }], nextSteps: [] });
  });

  test("apiPort parameter wins over BC_DEV_API_PORT", async () => {
    const { tools, urls } = setup([json({ value: [{ id: COMPANY }] }), json({ value: [] })], { BC_DEV_API_PORT: "7148" });
    await tools.get("bcdev_app_list")!.handler({ apiPort: 7248 });
    expect(urls[0]).toStartWith("http://cronus28:7248/");
  });

  test("an invalid BC_DEV_API_PORT is CONFIGURATION_ERROR", async () => {
    const { tools } = setup([], { BC_DEV_API_PORT: "seventy" });
    await expect(tools.get("bcdev_app_list")!.handler({})).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });

  test("bcdev_app_uninstall reports the cascade and guides the next step", async () => {
    const basePkg = "685b0721-a3be-4563-8e8a-9853e3fbc16b";
    const depPkg = "40aa1ead-3dca-4c10-92a4-ade9ef8ad688";
    const { tools } = setup([
      json({ value: [{ id: COMPANY }] }),
      json({ value: [row(BASE_APP, basePkg, "probe-base", true), row(DEP_APP, depPkg, "probe-dependent", true)] }),
      () => new Response(null, { status: 204 }),
      json({ value: [row(BASE_APP, basePkg, "probe-base", false), row(DEP_APP, depPkg, "probe-dependent", false)] }),
    ]);
    const tool = tools.get("bcdev_app_uninstall")!;
    const result = await tool.handler({ appId: BASE_APP }) as Record<string, unknown>;
    expect(() => tool.outputSchema.parse(result)).not.toThrow();
    expect(result["alsoUninstalled"]).toEqual([expect.objectContaining({ appId: DEP_APP })]);
    expect((result["nextSteps"] as string[]).join(" ")).toContain("alsoUninstalled");
    expect((result["nextSteps"] as string[]).join(" ")).toContain("bcdev_app_unpublish");
  });
});
