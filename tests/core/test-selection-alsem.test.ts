import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAlProcedureIdentities, discoverTestMethodIdentities, type AlProcedureDiscoveryResult, type TestMethodIdentity } from "../../src/core/al-procedures";
import { parseAlSemCallGraphJsonl, type CallGraph } from "../../src/core/call-graph";
import type { CoverageMap } from "../../src/core/coverage-map";
import type { GitChangeSet } from "../../src/core/git-changes";
import { selectTests, type TestSelectionInput } from "../../src/core/test-selection";

// Selection over hand-written al-sem graphs (schema al-sem.callgraph v1) for a small real
// project: discovery reads the AL below, the graph's nodes carry the rows al-sem would emit
// (`line` = the procedure/trigger keyword row, attributes excluded).
const LOGIC = [
  'codeunit 50100 "Logic"', //       1
  "{", //                            2
  "    [NonDebuggable]", //          3  attribute: discovery's startLine
  "    procedure Calc(X: Integer): Integer", // 4  al-sem's line
  "    begin", //                    5
  "        exit(X);", //             6
  "    end;", //                     7
  "", //                             8
  "    procedure Calc(X: Text): Text", // 9  an overload
  "    begin", //                    10
  "        exit(X);", //             11
  "    end;", //                     12
  "", //                             13
  '    procedure "Say ""Hi"""()', // 14  a doubled quote in the name
  "    begin", //                    15
  "    end;", //                     16
  "}", //                            17
].join("\n");
const TABLE = [
  'table 50101 "Tab"', //            1
  "{", //                            2
  "    fields", //                   3
  "    {", //                        4
  '        field(1; "No."; Code[20])', // 5
  "        {", //                    6
  "            trigger OnValidate()", // 7
  "            begin", //            8
  "            end;", //             9
  "        }", //                    10
  "        field(2; Name; Text[30])", // 11
  "        {", //                    12
  "            trigger OnValidate()", // 13
  "            begin", //            14
  "            end;", //             15
  "        }", //                    16
  "    }", //                        17
  "}", //                            18
].join("\n");
const TESTS = [
  'codeunit 50150 "Tests"', //       1
  "{", //                            2
  "    Subtype = Test;", //          3
  "", //                             4
  "    [Test]", //                   5
  "    procedure IntTest()", //      6
  "    begin", //                    7
  "    end;", //                     8
  "", //                             9
  "    [Test]", //                   10
  "    procedure TextTest()", //     11
  "    begin", //                    12
  "    end;", //                     13
  "", //                             14
  "    [Test]", //                   15
  "    procedure NoTest()", //       16
  "    begin", //                    17
  "    end;", //                     18
  "", //                             19
  "    [Test]", //                   20
  "    procedure NameTest()", //     21
  "    begin", //                    22
  "    end;", //                     23
  "}", //                            24
].join("\n");

let project: string;
let discovered: AlProcedureDiscoveryResult;
let tests: TestMethodIdentity[];

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), "bcmcp-alsem-select-"));
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "17.0" }));
  writeFileSync(join(project, "src", "Logic.Codeunit.al"), LOGIC);
  writeFileSync(join(project, "src", "Tab.Table.al"), TABLE);
  writeFileSync(join(project, "src", "Tests.Codeunit.al"), TESTS);
  discovered = await discoverAlProcedureIdentities(project, ["src/Logic.Codeunit.al", "src/Tab.Table.al", "src/Tests.Codeunit.al"]);
  tests = (await discoverTestMethodIdentities(project)).methods;
});

const META = {
  schema: "al-sem.callgraph", version: 1, engine: "test",
  workspace: { appId: "ws", name: "App" },
  apps: [{ appId: "sym", name: "Sym Lib", source: "symbolOnly" }],
  assumptions: ["opaqueCodeRunsNoObjectsById", "platformEntryPointsNotModelled"],
  recoveredFiles: [], coverageHolds: true,
};
type Row = Record<string, unknown>;
const method = (id: string, objectType: string, objectId: number, objectName: string, memberName: string, sourcePath: string, line: number, endLine: number, extra: Row = {}): Row =>
  ({ id, kind: "Method", appId: "ws", objectType, objectId, objectName, memberName, sourcePath, line, endLine, dependency: false, symbolOnly: false, ...extra });
