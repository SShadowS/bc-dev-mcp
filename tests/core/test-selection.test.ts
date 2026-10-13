import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverAlProcedureIdentities, discoverTestMethodIdentities, type AlProcedureDiscoveryResult, type TestMethodIdentity } from "../../src/core/al-procedures";
import { parseCallGraphJsonl, type CallGraph } from "../../src/core/call-graph";
import { parseCoverageMap, type CoverageMap } from "../../src/core/coverage-map";
import type { GitChangeSet } from "../../src/core/git-changes";
import { selectTests, type TestSelectionInput } from "../../src/core/test-selection";

// Real inputs: fixture source, the recorded live coverage map and the altool graph
// (`altool graph stitch`, AL 30.0.2863738, sourcePath stripped) of tests/fixtures/test-selection.
const fixture = resolve("tests/fixtures/test-selection");
let discovered: AlProcedureDiscoveryResult;
let tests: TestMethodIdentity[];
let graph: CallGraph;
let coverageMap: CoverageMap;

beforeAll(async () => {
  discovered = await discoverAlProcedureIdentities(fixture, readdirSync(join(fixture, "src")).map((f) => `src/${f}`));
  tests = (await discoverTestMethodIdentities(fixture)).methods;
  graph = parseCallGraphJsonl(readFileSync(join(fixture, "call-graph.jsonl"), "utf8"));
  coverageMap = parseCoverageMap(readFileSync(join(fixture, "coverage-map.json"), "utf8"));
});

/** A change set editing the first body line of each named procedure ("Object.Procedure"). */
function changeOf(...procedures: string[]): GitChangeSet {
  const files = new Map<string, number[]>();
  for (const target of procedures) {
    const p = discovered.procedures.find((c) => `${c.objectName}.${c.name}` === target);
    if (!p) throw new Error(`no procedure ${target}`);
    files.set(p.relativeFile, [...(files.get(p.relativeFile) ?? []), p.startLine + 1]);
  }
  return {
    baseRef: "HEAD", mergeBase: "abc", head: "workingTree",
    files: [...files].map(([relativeFile, lines]) => ({ relativeFile, ranges: lines.map((l) => ({ start: l, end: l })) })),
    nonAlFiles: [], unresolvedAlFiles: [],
  };
}

const select = (changes: GitChangeSet, extra: Partial<TestSelectionInput> = {}) =>
  selectTests({ changes, discovered, tests, graph, coverageMap, ...extra });
const names = (result: ReturnType<typeof selectTests>) => result.selection.map((s) => s.method).sort();
/** Tests a planted bug in the procedure would fail: those the recorded run saw reaching it. */
const failing = (target: string) => {
  const p = discovered.procedures.find((c) => `${c.objectName}.${c.name}` === target)!;
  return coverageMap.tests
    .filter((t) => t.procedures.some((q) => q.objectId === p.objectId && q.methodId === p.methodId))
    .map((t) => t.method!).sort();
};

