import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BcDevError } from "../../src/core/agent-errors";
import {
  ALSEM_ENV_VAR,
  ALTOOL_ENV_VAR,
  ENGINE_ENV_VAR,
  createAltoolCallGraphProvider,
  createCallGraphProvider,
  parseAlSemCallGraphJsonl,
  parseCallGraphJsonl,
  reverseReachable,
  type CommandRunner,
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

// al-sem `alsem graph` v1 lines (shape of al-sem's tests/cli-query-goldens/graph.test-selection-graph.jsonl).
const META = JSON.stringify({
  t: "meta",
  v: {
    schema: "al-sem.callgraph", version: 1, engine: "1.4.0", semantics: "may-execute",
    workspace: { appId: "6f0c", name: "App", publisher: "P", version: "1.0.0.0", runtime: "17.0" },
    apps: [{ appId: "abcd", name: "Sym Lib", source: "symbolOnly" }],
    assumptions: ["opaqueCodeRunsNoObjectsById"], recoveredFiles: ["App::src/Broken.al"], coverageHolds: true,
    futureField: { anything: 1 },
  },
});
const alNode = (v: Record<string, unknown>) => JSON.stringify({ t: "node", v: { kind: "Method", objectType: "Codeunit", objectId: 1, objectName: "Cu", dependency: false, ...v } });
const alEdge = (caller: string, callee: string, kind: string, confidence: string, via = "call") =>
  JSON.stringify({ t: "edge", v: { caller, callee, kind, confidence, via } });

const AL_JSONL = [
  META,
  alNode({ id: "r:test", memberName: "TestIt", test: true, sourcePath: "src/T.al", line: 5, endLine: 9, arity: 0 }),
  alNode({ id: "r:a", memberName: "A", sourcePath: "src/A.al", line: 3, endLine: 8, member: "No.", hiddenCallers: ["unraisedPublisher"] }),
  alNode({ id: "r:b", memberName: "B" }),
  alNode({ id: "r:c", memberName: "C" }),
  alNode({ id: "r:d", memberName: "D" }),
  alNode({ id: "r:e", memberName: "E" }),
  alNode({ id: "r:odd", memberName: "Odd", hiddenCallers: "not-a-list" }),
  JSON.stringify({ t: "node", v: { id: "h:name:x/0", kind: "Hub", hub: "name", hubArg: "x/0" } }),
  JSON.stringify({ t: "node", v: { id: "h:any", kind: "Hub", hub: "any", universal: true } }),
  JSON.stringify({ t: "futureLine", v: { anything: true } }),
  alEdge("r:test", "r:a", "Direct", "Resolved"),
  alEdge("r:test", "r:b", "Run", "Resolved", "run"),
  alEdge("r:test", "h:name:x/0", "Direct", "Open", "dynamic"),
  alEdge("h:name:x/0", "r:c", "Direct", "Open", "hubExpansion"),
  alEdge("r:test", "r:d", "Teleport", "Certain"),
  "",
].join("\n");

/** A runner that writes `text` to the --out path of an `alsem graph` call, or throws `error`. */
function alsemRunner(text: string, calls: string[][], error?: unknown, altoolText = JSONL): CommandRunner {
  return async (binary, args) => {
    calls.push([binary, ...args]);
    if (args[0] === "graph" && args[1] !== "extract" && args[1] !== "stitch") {
      if (error) throw error;
      const out = args[args.indexOf("--out") + 1]!;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, text);
      return;
    }
    if (args[1] === "stitch") {
      const out = args[args.indexOf("--out") + 1]!;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, altoolText);
    }
  };
}

describe("call graph", () => {
  test("parses altool stitch JSONL", () => {
    const graph = parseCallGraphJsonl(JSONL);
    expect(graph.engine).toBe("altool");
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
    expect((error as BcDevError).details).toEqual({ binary: "altool", envVar: ALTOOL_ENV_VAR, notFound: true });
  });

  test("extract failure surfaces tool output", async () => {
    const provider = createAltoolCallGraphProvider({}, async () => {
      throw Object.assign(new Error("exit 1"), { code: 1, stderr: "AL0185 missing symbol" });
    });
    await expect(provider("proj")).rejects.toThrow(/extract failed: AL0185 missing symbol/);
  });
});