const BASE_NODES: Row[] = [
  method("r:t-int", "Codeunit", 50150, "Tests", "IntTest", "src/Tests.Codeunit.al", 6, 8, { test: true }),
  method("r:t-text", "Codeunit", 50150, "Tests", "TextTest", "src/Tests.Codeunit.al", 11, 13, { test: true }),
  method("r:t-no", "Codeunit", 50150, "Tests", "NoTest", "src/Tests.Codeunit.al", 16, 18, { test: true }),
  method("r:t-name", "Codeunit", 50150, "Tests", "NameTest", "src/Tests.Codeunit.al", 21, 23, { test: true }),
  method("r:calc-int", "Codeunit", 50100, "Logic", "Calc", "src/Logic.Codeunit.al", 4, 7, { arity: 1 }),
  method("r:calc-text", "Codeunit", 50100, "Logic", "Calc", "src/Logic.Codeunit.al", 9, 12, { arity: 1 }),
  method("r:hi", "Codeunit", 50100, "Logic", 'Say ""Hi""', "src/Logic.Codeunit.al", 14, 16),
  { ...method("r:no-validate", "Table", 50101, "Tab", "OnValidate", "src/Tab.Table.al", 7, 9, { member: "No." }), kind: "Trigger" },
  { ...method("r:name-validate", "Table", 50101, "Tab", "OnValidate", "src/Tab.Table.al", 13, 15, { member: "Name" }), kind: "Trigger" },
  { id: "h:name:x/0", kind: "Hub", hub: "name", hubArg: "x/0" },
];
const e = (caller: string, callee: string, kind: string, confidence: string, via = "call"): Row => ({ caller, callee, kind, confidence, via });
const BASE_EDGES: Row[] = [
  e("r:t-int", "r:calc-int", "Direct", "Resolved"),
  e("r:t-int", "r:hi", "Direct", "Resolved"),
  e("r:t-text", "r:calc-text", "Direct", "Resolved"),
  e("r:t-no", "r:no-validate", "Trigger", "Resolved", "implicitTrigger"),
  e("r:t-name", "h:name:x/0", "Direct", "Open", "dynamic"),
  e("h:name:x/0", "r:name-validate", "Direct", "Open", "hubExpansion"),
];

function graphOf(nodes: Row[] = BASE_NODES, edges: Row[] = BASE_EDGES, meta: Row = META): CallGraph {
  return parseAlSemCallGraphJsonl([
    JSON.stringify({ t: "meta", v: meta }),
    ...nodes.map((v) => JSON.stringify({ t: "node", v })),
    ...edges.map((v) => JSON.stringify({ t: "edge", v })),
  ].join("\n"));
}

/** A change set editing `file` at the given 1-based lines. */
const changeAt = (file: string, ...lines: number[]): GitChangeSet => ({
  baseRef: "HEAD", mergeBase: "abc", head: "workingTree",
  files: [{ relativeFile: file, ranges: lines.map((l) => ({ start: l, end: l })) }],
  nonAlFiles: [], unresolvedAlFiles: [],
});

const select = (changes: GitChangeSet, extra: Partial<TestSelectionInput> = {}) =>
  selectTests({ changes, discovered, tests, graph: graphOf(), coverageMap: null, ...extra });
const picked = (result: ReturnType<typeof selectTests>) => result.selection.map((s) => [s.method, s.reason]);

