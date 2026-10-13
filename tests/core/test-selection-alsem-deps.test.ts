import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAlProcedureIdentities, discoverTestMethodIdentities, type AlProcedureDiscoveryResult, type TestMethodIdentity } from "../../src/core/al-procedures";
import { ALSEM_ENV_VAR, createAlSemCallGraphProvider, parseAlSemCallGraphJsonl, type CallGraph } from "../../src/core/call-graph";
import type { GitChangeSet } from "../../src/core/git-changes";
import { selectTests } from "../../src/core/test-selection";
import { writeDependencyPackages } from "../fixtures/alsem-deps-packages";

// Dependencies from the consumer's side (al-sem spec 2026-10-13 §6, §11.5): a workspace over a
// source-shipping dependency (XDep) and a symbol-only one (SymLib). The offline tests replay the
// recorded `alsem graph` output (tests/fixtures/test-selection-alsem-deps/call-graph.al-sem.jsonl,
// recorded from this fixture plus writeDependencyPackages); the live test re-runs alsem when it
// is installed.
const fixture = resolve("tests/fixtures/test-selection-alsem-deps");
let discovered: AlProcedureDiscoveryResult;
let tests: TestMethodIdentity[];
let graph: CallGraph;

beforeAll(async () => {
  discovered = await discoverAlProcedureIdentities(fixture, readdirSync(join(fixture, "src")).map((f) => `src/${f}`));
  tests = (await discoverTestMethodIdentities(fixture)).methods;
  graph = parseAlSemCallGraphJsonl(readFileSync(join(fixture, "call-graph.al-sem.jsonl"), "utf8"));
});

/** A change set editing the first body line of `Object.Procedure`. */
function changeOf(target: string): GitChangeSet {
  const p = discovered.procedures.find((c) => `${c.objectName}.${c.name}` === target);
  if (!p) throw new Error(`no procedure ${target}`);
  return {
    baseRef: "HEAD", mergeBase: "abc", head: "workingTree",
    files: [{ relativeFile: p.relativeFile, ranges: [{ start: p.startLine + 1, end: p.startLine + 1 }] }],
    nonAlFiles: [], unresolvedAlFiles: [],
  };
}
const select = (target: string) => selectTests({ changes: changeOf(target), discovered, tests, graph, coverageMap: null });

describe("selection across dependencies (recorded al-sem graph)", () => {
  test("meta states each dependency's source", () => {
    expect(graph.meta!.apps.map((a) => [a.name, a.source]).sort()).toEqual([["SymLib", "symbolOnly"], ["XDep", "embedded"]]);
  });

  test("a source-shipping dependency is precise: its body raises the event the workspace handles", () => {
    const result = select("Ws Hooks.Handled");
    expect(result.selection.map((s) => [s.method, s.reason]).sort()).toEqual([["InsertItem", "event"], ["WorkRaises", "event"]]);
    expect(result.fallbackToAll).toBe(false);
  });

  test("a symbol-only dependency reaches its subscriber only through its callbacks hub: dynamic, with a warning", () => {
    const result = select("Ws Hooks.SymHandled");
    expect(result.selection.map((s) => [s.method, s.reason])).toEqual([["ComputeSym", "dynamic"]]);
    const warnings = result.warnings.join("\n");
    expect(warnings).toContain("SymLib");
    expect(warnings).toContain("relies on al-sem's stated assumptions");
  });

  test("a subscriber to a dependency table's platform event falls back (no record operation raises it yet)", () => {
    const result = select("Ws Hooks.AfterInsert");
    expect(result.fallbackToAll).toBe(true);
    expect(result.fallbackReasons.join("\n")).toContain("Dep Item.OnAfterInsertEvent (unraisedPublisher)");
  });

  test("a table-extension OnAfterInsert falls back (al-sem does not route record operations to it yet)", () => {
    const result = select("Ws Hooks.ExtAfterInsert");
    expect(result.fallbackToAll).toBe(true);
    expect(result.fallbackReasons.join("\n")).toContain("unmodeledRecordTrigger");
  });
});

/** The alsem binary to run live, when one is installed. */
function liveAlsem(): string | undefined {
  const binary = process.env[ALSEM_ENV_VAR]?.trim() || "alsem";
  const probe = spawnSync(binary, ["--help"], { encoding: "utf8", windowsHide: true });
  return probe.status === 0 && probe.stdout.includes("graph") ? binary : undefined;
}

describe("live alsem (skipped unless alsem is installed)", () => {
  const binary = liveAlsem();
  test.if(binary !== undefined)("the provider builds the same structure as the recorded graph", async () => {
    const work = mkdtempSync(join(tmpdir(), "bcmcp-alsem-deps-"));
    cpSync(join(fixture, "app.json"), join(work, "app.json"));
    cpSync(join(fixture, "src"), join(work, "src"), { recursive: true });
    writeDependencyPackages(work);
    const live = await createAlSemCallGraphProvider({ [ALSEM_ENV_VAR]: binary })(work);
    const shape = (g: CallGraph) => g.nodes.map((n) => `${n.kind}:${n.objectName}.${n.memberName ?? n.hub ?? ""}:${(n.hiddenCallers ?? []).join(",")}`).sort();
    expect(shape(live)).toEqual(shape(graph));
    expect(live.edges.length).toBe(graph.edges.length);
  });
});