describe("selectTests on the test-selection fixture", () => {
  const diffs = [
    "Sel Surcharge Subscriber.AddSurchargeOnFinalize",
    "Sel Express Rate.Rate",
    "Sel Pricing.ApplyDiscount",
    "Sel Pricing.CalcLineAmount",
    "Sel Pricing.LegacyTaxAmount",
  ];

  test("five scripted diffs: 100% recall, at most 50% of the suite on average", () => {
    let selected = 0;
    for (const target of diffs) {
      const result = select(changeOf(target));
      for (const method of failing(target)) expect(names(result)).toContain(method);
      expect(result.fallbackToAll).toBe(false);
      selected += result.selection.length;
    }
    expect(selected / diffs.length / tests.length).toBeLessThanOrEqual(0.5);
  });

  test("event-only subscriber change selects the finalize tests as event + history", () => {
    const result = select(changeOf("Sel Surcharge Subscriber.AddSurchargeOnFinalize"));
    expect(names(result)).toEqual(["FinalizeAfterDiscount", "FinalizeLargeAmountNoSurcharge", "FinalizeSmallAmountAddsSurcharge"]);
    for (const s of result.selection) {
      expect(s.reason).toBe("coverage-history");
      expect(s.reasons).toEqual(["coverage-history", "event"]);
      expect(s.confidence).toBe(0.95);
      expect(s.reaches).toEqual(["Sel Surcharge Subscriber.AddSurchargeOnFinalize"]);
    }
  });

  test("interface fan-out is over-approximated statically and ranked below confirmed tests", () => {
    const result = select(changeOf("Sel Express Rate.Rate"));
    expect(result.selection.map((s) => [s.method, s.confidence])).toEqual([
      ["ShippingCostExpressDispatch", 0.95],
      ["ShippingCostExpressZeroWeight", 0.95],
      ["ShippingCostStandardDispatch", 0.5],
    ]);
  });

  test("without a coverage map the graph alone still reaches the event subscriber", () => {
    const result = select(changeOf("Sel Surcharge Subscriber.AddSurchargeOnFinalize"), { coverageMap: null });
    expect(result.selection.every((s) => s.reason === "event" && s.confidence === 0.5)).toBe(true);
    expect(result.selection).toHaveLength(3);
    expect(result.warnings.join(" ")).toContain("No coverage map");
  });

  test("untested changed procedure is uncoverable", () => {
    const result = select(changeOf("Sel Pricing.LegacyTaxAmount", "Sel Pricing.CalcLineAmount"));
    expect(result.uncoverable.map((p) => p.name)).toEqual(["LegacyTaxAmount"]);
    expect(result.changedProcedures.map((p) => p.name)).toEqual(["CalcLineAmount", "LegacyTaxAmount"]);
  });

  test("changed test method absent from the map is a new-test; present one is direct", () => {
    const fresh = select(changeOf("Sel Shipping Tests.StandardRateDirect"), {
      coverageMap: { ...coverageMap, tests: coverageMap.tests.filter((t) => t.method !== "StandardRateDirect") },
    });
    expect(fresh.selection).toEqual([{ codeunitId: 50987, method: "StandardRateDirect", reason: "new-test", reasons: ["new-test"], confidence: 1, reaches: ["Sel Shipping Tests.StandardRateDirect"] }]);
    expect(select(changeOf("Sel Shipping Tests.StandardRateDirect")).selection[0]!.reason).toBe("direct");
  });

  test("output is identical across runs", () => {
    const change = changeOf("Sel Pricing.RoundAmount", "Sel Express Rate.Rate");
    expect(JSON.stringify(select(change))).toBe(JSON.stringify(select(change)));
  });

  test("app.json alone sets fallbackToAll and plans every test", () => {
    const result = select({ ...changeOf(), nonAlFiles: ["app.json"] });
    expect(result.fallbackToAll).toBe(true);
    expect(result.fallbackReasons).toEqual(["Non-AL files changed: app.json"]);
    expect(result.shards.flatMap((s) => s.codeunits.flatMap((c) => c.methods))).toHaveLength(12);
  });

  test("changed procedure missing from the graph falls back", () => {
    const result = select(changeOf("Sel Pricing.CalcLineAmount"), { graph: { nodes: [], edges: [] } });
    expect(result.fallbackToAll).toBe(true);
    expect(result.fallbackReasons[0]).toContain("Sel Pricing.CalcLineAmount");
  });

  test("shards hold at most N codeunits in rank order", () => {
    const result = select(changeOf("Sel Pricing.RoundAmount"), { maxCodeunitsPerShard: 2 });
    expect(result.selection).toHaveLength(11); // StandardRateDirect never rounds
    expect(result.shards.map((s) => s.codeunits.length)).toEqual([2, 1]);
    const planned = result.shards.flatMap((s) => s.codeunits.flatMap((c) => c.methods.map((m) => `${c.id}.${m}`)));
    expect(planned.sort()).toEqual(result.selection.map((s) => `${s.codeunitId}.${s.method}`).sort());
    expect(select(changeOf("Sel Pricing.RoundAmount")).shards).toHaveLength(1);
  });
});