describe("selectTests with an al-sem graph", () => {
  test("joins by location: attributes above the keyword, and overloads told apart", () => {
    const calc = discovered.procedures.find((p) => p.name === "Calc" && p.startLine === 3);
    expect(calc).toBeDefined(); // discovery starts at the attribute, al-sem's node line is 4
    const result = select(changeAt("src/Logic.Codeunit.al", 6));
    expect(picked(result)).toEqual([["IntTest", "direct"]]);
    expect(result.fallbackToAll).toBe(false);
    expect(picked(select(changeAt("src/Logic.Codeunit.al", 11)))).toEqual([["TextTest", "direct"]]);
  });

  test("a changed trigger joins like a procedure and no longer falls back; same-named triggers are told apart", () => {
    const result = select(changeAt("src/Tab.Table.al", 8));
    expect(result.fallbackToAll).toBe(false);
    expect(result.changedProcedures.map((p) => [p.kind, p.name, p.startLine])).toEqual([["trigger", "OnValidate", 7]]);
    expect(picked(result)).toEqual([["NoTest", "event"]]);
  });

  test("a path through a hub is dynamic and ranks below event", () => {
    const result = select(changeAt("src/Tab.Table.al", 8, 14));
    expect(result.selection.map((s) => [s.method, s.reason, s.confidence])).toEqual([
      ["NoTest", "event", 0.5],
      ["NameTest", "dynamic", 0.3],
    ]);
    expect(result.warnings.join("\n")).toContain("relies on al-sem's stated assumptions");
    // A test with both kinds of evidence keeps the stronger one as its reason.
    const both = select(changeAt("src/Tab.Table.al", 8, 14), { graph: graphOf(BASE_NODES, [...BASE_EDGES, e("r:t-no", "h:name:x/0", "Direct", "Open", "dynamic")]) });
    expect(both.selection.find((s) => s.method === "NoTest")).toMatchObject({ reason: "event", reasons: ["event", "dynamic"], confidence: 0.5 });
  });

  test("a quoted name with a doubled quote joins", () => {
    const result = select(changeAt("src/Logic.Codeunit.al", 15));
    expect(result.changedProcedures.map((p) => p.name)).toEqual(['Say "Hi"']);
    expect(picked(result)).toEqual([["IntTest", "direct"]]);
  });

  test("a path differing only in case joins by location on win32; on linux only by name", () => {
    const nodes = BASE_NODES.map((n) => (n["id"] === "r:calc-int" ? { ...n, sourcePath: "SRC/logic.CODEUNIT.al" } : n));
    const win = select(changeAt("src/Logic.Codeunit.al", 6), { graph: graphOf(nodes), platform: "win32" });
    expect(picked(win)).toEqual([["IntTest", "direct"]]);
    expect(win.warnings.join("\n")).not.toContain("joined by name");
    const linux = select(changeAt("src/Logic.Codeunit.al", 6), { graph: graphOf(nodes), platform: "linux" });
    expect(linux.warnings.join("\n")).toContain("joined by name");
  });

  test("a name mismatch at the location falls back to the name join, with a warning", () => {
    const nodes = BASE_NODES.map((n) => (n["id"] === "r:calc-int" ? { ...n, line: 40, endLine: 43 } : n));
    const result = select(changeAt("src/Logic.Codeunit.al", 6), { graph: graphOf(nodes) });
    // Both overloads match the name, so both their tests are selected.
    expect(picked(result).sort()).toEqual([["IntTest", "direct"], ["TextTest", "direct"]]);
    expect(result.warnings.join("\n")).toContain("joined by name");
  });

  test("no node at all keeps the existing fallback", () => {
    const nodes = BASE_NODES.filter((n) => n["objectName"] !== "Logic");
    const result = select(changeAt("src/Logic.Codeunit.al", 6), { graph: graphOf(nodes, BASE_EDGES.filter((x) => x["callee"] !== "r:calc-int" && x["callee"] !== "r:hi")) });
    expect(result.fallbackToAll).toBe(true);
    expect(result.fallbackReasons[0]).toContain("is not in the call graph");
  });

  test("hidden callers in the reverse cone: history covers the change, else the whole suite", () => {
    const nodes = BASE_NODES.map((n) => (n["id"] === "r:no-validate" ? { ...n, hiddenCallers: ["unmodeledRecordTrigger"] } : n));
    const withoutHistory = select(changeAt("src/Tab.Table.al", 8), { graph: graphOf(nodes) });
    expect(withoutHistory.fallbackToAll).toBe(true);
    expect(withoutHistory.fallbackReasons[0]).toContain("Tab.OnValidate (unmodeledRecordTrigger)");
    expect(withoutHistory.uncoverable).toEqual([]);

    // History is keyed by methodId; a procedure has one, so history can cover it.
    const calc = discovered.procedures.find((p) => p.name === "Calc" && p.startLine === 3)!;
    const intTest = tests.find((t) => t.method === "IntTest")!;
    const hiddenCalc = BASE_NODES.map((n) => (n["id"] === "r:calc-int" ? { ...n, hiddenCallers: ["unboundSubscriber"] } : n));
    const map: CoverageMap = {
      format: "bc-dev-mcp.coverage-map", version: 1, baseRef: "HEAD", mergeBase: "abc", complete: true,
      tests: [{ codeunitId: 50150, method: "IntTest", methodId: intTest.methodId!, procedures: [{ objectType: calc.objectType, objectId: calc.objectId, methodId: calc.methodId! }] }],
    } as CoverageMap;
    const withHistory = select(changeAt("src/Logic.Codeunit.al", 6), { graph: graphOf(hiddenCalc), coverageMap: map });
    expect(withHistory.fallbackToAll).toBe(false);
    expect(withHistory.warnings.join("\n")).toContain("coverage history covers it");
    expect(withHistory.selection[0]!.reasons).toEqual(["direct", "coverage-history"]);
  });

  test("a changed file al-sem recovered from a parse error falls back", () => {
    const result = select(changeAt("src/Logic.Codeunit.al", 6), {
      graph: graphOf(BASE_NODES, BASE_EDGES, { ...META, recoveredFiles: ["App::src/Logic.Codeunit.al"] }),
    });
    expect(result.fallbackToAll).toBe(true);
    expect(result.fallbackReasons.join("\n")).toContain("did not parse cleanly");
  });

  test("a graph with no [Test] node (a separate test app) falls back with that reason", () => {
    const nodes = BASE_NODES.map(({ test: _test, ...n }) => n);
    const result = select(changeAt("src/Logic.Codeunit.al", 6), { graph: graphOf(nodes) });
    expect(result.fallbackToAll).toBe(true);
    expect(result.fallbackReasons.join("\n")).toContain("separate test app");
  });

  test("uncoverable under al-sem is reported with the assumptions it rests on", () => {
    const edges = BASE_EDGES.filter((x) => x["callee"] !== "r:hi");
    const result = select(changeAt("src/Logic.Codeunit.al", 15), { graph: graphOf(BASE_NODES, edges) });
    expect(result.uncoverable.map((p) => p.name)).toEqual(['Say "Hi"']);
    expect(result.fallbackToAll).toBe(false);
    expect(result.warnings.join("\n")).toContain("symbol-only (no source) code is assumed not to run objects");
  });

  test("a symbol-only app's callbacks hub on the path is named in the warnings", () => {
    const nodes = [...BASE_NODES, { id: "h:callbacks:sym", kind: "Hub", hub: "callbacks", hubArg: "sym" }];
    const edges = [...BASE_EDGES, e("r:t-text", "h:callbacks:sym", "Event", "Open", "opaqueBody"), e("h:callbacks:sym", "r:hi", "Event", "Open", "hubExpansion")];
    const result = select(changeAt("src/Logic.Codeunit.al", 15), { graph: graphOf(nodes, edges) });
    expect(picked(result)).toEqual([["IntTest", "direct"], ["TextTest", "dynamic"]]);
    expect(result.warnings.join("\n")).toContain("Symbol-only apps without source limited the precision");
    expect(result.warnings.join("\n")).toContain("Sym Lib");
  });
});
