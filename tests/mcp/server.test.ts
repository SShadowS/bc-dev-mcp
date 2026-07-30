import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, installSdkErrorFormatter, toToolResponse } from "../../src/mcp/server";
import { createAuthorizationProviderFactory } from "../../src/core/authorization";
import { ServerState } from "../../src/mcp/state";
import { FakeHub, fakeHubFactory } from "../fakes/fake-hub";
import type { GitChangeSet } from "../../src/core/git-changes";
import { FakeNativeMcpGateway } from "../fakes/fake-native-mcp";

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "bcmcp-server-"));
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(
    join(dir, ".vscode", "launch.json"),
    JSON.stringify({ configurations: [{ type: "al", request: "launch", server: "http://localhost", serverInstance: "BC" }] }),
  );
  writeFileSync(join(dir, "T.Codeunit.al"), 'codeunit 50100 "T"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure A()\n    begin\n    end;\n}\n');
  return dir;
}

async function connect() {
  const state = new ServerState();
  const server = buildServer(state, {
    hubFactory: fakeHubFactory(new FakeHub()),
    authorizationFactory: createAuthorizationProviderFactory(),
    fetchFn: (async () => new Response(JSON.stringify({ WebApiVersion: "7.0" }))) as unknown as typeof fetch,
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" },
    cwd: makeProject(),
    gitChanges: async (_project, baseRef): Promise<GitChangeSet> => ({
      baseRef,
      mergeBase: "a".repeat(40),
      head: "workingTree",
      files: [],
    }),
    nativeMcpGateway: new FakeNativeMcpGateway(),
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("server wiring", () => {
  test("tools/list exposes names, titles, annotations, schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(23);
    const status = tools.find((t) => t.name === "bcdev_status")!;
    expect(status.title).toBe("BC server status");
    expect(status.annotations?.readOnlyHint).toBe(true);
    expect(status.outputSchema).toBeDefined(); // guards against SDK silently dropping non-object schemas
    const attach = tools.find((t) => t.name === "bcdev_debug_attach")!;
    const lineDesc = JSON.stringify(attach.inputSchema);
    expect(lineDesc).toContain("1-based");
    expect(lineDesc).toContain("sessionId");
    expect(lineDesc).toContain("userId");
    expect(lineDesc).toContain("mutually exclusive");
    expect(lineDesc).toContain("takes precedence");
    const attachProperties = (attach.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(attachProperties["sessionId"]).toMatchObject({ type: "integer", exclusiveMinimum: 0 });
    expect(attachProperties["userId"]).toMatchObject({ type: "string", minLength: 1 });
    expect(JSON.stringify(attachProperties["breakOnError"])).toContain("unhandled");
    expect(JSON.stringify(attachProperties["breakOnRecordWrite"])).toContain("nonTemporary");
    const wait = tools.find((t) => t.name === "bcdev_debug_wait")!;
    expect(JSON.stringify(wait.outputSchema)).toContain("sessionBound");
    const orchestration = tools.find((t) => t.name === "bcdev_test_orchestrate")!;
    expect(orchestration.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(JSON.stringify(orchestration.inputSchema)).toContain("maximum");
    expect(JSON.stringify(orchestration.outputSchema)).toContain("stablePassed");
    expect(JSON.stringify(orchestration.outputSchema)).toContain("ambiguous");
    const recordWrites = tools.find((t) => t.name === "bcdev_record_writes_start")!;
    expect(JSON.stringify(recordWrites.inputSchema)).toContain("maxObservedWrites");
    expect(JSON.stringify(recordWrites.inputSchema)).toContain("changesDeployed");
    expect(JSON.stringify(recordWrites.inputSchema)).toContain("tableId");
    const nativeList = tools.find((t) => t.name === "bcdev_native_list")!;
    expect(nativeList.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(JSON.stringify(nativeList.inputSchema)).toContain("debugging");
    expect(JSON.stringify(nativeList.inputSchema)).not.toContain("profiling");
    const nativeCall = tools.find((t) => t.name === "bcdev_native_call")!;
    expect(nativeCall.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    for (const t of tools) {
      expect(t.outputSchema, `${t.name} outputSchema`).toBeDefined();
      const properties = (t.outputSchema as { properties?: Record<string, unknown> }).properties;
      expect(properties?.["nextSteps"], `${t.name} nextSteps`).toMatchObject({ type: "array" });
    }
  });

  test("callTool returns structuredContent and text", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "bcdev_test_discover", arguments: {} });
    const structured = result.structuredContent as { tests: Array<{ codeunitId: number }> };
    expect(structured.tests[0]?.codeunitId).toBe(50100);
    expect((result.content as Array<{ type: string; text: string }>)[0]?.text).toContain("50100");
  });

  test("errors come back as isError text, not protocol failures", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "bcdev_debug_wait", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
      error: { code: string; category: string; tool: string; retryable: boolean; message: string; details: Record<string, unknown> };
      nextSteps: string[];
    };
    expect(body.error).toEqual({
      code: "NO_DEBUG_SESSION",
      category: "state",
      tool: "bcdev_debug_wait",
      retryable: false,
      message: "No debug session — call bcdev_debug_attach first",
      details: {},
    });
    expect(body.nextSteps.join(" ")).toContain("bcdev_debug_attach");
  });

  test("SDK input validation failures use the same machine-readable error contract", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "bcdev_debug_attach", arguments: { sessionId: 0 } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
      error: { code: string; category: string; tool: string; retryable: boolean };
      nextSteps: string[];
    };
    expect(body.error).toMatchObject({
      code: "INVALID_ARGUMENT",
      category: "validation",
      tool: "bcdev_debug_attach",
      retryable: false,
    });
    expect(body.nextSteps.join(" ")).toContain("input schema");
  });

  test("serves skills as skill:// resources with an index", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual([
      "skill://bc-al-debugging/SKILL.md",
      "skill://bc-al-testing/SKILL.md",
      "skill://bc-native-mcp/SKILL.md",
      "skill://index.json",
    ]);

    const index = await client.readResource({ uri: "skill://index.json" });
    const parsed = JSON.parse((index.contents[0] as { text: string }).text) as {
      skills: Array<{ url: string; type: string }>;
    };
    expect(parsed.skills).toHaveLength(3);
    for (const s of parsed.skills) expect(uris).toContain(s.url);

    const skill = await client.readResource({ uri: "skill://bc-al-debugging/SKILL.md" });
    const content = skill.contents[0] as { mimeType?: string; text: string };
    expect(content.mimeType).toBe("text/markdown");
    expect(content.text).toContain("bcdev_debug_attach");
  });

  test("declares the skills extension capability", async () => {
    const client = await connect();
    const caps = client.getServerCapabilities() as { extensions?: Record<string, object> };
    expect(caps.extensions?.["io.modelcontextprotocol/skills"]).toBeDefined();
  });

  test("profile tools are listed with schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["bcdev_profile_status", "bcdev_profile_start", "bcdev_profile_poll", "bcdev_profile_finish"]) {
      expect(names).toContain(n);
    }
    const start = tools.find((t) => t.name === "bcdev_profile_start")!;
    expect(start.outputSchema).toBeDefined();
    expect(JSON.stringify(start.inputSchema)).toContain("samplingIntervalMs");
  });

  test("start exposes the kind:instrumentation option", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(23);
    const start = tools.find((t) => t.name === "bcdev_profile_start")!;
    expect(JSON.stringify(start.inputSchema)).toContain("instrumentation");
  });
});

