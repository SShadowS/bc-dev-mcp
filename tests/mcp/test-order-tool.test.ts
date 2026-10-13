import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorizationProviderFactory } from "../../src/core/authorization";
import type { GitChangeSet } from "../../src/core/git-changes";
import { buildServer } from "../../src/mcp/server";
import { ServerState } from "../../src/mcp/state";
import type { ToolDeps } from "../../src/mcp/tools";
import { FakeHub } from "../fakes/fake-hub";
import { FakeNativeMcpGateway } from "../fakes/fake-native-mcp";
import { orderPollutionHub, POLLUTION_CODEUNIT as CU } from "../fakes/order-pollution-hub";

const project = mkdtempSync(join(tmpdir(), "bcmcp-order-mode-"));
mkdirSync(join(project, ".vscode"));
writeFileSync(
  join(project, ".vscode", "launch.json"),
  JSON.stringify({ configurations: [{ type: "al", request: "launch", server: "http://localhost", serverInstance: "BC" }] }),
);
copyFileSync(join(import.meta.dir, "../../demos/order-pollution/src/OrderPollutionTests.Codeunit.al"), join(project, "Tests.Codeunit.al"));
writeFileSync(join(project, "Runner.Codeunit.al"), 'codeunit 50169 "Runner"\n{\n    Subtype = TestRunner;\n    TestIsolation = Codeunit;\n}\n');

async function connect() {
  const state = new ServerState();
  const deps: ToolDeps = {
    // Fresh demo hub per Initialize; the debugger hub cannot connect.
    hubFactory: (url) => {
      if (url.includes("TestRunnerHub")) return orderPollutionHub();
      const hub = new FakeHub();
      hub.start = () => Promise.reject(new Error("debugger unavailable"));
      return hub;
    },
    authorizationFactory: createAuthorizationProviderFactory(),
    http10Get: async () => { throw new Error("not expected"); },
    fetchFn: (async () => new Response(JSON.stringify({ WebApiVersion: "7.0" }))) as unknown as typeof fetch,
    env: { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" },
    cwd: project,
    gitChanges: async (_p, baseRef): Promise<GitChangeSet> => ({
      baseRef, mergeBase: "a".repeat(40), head: "workingTree", nonAlFiles: [], unresolvedAlFiles: [], files: [],
    }),
    nativeMcpGateway: new FakeNativeMcpGateway(),
    callGraph: async () => ({ nodes: [], edges: [] }),
  };
  const client = new Client({ name: "order-mode", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([buildServer(state, deps).connect(s), client.connect(c)]);
  return { client, state };
}

type OrderResult = {
  mode: string;
  complete: boolean;
  warnings: string[];
  order: {
    tests: { method: string; classification: string; transactionModel: string }[];
    runners: { codeunitId: number; setsTestIsolation: boolean }[];
    summary: { odVictim: number };
    bisection: { victims: { method: string; outcome: string; polluter?: { method: string } }[] };
    writeAttribution: unknown;
  };
};

describe("bcdev_test_orchestrate mode 'order'", () => {
  test("names victims and polluters with TransactionModel and runner TestIsolation; output matches the schema", async () => {
    const { client, state } = await connect();
    const res = await client.callTool({
      name: "bcdev_test_orchestrate",
      arguments: { codeunits: [{ id: CU }], mode: "order", seeds: [1, 2, 3], pollutionTableId: 18 },
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as OrderResult;
    expect(out.mode).toBe("order");
    expect(out.order.bisection.victims.map((v) => [v.method, v.outcome, v.polluter?.method])).toEqual([
      ["VictimInsertsSameCustomer", "found", "PolluterCommitsCustomer"],
      ["VictimExpectsNoFlag", "found", "PolluterCommitsFlag"],
    ]);
    expect(out.order.tests.find((t) => t.method === "PolluterCommitsCustomer")?.transactionModel).toBe("AutoCommit");
    expect(out.order.tests.find((t) => t.method === "IndependentArithmetic")?.transactionModel).toBe("AutoRollback");
    expect(out.order.runners).toEqual([expect.objectContaining({ codeunitId: 50169, setsTestIsolation: true })]);
    // Debugger unavailable: bisection evidence survives, the capture failure is reported, slots are released.
    expect(out.order.writeAttribution).toBeNull();
    expect(out.complete).toBe(false);
    expect(out.warnings.some((w) => w.includes("Record-write capture failed"))).toBe(true);
    expect(state.testRunActive).toBe(false);
    expect(state.debugOwner).toBeNull();
  });

  test("clean selection: zero od-victims across 3 seeds", async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: "bcdev_test_orchestrate",
      arguments: {
        codeunits: [{ id: CU, methods: ["IndependentArithmetic", "IndependentCompanyName", "IndependentRolledBackWrite", "IndependentLast"] }],
        mode: "order",
      },
    });
    const out = res.structuredContent as OrderResult;
    expect(out.order.summary.odVictim).toBe(0);
  });

  test("mode-specific arguments are rejected with a structured INVALID_ARGUMENT", async () => {
    const { client } = await connect();
    for (const args of [{ mode: "order", runs: 3 }, { seeds: [1] }, { mode: "order", changesDeployed: true }]) {
      const res = await client.callTool({ name: "bcdev_test_orchestrate", arguments: { codeunits: [{ id: CU }], ...args } });
      expect(res.isError).toBe(true);
      const text = (res.content as { text: string }[])[0]!.text;
      expect(JSON.parse(text).error.code).toBe("INVALID_ARGUMENT");
    }
  });
});
