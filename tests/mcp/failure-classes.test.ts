import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentErrorBodySchema } from "../../src/core/agent-errors";
import { createAuthorizationProviderFactory } from "../../src/core/authorization";
import type { GitChangeSet } from "../../src/core/git-changes";
import { buildServer } from "../../src/mcp/server";
import { ServerState } from "../../src/mcp/state";
import type { ToolDeps } from "../../src/mcp/tools";
import { FakeHub, fakeHubFactory } from "../fakes/fake-hub";
import { FakeNativeMcpGateway } from "../fakes/fake-native-mcp";
import { buildAppPackage } from "../fixtures/app-package";
import { runFailureClassContract, type FailureCase, type FailureClass, type FailureTable } from "../contract/failure-class-harness";

const APP_ID = "00000000-0000-0000-0000-000000000001";
const project = mkdtempSync(join(tmpdir(), "bcmcp-failure-classes-"));
mkdirSync(join(project, ".vscode"));
writeFileSync(
  join(project, ".vscode", "launch.json"),
  JSON.stringify({ configurations: [{ type: "al", request: "launch", server: "http://localhost", serverInstance: "BC" }] }),
);
writeFileSync(join(project, "app.json"), JSON.stringify({ id: APP_ID, name: "Probe", publisher: "Probe", version: "1.0.0.0" }));
writeFileSync(join(project, "T.Codeunit.al"), 'codeunit 50100 "T"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure A()\n    begin\n    end;\n}\n');
const appPath = join(project, "Probe.app");
writeFileSync(appPath, buildAppPackage({ publisher: "Probe", name: "Probe", appId: APP_ID, version: "1.0.0.0" }));
const missing = join(project, "does-not-exist");

/** Raw transport failures as fetch (undici) and the SignalR client raise them, not pre-classified errors. */
const disconnected = () => Promise.reject(new TypeError("fetch failed"));

