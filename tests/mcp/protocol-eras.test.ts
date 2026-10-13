// Both MCP protocol eras over the same entry the binary uses (serveStdio + a buildServer factory):
// 2025-11-25 clients open with `initialize`, 2026-07-28 clients with `server/discover` and a
// per-request `_meta` envelope.
import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport, ProtocolError, ProtocolErrorCode, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "../../src/mcp/server";
import { ServerState } from "../../src/mcp/state";
import type { ToolDeps } from "../../src/mcp/tools";

const MODERN = "2026-07-28";
const envelope = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "era-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

let handle: StdioServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

function serve(): InMemoryTransport {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const state = new ServerState(); // one state shared by whatever instance the era selects
  handle = serveStdio(() => buildServer(state, {} as ToolDeps), { transport: serverSide });
  return clientSide;
}

// Raw JSON-RPC over the transport, so the assertions see the wire result before any client decoding.
async function rawSession() {
  const transport = serve();
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  transport.onmessage = (message: JSONRPCMessage) => {
    const m = message as Record<string, unknown>;
    if (typeof m["id"] === "number") pending.get(m["id"])?.(m);
  };
  await transport.start();
  let nextId = 1;
  return (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const response = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    void transport.send({ jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope } } as JSONRPCMessage);
    return response;
  };
}

describe("legacy era (2025-11-25 initialize)", () => {
  test("initialize -> tools/list -> tools/call", async () => {
    const client = new Client({ name: "legacy-client", version: "0.0.0" });
    await client.connect(serve());
    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getServerVersion()).toMatchObject({ name: "bc-dev-mcp" });
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    expect(client.getServerCapabilities()?.resources?.listChanged).toBe(false);
    expect(client.getServerCapabilities()?.extensions).toHaveProperty(["io.modelcontextprotocol/skills"]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("bcdev_debug_wait");

    const result = await client.callTool({ name: "bcdev_debug_wait", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
      error: { code: "NO_DEBUG_SESSION", tool: "bcdev_debug_wait" },
    });

    const unknown = await client.callTool({ name: "bcdev_nope", arguments: {} }).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(ProtocolError);
    expect((unknown as ProtocolError).code).toBe(ProtocolErrorCode.InvalidParams);
    await client.close();
  });
});

describe("modern era (2026-07-28 server/discover)", () => {
  test("an SDK client pinned to 2026-07-28 lists and calls tools", async () => {
    const client = new Client({ name: "modern-client", version: "0.0.0" }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(serve());
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const result = await client.callTool({ name: "bcdev_debug_wait", arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });

  test("wire results carry resultType, cache hints and serverInfo; unknown tool is -32602", async () => {
    const request = await rawSession();

    const discover = await request("server/discover");
    const discovered = discover["result"] as Record<string, unknown>;
    expect(discovered["supportedVersions"]).toContain(MODERN);
    expect(discovered).toMatchObject({ resultType: "complete", ttlMs: 86_400_000, cacheScope: "public" });
    expect(discovered["capabilities"]).toMatchObject({
      tools: { listChanged: false },
      resources: { listChanged: false },
      extensions: { "io.modelcontextprotocol/skills": {} },
    });

    const list = (await request("tools/list"))["result"] as Record<string, unknown>;
    expect(list).toMatchObject({ resultType: "complete", ttlMs: 86_400_000, cacheScope: "public" });
    expect(list["_meta"]).toMatchObject({ "io.modelcontextprotocol/serverInfo": { name: "bc-dev-mcp" } });
    // JSON Schema 2020-12 conversion of the zod input schemas.
    const tools = list["tools"] as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    expect(tools.find((t) => t.name === "bcdev_debug_wait")?.inputSchema["type"]).toBe("object");

    const resources = (await request("resources/list"))["result"] as Record<string, unknown>;
    expect(resources).toMatchObject({ ttlMs: 86_400_000, cacheScope: "public" });
    const skill = (await request("resources/read", { uri: "skill://bc-al-testing/SKILL.md" }))["result"] as Record<string, unknown>;
    expect(skill).toMatchObject({ resultType: "complete", ttlMs: 86_400_000, cacheScope: "public" });

    const skills = (await request("skills/list"))["result"] as Record<string, unknown>;
    expect(skills).toMatchObject({ resultType: "complete", ttlMs: 86_400_000, cacheScope: "public" });
    expect(skills["skills"]).toHaveLength(5);
    const got = (await request("skills/get", { uri: "skill://bc-al-testing/SKILL.md" }))["result"] as Record<string, unknown>;
    expect(got).toMatchObject({ resultType: "complete", ttlMs: 86_400_000, cacheScope: "public" });
    expect(got["skill"]).toMatchObject({ uri: "skill://bc-al-testing/SKILL.md" });
    expect((await request("skills/get", { uri: "skill://nope/SKILL.md" }))["error"]).toMatchObject({ code: -32602 });

    const call = (await request("tools/call", { name: "bcdev_debug_wait", arguments: {} }))["result"] as Record<string, unknown>;
    expect(call["resultType"]).toBe("complete");
    expect(call["isError"]).toBe(true);
    expect(JSON.parse((call["content"] as Array<{ text: string }>)[0]!.text)).toMatchObject({
      error: { code: "NO_DEBUG_SESSION" },
    });

    const unknown = await request("tools/call", { name: "bcdev_nope", arguments: {} });
    expect(unknown["result"]).toBeUndefined();
    expect(unknown["error"]).toMatchObject({ code: -32602 });
  });
});