describe("toToolResponse", () => {
  test("object results carry structuredContent", () => {
    const r = toToolResponse({ a: 1 });
    expect(r.structuredContent).toEqual({ a: 1 });
    expect(r.content[0]?.text).toContain('"a"');
  });

  test("non-object results omit structuredContent but keep text content", () => {
    for (const value of ["plain text", 42, true, undefined, null]) {
      const r = toToolResponse(value);
      expect(r.structuredContent, String(value)).toBeUndefined();
      expect(r.content[0]?.type).toBe("text");
    }
  });
});

describe("installSdkErrorFormatter", () => {
  test("degrades to the SDK formatter when the private seam is missing", () => {
    const warnings: string[] = [];
    expect(installSdkErrorFormatter({} as never, (message) => warnings.push(message))).toBe(false);
    expect(warnings).toEqual([expect.stringContaining("default formatting")]);
  });

  test("degrades when the private seam is not replaceable", () => {
    const server = {} as Record<string, unknown>;
    Object.defineProperty(server, "createToolError", { value: () => ({}), writable: false });
    const warnings: string[] = [];
    expect(installSdkErrorFormatter(server as never, (message) => warnings.push(message))).toBe(false);
    expect(warnings).toEqual([expect.stringContaining("not replaceable")]);
  });

  test("degrades when an SDK accessor ignores the replacement", () => {
    const original = () => ({});
    const server = {} as Record<string, unknown>;
    Object.defineProperty(server, "createToolError", { get: () => original, set: () => {}, configurable: true });
    const warnings: string[] = [];
    expect(installSdkErrorFormatter(server as never, (message) => warnings.push(message))).toBe(false);
    expect(warnings).toEqual([expect.stringContaining("did not take effect")]);
    expect(server["createToolError"]).toBe(original);
  });
});
