import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BcDevError } from "../../src/core/agent-errors";
import {
  ALTOOL_ENV_VAR,
  createAltoolCallGraphProvider,
  parseCallGraphJsonl,
  reverseReachable,
} from "../../src/core/call-graph";

// Ids and line shapes copied from `altool graph stitch` output (AL 30.0.2863738) on
// tests/fixtures/test-selection; sourcePath dropped.
const APP = "al . 6f0f3c1e-2b7a-4d8e-9c55-0a1d3e5b7c25";
const TEST = `${APP} / Codeunit 50986 Sel Event Tests # FinalizeSmallAmountAddsSurcharge#-76582023`;
const FINALIZE = `${APP} / Codeunit 50980 Sel Pricing # FinalizeAmount#1164337924`;
const PUBLISHER = `${APP} / Codeunit 50980 Sel Pricing # OnAfterFinalizeAmount#1719684158`;
const SUBSCRIBER = `${APP} / Codeunit 50981 Sel Surcharge Subscriber # AddSurchargeOnFinalize#1835424189`;
const ROUND = `${APP} / Codeunit 50980 Sel Pricing # RoundAmount#-1889037101`;

const node = (id: string, memberName: string, objectId: number) =>
  JSON.stringify({ t: "node", v: { id, kind: "Method", objectName: "x", objectId, memberName, line: 3, isTest: false } });
const edge = (caller: string, callee: string, kind: string, confidence = "Resolved") =>
  JSON.stringify({ t: "edge", v: { caller, callee, kind, confidence } });

const JSONL = [
  node(TEST, "FinalizeSmallAmountAddsSurcharge", 50986),
  node(FINALIZE, "FinalizeAmount", 50980),
  node(PUBLISHER, "OnAfterFinalizeAmount", 50980),
  node(SUBSCRIBER, "AddSurchargeOnFinalize", 50981),
  node(ROUND, "RoundAmount", 50980),
  edge(TEST, TEST, "Direct"),
  edge(TEST, FINALIZE, "Direct"),
  edge(FINALIZE, PUBLISHER, "Direct"),
  edge(FINALIZE, ROUND, "Direct"),
  edge(PUBLISHER, SUBSCRIBER, "Event", "OverApprox"),
  "",
].join("\r\n");

describe("call graph", () => {
  test("parses altool stitch JSONL", () => {
    const graph = parseCallGraphJsonl(JSONL);
    expect(graph.nodes).toHaveLength(5);
    expect(graph.nodes[1]).toEqual({
      id: FINALIZE, kind: "Method", objectType: "Codeunit", objectId: 50980, objectName: "x", memberName: "FinalizeAmount", line: 3,
    });
    expect(graph.edges.at(-1)).toEqual({ caller: PUBLISHER, callee: SUBSCRIBER, kind: "Event", confidence: "OverApprox" });
  });

  test("rejects unknown edge kinds and non-JSON lines", () => {
    expect(() => parseCallGraphJsonl(edge("a", "b", "Teleport"))).toThrow(/unknown edge kind/);
    expect(() => parseCallGraphJsonl("{oops")).toThrow(/not JSON/);
  });

  test("reverse lookup reaches the test through an event edge as indirect", () => {
    const graph = parseCallGraphJsonl(JSONL);
    const viaSubscriber = reverseReachable(graph, [SUBSCRIBER]);
    expect(viaSubscriber.get(TEST)).toBe("indirect");
    expect(viaSubscriber.get(SUBSCRIBER)).toBe("direct");
    expect(viaSubscriber.has(ROUND)).toBe(false);
    expect(reverseReachable(graph, [ROUND]).get(TEST)).toBe("direct");
  });

  test("provider runs extract then stitch and parses the stitched file", async () => {
    const calls: string[][] = [];
    const provider = createAltoolCallGraphProvider({ [ALTOOL_ENV_VAR]: "C:\\al\\altool.exe" }, async (binary, args) => {
      calls.push([binary, ...args]);
      if (args[1] === "stitch") {
        const out = args[args.indexOf("--out") + 1]!;
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSONL);
      }
    });
    const graph = await provider("proj");
    expect(graph.edges).toHaveLength(5);
    expect(calls.map((c) => [c[0], c[2]])).toEqual([["C:\\al\\altool.exe", "extract"], ["C:\\al\\altool.exe", "stitch"]]);
  });

  test("missing binary reports an actionable configuration error", async () => {
    const provider = createAltoolCallGraphProvider({}, async () => {
      throw Object.assign(new Error("spawn altool ENOENT"), { code: "ENOENT" });
    });
    const error = await provider("proj").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BcDevError);
    expect((error as BcDevError).code).toBe("CONFIGURATION_ERROR");
    expect((error as BcDevError).message).toContain(ALTOOL_ENV_VAR);
    expect((error as BcDevError).details).toEqual({ binary: "altool", envVar: ALTOOL_ENV_VAR });
  });

  test("extract failure surfaces tool output", async () => {
    const provider = createAltoolCallGraphProvider({}, async () => {
      throw Object.assign(new Error("exit 1"), { code: 1, stderr: "AL0185 missing symbol" });
    });
    await expect(provider("proj")).rejects.toThrow(/extract failed: AL0185 missing symbol/);
  });
});