function depsFor(failureClass: FailureClass): ToolDeps {
  const hub = new FakeHub();
  const gateway = new FakeNativeMcpGateway();
  const deps: ToolDeps = {
    hubFactory: fakeHubFactory(hub),
    authorizationFactory: createAuthorizationProviderFactory(),
    http10Get: async () => { throw new Error("http10Get not expected in this harness"); },
    fetchFn: (async () => new Response(JSON.stringify({
      WebApiVersion: failureClass === "unsupportedFeature" ? "6.0" : "7.0",
    }))) as unknown as typeof fetch,
    env: failureClass === "missingAuth" ? {} : { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" },
    cwd: project,
    gitChanges: async (_project, baseRef): Promise<GitChangeSet> => ({
      baseRef, mergeBase: "a".repeat(40), head: "workingTree", nonAlFiles: [], unresolvedAlFiles: [], files: [],
    }),
    callGraph: async () => ({ nodes: [], edges: [] }),
    nativeMcpGateway: gateway,
  };
  if (failureClass === "serverDisconnect") {
    hub.start = () => Promise.reject(new Error("WebSocket closed with status code: 1006 (no reason given)."));
    deps.fetchFn = disconnected as unknown as typeof fetch;
    deps.http10Get = disconnected;
    gateway.onList = disconnected;
    gateway.onCall = disconnected;
  }
  return deps;
}

async function connect(failureClass: FailureClass) {
  const server = buildServer(new ServerState(), depsFor(failureClass));
  const client = new Client({ name: "failure-class-harness", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// invalidPath points `project` at a directory that does not exist (so no launch.json is found);
// missingAuth runs with no BC_DEV_USER/BC_DEV_PASSWORD (cloud: no Entra tenant).
const NO_GATE = "no developer-API feature gate on this path; WebApiVersion is not consulted";
const connected = (args: Record<string, unknown> = {}): Record<FailureClass, FailureCase> => ({
  invalidPath: { args: { ...args, project: missing }, code: "CONFIGURATION_ERROR" },
  missingAuth: { args, code: "CONFIGURATION_ERROR" },
  unsupportedFeature: { na: NO_GATE },
  serverDisconnect: { args, code: "ENDPOINT_UNREACHABLE" },
});
const testRunnerGated = (args: Record<string, unknown>): Record<FailureClass, FailureCase> => ({
  ...connected(args),
  unsupportedFeature: { args, code: "UNSUPPORTED_SERVER" },
});
const SESSION = "acts only on in-process session state and needs a prior attach/start; connection failures surface on the tool that opened the session";
const sessionScoped: Record<FailureClass, FailureCase> = {
  invalidPath: { na: SESSION },
  missingAuth: { na: SESSION },
  unsupportedFeature: { na: SESSION },
  serverDisconnect: { na: SESSION },
};
const nativeTool = (extra: Record<string, unknown> = {}): Record<FailureClass, FailureCase> => {
  const onPrem = { company: "CRONUS", context: "business", ...extra };
  const cloud = { ...onPrem, environmentType: "Sandbox", environmentName: "sandbox" };
  return {
    invalidPath: { args: { ...onPrem, project: missing }, code: "CONFIGURATION_ERROR" },
    missingAuth: { args: cloud, code: "CONFIGURATION_ERROR" },
    unsupportedFeature: { args: onPrem, code: "UNSUPPORTED_SERVER" },
    serverDisconnect: { args: { ...cloud, tenant: "contoso" }, code: "ENDPOINT_UNREACHABLE" },
  };
};
const codeunits = [{ id: 50100 }];

const table: FailureTable = {
  bcdev_status: { ...connected(), unsupportedFeature: { na: "reports feature gates as data (supportsTestRunning) rather than failing" } },
  bcdev_test_discover: {
    invalidPath: { args: { project: missing }, code: "NOT_FOUND" },
    missingAuth: { na: "local AL source scan only; no server or credentials involved" },
    unsupportedFeature: { na: "local AL source scan only; no server involved" },
    serverDisconnect: { na: "local AL source scan only; no server involved" },
  },
  bcdev_test_run: testRunnerGated({ codeunits }),
  bcdev_test_orchestrate: testRunnerGated({ codeunits }),
  bcdev_test_select: {
    invalidPath: { args: { project: missing, baseRef: "HEAD" }, code: "NOT_FOUND" },
    missingAuth: { na: "local git diff, AL source scan and altool graph only; no server or credentials involved" },
    unsupportedFeature: { na: "local git diff, AL source scan and altool graph only; no server involved" },
    serverDisconnect: { na: "local git diff, AL source scan and altool graph only; no server involved" },
  },
  bcdev_debug_attach: connected(),
  bcdev_debug_run_tests: sessionScoped,
  bcdev_debug_wait: sessionScoped,
  bcdev_debug_continue: sessionScoped,
  bcdev_debug_variables: sessionScoped,
  bcdev_debug_eval: sessionScoped,
  bcdev_debug_sql: sessionScoped,
  bcdev_debug_breakpoints: sessionScoped,
  bcdev_debug_detach: sessionScoped,
  bcdev_record_writes_start: connected({ tableId: 18 }),
  bcdev_record_writes_status: sessionScoped,
  bcdev_record_writes_finish: sessionScoped,
  bcdev_native_list: nativeTool(),
  bcdev_native_call: nativeTool({ toolName: "probe" }),
  bcdev_profile_status: {
    ...connected(),
    serverDisconnect: { na: "preflight reports an unreachable snapshot endpoint as data (reachable:false) rather than failing" },
  },
  bcdev_profile_start: connected(),
  bcdev_profile_poll: sessionScoped,
  bcdev_profile_finish: sessionScoped,
  bcdev_source: connected({ objectType: 5, objectId: 50100 }),
  bcdev_package_download: connected({ publisher: "p", appName: "a", version: "1.0.0.0" }),
  bcdev_app_list: connected(),
  bcdev_app_publish: {
    ...connected({ appPath }),
    invalidPath: { args: { appPath: join(missing, "Probe.app") }, code: "INVALID_ARGUMENT" },
  },
  bcdev_app_uninstall: connected({ appId: APP_ID }),
  bcdev_app_unpublish: connected({ appId: APP_ID }),
};

test("every bcdev_* tool honours the four-failure-class error contract", async () => {
  expect(await runFailureClassContract({ connect, table, errorBodySchema: AgentErrorBodySchema })).toEqual([]);
}, 30_000);

test("the harness flags unclassified tools, wrong codes, and success results", async () => {
  const { bcdev_status: _omitted, ...withoutStatus } = table;
  const violations = await runFailureClassContract({
    connect,
    table: {
      ...withoutStatus,
      bcdev_test_discover: { ...table["bcdev_test_discover"]!, invalidPath: { args: { project: missing }, code: "TIMEOUT" } },
      bcdev_app_list: { ...table["bcdev_app_list"]!, missingAuth: { na: " " } },
      bcdev_profile_status: { ...table["bcdev_profile_status"]!, serverDisconnect: { args: {}, code: "ENDPOINT_UNREACHABLE" } },
    },
    errorBodySchema: AgentErrorBodySchema,
  });
  expect(violations).toContain("bcdev_status: listed by tools/list but missing from the fixture table");
  expect(violations).toContainEqual(expect.stringContaining("bcdev_test_discover/invalidPath: expected error.code TIMEOUT, got NOT_FOUND"));
  expect(violations).toContain("bcdev_app_list/missingAuth: not-applicable needs a reason");
  expect(violations).toContain("bcdev_profile_status/serverDisconnect: expected isError, got a success result");
}, 30_000);
