import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverAlProcedureIdentities, discoverTestMethodIdentities, type AlProcedureDiscoveryResult, type TestMethodIdentity } from "../../src/core/al-procedures";
import { parseAlSemCallGraphJsonl, parseCallGraphJsonl, type CallGraph } from "../../src/core/call-graph";
import { parseCoverageMap, type CoverageMap } from "../../src/core/coverage-map";
import type { GitChangeSet } from "../../src/core/git-changes";
import { selectTests } from "../../src/core/test-selection";

// Offline replay of the live acceptance run (issue #26, README in the fixture): the recorded
// Cronus28 coverage map + altool graph of the 40-codeunit fixture, and the tests that actually
// failed on Cronus28 when each planted bug was published.
const fixture = resolve("tests/fixtures/test-selection-acceptance");
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

/** A change set editing the given 1-based lines ("file:line"). */
function changeAt(...at: string[]): GitChangeSet {
  const files = new Map<string, number[]>();
  for (const spot of at) {
    const [file, line] = spot.split(":");
    files.set(`src/${file}`, [...(files.get(`src/${file}`) ?? []), Number(line)]);
  }
  return {
    baseRef: "HEAD", mergeBase: "abc", head: "workingTree",
    files: [...files].map(([relativeFile, lines]) => ({ relativeFile, ranges: lines.map((l) => ({ start: l, end: l })) })),
    nonAlFiles: [], unresolvedAlFiles: [],
  };
}

/** Body line of a procedure ("Object.Procedure") as file:line. */
const bodyOf = (target: string) => {
  const p = discovered.procedures.find((c) => `${c.objectName}.${c.name}` === target);
  if (!p) throw new Error(`no procedure ${target}`);
  return `${p.relativeFile.slice(4)}:${p.startLine + 1}`;
};

// Planted bug -> tests that failed in the live full run (scripts/e2e.md, 2026-10-13).
const liveDiffs: { name: string; change: string[]; failed: string[]; selected: number }[] = [
  { name: "D1 Discount Rules.ApplyDiscount", change: ["Acc Discount Rules.ApplyDiscount"], selected: 9, failed: [
    "ApplyTenPercent", "CustomerPriceRating2", "CustomerPriceRating5NoDiscount", "InvoiceBoltRating2Danish",
    "InvoiceFreeShipping", "InvoiceGearExempt", "InvoiceInEuro", "InvoiceWithStandardShipping"] },
  { name: "D2 Tax DE.RatePct (interface)", change: ["Acc Tax DE.RatePct"], selected: 10, failed: ["GermanGrossRounds", "GermanTax"] },
  { name: "D3 Cash Rounding Subscriber.RoundToNickel (event)", change: ["Acc Cash Rounding Subscriber.RoundToNickel"], selected: 5, failed: ["InvoiceBoltRating2Danish"] },
  { name: "D4 Nightly Recalc.ApplyDecay (Codeunit.Run)", change: ["Acc Nightly Recalc.ApplyDecay"], selected: 1, failed: ["NightlyRecalcDecays"] },
  { name: "D6 Shipping threshold + untested export", change: ["Acc Shipping Rules.FreeShippingThreshold", "Acc Legacy Export.ExportLine"], selected: 5, failed: ["InvoiceFreeShipping"] },
];

describe("selectTests on the 40-codeunit acceptance fixture", () => {
  test("recorded map: 40 tests, every identity resolves except the OnRun trigger", () => {
    const known = new Set(discovered.procedures.map((p) => `${p.objectType}|${p.objectId}|${p.methodId}`));
    const unresolved = new Set(coverageMap.tests.flatMap((t) => t.procedures)
      .map((p) => `${p.objectType}|${p.objectId}|${p.methodId}`).filter((k) => !known.has(k)));
    expect(coverageMap.complete).toBe(true);
    expect(coverageMap.tests.length).toBe(40);
    expect(tests.length).toBe(40);
    expect([...unresolved]).toEqual(["5|50926|-401248892"]); // Acc Nightly Recalc.OnRun
  });

  test("planted bugs: every live failure selected, under 25% of the suite on average", () => {
    let selected = 0;
    for (const diff of liveDiffs) {
      const result = selectTests({ changes: changeAt(...diff.change.map(bodyOf)), discovered, tests, graph, coverageMap });
      const names = result.selection.map((s) => s.method);
      for (const method of diff.failed) expect(names).toContain(method);
      expect(result.fallbackToAll).toBe(false);
      expect(result.selection.length).toBe(diff.selected);
      selected += result.selection.length;
    }
    expect(selected / liveDiffs.length / tests.length).toBeLessThan(0.25);
  });

  test("untested changed procedure is uncoverable", () => {
    const result = selectTests({ changes: changeAt(bodyOf("Acc Legacy Export.ExportLine")), discovered, tests, graph, coverageMap });
    expect(result.selection).toEqual([]);
    expect(result.uncoverable.map((p) => `${p.objectName}.${p.name}`)).toEqual(["Acc Legacy Export.ExportLine"]);
  });

  test("OnRun trigger change falls back to the whole suite", () => {
    const result = selectTests({ changes: changeAt("AccNightlyRecalc.Codeunit.al:8"), discovered, tests, graph, coverageMap });
    expect(result.fallbackToAll).toBe(true);
    expect(result.shards.flatMap((s) => s.codeunits).reduce((n, c) => n + c.methods.length, 0)).toBe(40);
  });

  test("altool emits no Run edge: without history, a Codeunit.Run-only procedure is uncoverable", () => {
    const result = selectTests({ changes: changeAt(bodyOf("Acc Nightly Recalc.ApplyDecay")), discovered, tests, graph, coverageMap: null });
    expect(result.selection).toEqual([]);
    expect(result.uncoverable.map((p) => p.name)).toEqual(["ApplyDecay"]);
  });
});

