import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../src/mcp/server";
import { createAuthorizationProviderFactory } from "../../src/core/authorization";
import { ServerState } from "../../src/mcp/state";
import { FakeHub, fakeHubFactory } from "../fakes/fake-hub";
import { FakeNativeMcpGateway } from "../fakes/fake-native-mcp";

async function connect() {
  const dir = mkdtempSync(join(tmpdir(), "bcmcp-progress-"));
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(join(dir, ".vscode", "launch.json"), JSON.stringify({ configurations: [{ type: "al", request: "launch", server: "http://localhost", serverInstance: "BC" }] }));
  writeFileSync(join(dir, "T.Codeunit.al"), 'codeunit 50100 "T"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure A()\n    begin\n    end;\n}\n');
  const hub = new FakeHub();
  hub.onInvoke = (method) => {
    if (method === "RunTests") {
      queueMicrotask(() => {
        hub.emit("TestCompleted", 50100, "A", 0, "", 5);
        hub.emit("TestCompleted", 50100, "B", 1, "boom", 5);
        hub.emit("TestRunCompleted", { Tests: [] });
      });
    }
    return undefined;
  };
  const server = buildServer(new ServerState(), {
    hubFactory: fakeHubFactory(hub),
    authorizationFactory: createAuthorizationProviderFactory(),
    http10Get: async () => { throw new Error("unused"); },
    fetchFn: (async () => new Response(JSON.stringify({ WebApiVersion: "7.0" }))) as unknown as typeof fetch,
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" },
    cwd: dir,
    gitChanges: async () => { throw new Error("unused"); },
    callGraph: async () => ({ nodes: [], edges: [] }),
    nativeMcpGateway: new FakeNativeMcpGateway(),
  });
  const client = new Client({ name: "t", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

type P = { progress: number; total?: number; message?: string };
const call = async (client: Client, name: string, args: Record<string, unknown>, withToken: boolean) => {
  const seen: P[] = [];
  await client.callTool({ name, arguments: args }, withToken ? { onprogress: (p: P) => seen.push(p) } : undefined);
  return seen;
};

describe("progress notifications", () => {
  test("bcdev_test_run reports per TestCompleted only with a progressToken", async () => {
    const client = await connect();
    const args = { codeunits: [{ id: 50100, methods: ["A", "B"] }] };
    const seen = await call(client, "bcdev_test_run", args, true);
    expect(seen.map((p) => p.progress)).toEqual([1, 2]);
    expect(seen[0]).toMatchObject({ total: 2, message: "50100.A passed" });
    expect(seen[1]!.message).toBe("50100.B failed");
    expect(await call(client, "bcdev_test_run", args, false)).toEqual([]);
  });

  test("bcdev_test_orchestrate repeat reports per run", async () => {
    const client = await connect();
    const args = { codeunits: [{ id: 50100 }], runs: 2 };
    const seen = await call(client, "bcdev_test_orchestrate", args, true);
    expect(seen.map((p) => [p.progress, p.total])).toEqual([[1, 2], [2, 2]]);
    expect(await call(client, "bcdev_test_orchestrate", args, false)).toEqual([]);
  });

  test("bcdev_debug_wait heartbeats every ~10s only with a progressToken", async () => {
    const client = await connect();
    await client.callTool({ name: "bcdev_debug_attach", arguments: { breakpoints: [] } });
    const seen = await call(client, "bcdev_debug_wait", { timeoutMs: 10500 }, true);
    expect(seen).toEqual([{ progress: 1, message: "waiting for break" }]);
    expect(await call(client, "bcdev_debug_wait", { timeoutMs: 10500 }, false)).toEqual([]);
  }, 30000);
});