describe("al-sem call graph (schema al-sem.callgraph v1)", () => {
  test("parses meta first, the v1 node and edge fields, and ignores unknown fields and line types", () => {
    const graph = parseAlSemCallGraphJsonl(AL_JSONL);
    expect(graph.engine).toBe("al-sem");
    expect(graph.meta).toEqual({
      schema: "al-sem.callgraph", version: 1, engine: "1.4.0",
      workspace: { appId: "6f0c", name: "App" },
      apps: [{ appId: "abcd", name: "Sym Lib", source: "symbolOnly" }],
      assumptions: ["opaqueCodeRunsNoObjectsById"], recoveredFiles: ["App::src/Broken.al"], coverageHolds: true,
    });
    expect(graph.nodes.find((n) => n.id === "r:a")).toEqual({
      id: "r:a", kind: "Method", objectType: "Codeunit", objectId: 1, objectName: "Cu", memberName: "A",
      sourcePath: "src/A.al", line: 3, endLine: 8, member: "No.", dependency: false, hiddenCallers: ["unraisedPublisher"],
    });
    expect(graph.nodes.find((n) => n.id === "h:any")).toMatchObject({ kind: "Hub", hub: "any", universal: true });
    expect(graph.nodes).toHaveLength(9);
    expect(graph.edges.find((e) => e.callee === "h:name:x/0")).toEqual({
      caller: "r:test", callee: "h:name:x/0", kind: "Direct", confidence: "Open", via: "dynamic",
    });
  });

  test("unknown values read fail-safe: confidence -> Open, an unknown kind is kept, unreadable hiddenCallers still hide", () => {
    const graph = parseAlSemCallGraphJsonl(AL_JSONL);
    const teleport = graph.edges.find((e) => e.callee === "r:d")!;
    expect(teleport).toMatchObject({ kind: "Teleport", confidence: "Open" });
    expect(graph.nodes.find((n) => n.id === "r:odd")!.hiddenCallers).toEqual(["unknown"]);
  });

  test("rejects output without a meta line, with another schema, or with an unknown major version", () => {
    expect(() => parseAlSemCallGraphJsonl(alNode({ id: "r:x" }))).toThrow(/first line is not a meta line/);
    expect(() => parseAlSemCallGraphJsonl(META.replace("al-sem.callgraph", "other"))).toThrow(/schema 'other'/);
    expect(() => parseAlSemCallGraphJsonl(META.replace('"version":1', '"version":2'))).toThrow(/version 2 is not supported/);
  });

  test("the walk has three classes; the universal hub is a caller of every node", () => {
    const graph = parseAlSemCallGraphJsonl(AL_JSONL);
    expect(reverseReachable(graph, ["r:a"]).get("r:test")).toBe("direct");
    expect(reverseReachable(graph, ["r:b"]).get("r:test")).toBe("indirect");
    expect(reverseReachable(graph, ["r:d"]).get("r:test")).toBe("dynamic"); // unknown confidence = Open
    expect(reverseReachable(graph, ["r:c"]).get("r:test")).toBe("dynamic"); // through a hub
    // r:e has no caller edge at all; the universal hub still calls it, and nothing calls the hub here.
    const viaUniversal = reverseReachable(graph, ["r:e"]);
    expect(viaUniversal.get("h:any")).toBe("dynamic");
    expect(viaUniversal.has("r:test")).toBe(false);
    const withCaller = parseAlSemCallGraphJsonl(`${AL_JSONL}${alEdge("r:test", "h:any", "Direct", "Open", "unresolved")}\n`);
    expect(reverseReachable(withCaller, ["r:e"]).get("r:test")).toBe("dynamic");
  });
});

describe("call-graph engine choice", () => {
  test("auto prefers al-sem and passes the project and --out", async () => {
    const calls: string[][] = [];
    const graph = await createCallGraphProvider({ [ALSEM_ENV_VAR]: "C:\\t\\alsem.exe" }, alsemRunner(AL_JSONL, calls))("proj");
    expect(graph.engine).toBe("al-sem");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("C:\\t\\alsem.exe");
    expect(calls[0]![1]).toBe("graph");
    expect(calls[0]![3]).toBe("--out");
    expect(graph.warnings).toBeUndefined();
  });

  test("auto uses altool silently when alsem is not installed", async () => {
    const calls: string[][] = [];
    const notFound = Object.assign(new Error("spawn alsem ENOENT"), { code: "ENOENT" });
    const graph = await createCallGraphProvider({}, alsemRunner(AL_JSONL, calls, notFound))("proj");
    expect(graph.engine).toBe("altool");
    expect(graph.warnings).toBeUndefined();
    expect(calls.map((c) => c[0])).toEqual(["alsem", "altool", "altool"]);
  });

  test("auto uses altool with a warning when al-sem fails or writes output this reader rejects", async () => {
    const failed = Object.assign(new Error("exit 1"), { code: 1, stderr: "snapshot build failed" });
    const viaFailure = await createCallGraphProvider({}, alsemRunner(AL_JSONL, [], failed))("proj");
    expect(viaFailure.engine).toBe("altool");
    expect(viaFailure.warnings![0]).toContain("snapshot build failed");
    const viaVersion = await createCallGraphProvider({}, alsemRunner(META.replace('"version":1', '"version":9'), []))("proj");
    expect(viaVersion.engine).toBe("altool");
    expect(viaVersion.warnings![0]).toContain("version 9 is not supported");
  });

  test("an explicit engine surfaces its own errors; an unknown engine value is a configuration error", async () => {
    const notFound = Object.assign(new Error("spawn alsem ENOENT"), { code: "ENOENT" });
    const alsemOnly = await createCallGraphProvider({ [ENGINE_ENV_VAR]: "al-sem" }, alsemRunner(AL_JSONL, [], notFound))("proj").catch((e: unknown) => e);
    expect((alsemOnly as BcDevError).code).toBe("CONFIGURATION_ERROR");
    expect((alsemOnly as BcDevError).message).toContain(ALSEM_ENV_VAR);
    const calls: string[][] = [];
    const altoolOnly = await createCallGraphProvider({ [ENGINE_ENV_VAR]: "ALTOOL" }, alsemRunner(AL_JSONL, calls))("proj");
    expect(altoolOnly.engine).toBe("altool");
    expect(calls.every((c) => c[0] === "altool")).toBe(true);
    const bad = await createCallGraphProvider({ [ENGINE_ENV_VAR]: "magic" }, alsemRunner(AL_JSONL, []))("proj").catch((e: unknown) => e);
    expect((bad as BcDevError).details).toEqual({ envVar: ENGINE_ENV_VAR, value: "magic" });
  });
});