// The #63 acceptance in code: the same fixture with the al-sem graph (`alsem graph`, recorded with
// ALCH_DRIVER_VERSION_OVERRIDE so re-recording does not churn the engine field; see the README).
describe("selectTests on the acceptance fixture with the al-sem graph", () => {
  let alsem: CallGraph;
  beforeAll(() => {
    alsem = parseAlSemCallGraphJsonl(readFileSync(join(fixture, "call-graph.al-sem.jsonl"), "utf8"));
  });
  const run = (change: GitChangeSet, map: CoverageMap | null) => selectTests({ changes: change, discovered, tests, graph: alsem, coverageMap: map });

  test("no coverage map: every planted bug selects every test that failed live, statically", () => {
    for (const diff of liveDiffs) {
      const result = run(changeAt(...diff.change.map(bodyOf)), null);
      const names = result.selection.map((s) => s.method);
      for (const method of diff.failed) expect(names).toContain(method);
      expect(result.fallbackToAll).toBe(false);
      expect(result.selection.length).toBe(diff.selected);
    }
  });

  test("D4: the Codeunit.Run-only ApplyDecay selects NightlyRecalcDecays without a coverage map", () => {
    const result = run(changeAt(bodyOf("Acc Nightly Recalc.ApplyDecay")), null);
    expect(result.selection.map((s) => [s.method, s.reason])).toEqual([["NightlyRecalcDecays", "event"]]);
    expect(result.uncoverable).toEqual([]);
  });

  test("D5: the OnRun trigger change selects its test instead of falling back", () => {
    const result = run(changeAt("AccNightlyRecalc.Codeunit.al:8"), null);
    expect(result.fallbackToAll).toBe(false);
    expect(result.changedProcedures.map((p) => [p.kind, p.name])).toEqual([["trigger", "OnRun"]]);
    expect(result.selection.map((s) => s.method)).toEqual(["NightlyRecalcDecays"]);
  });

  test("D2 through Interface, D3 through Event; ExportLine is uncoverable", () => {
    const d2 = run(changeAt(bodyOf("Acc Tax DE.RatePct")), null);
    expect(d2.selection).toHaveLength(10);
    expect(d2.selection.every((s) => s.reason === "event")).toBe(true);
    const d6 = run(changeAt(bodyOf("Acc Shipping Rules.FreeShippingThreshold"), bodyOf("Acc Legacy Export.ExportLine")), null);
    expect(d6.uncoverable.map((p) => `${p.objectName}.${p.name}`)).toEqual(["Acc Legacy Export.ExportLine"]);
    expect(d6.selection).toHaveLength(5);
  });

  test("with the recorded map: the union; D4 carries both static and history evidence", () => {
    const result = run(changeAt(bodyOf("Acc Nightly Recalc.ApplyDecay")), coverageMap);
    expect(result.selection.map((s) => [s.method, s.reasons, s.confidence])).toEqual([
      ["NightlyRecalcDecays", ["coverage-history", "event"], 0.95],
    ]);
  });

  test("every discovered procedure and trigger joins to exactly one workspace node", () => {
    const executables = [...discovered.procedures, ...discovered.unsupportedExecutables];
    expect(executables.length).toBe(90); // 89 procedures + the OnRun trigger
    for (const p of executables) {
      const hits = alsem.nodes.filter((n) => n.dependency === false && n.sourcePath === p.relativeFile
        && n.line! >= p.startLine && n.line! <= p.endLine && n.memberName?.toLowerCase() === p.name.toLowerCase());
      expect([`${p.objectName}.${p.name}`, hits.length]).toEqual([`${p.objectName}.${p.name}`, 1]);
    }
  });
});
