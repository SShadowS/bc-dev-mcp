import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectSnapshot } from "../../../src/core/snapshot/debug-snapshot";
import type { ArmedSnappoint } from "../../../src/core/snapshot/snappoints";

const doc = JSON.parse(readFileSync(join(import.meta.dir, "../../fixtures/snapshot-debug/page-exception.snapshot.json"), "utf8"));
const SOURCE = Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`);
SOURCE[34] = "        PageLocalText := 'page trigger zoo';";
SOURCE[35] = "        Error('page OnOpenPage break');";
const readSource = (entry: string) => (entry === "Page%50152.al" ? "﻿" + SOURCE.join("\r\n") : null);
const armed: ArmedSnappoint[] = [{ objectType: 8, objectTypeName: "page", objectId: 50152, line: 35, wireLine: 34, unverified: false }];
const v = (vars: unknown, name: string) => (vars as Array<{ name: string; value: string }>).find((x) => x.name === name);

describe("projectSnapshot (Cronus29 page 50152 capture)", () => {
  test("exception first, then the snappoint; 1-based lines; values before the line runs", () => {
    const p = projectSnapshot(doc, armed, readSource);
    expect(p.classification).toBe("complete");
    expect(p.points.map((x) => [x.reasons, x.line])).toEqual([[["exception"], 36], [["snappoint"], 35]]);
    const [exc, snap] = p.points;
    expect(exc!.message).toBe("page OnOpenPage break");
    expect(v(exc!.variables, "PageLocalText")!.value).toBe("'page trigger zoo'");
    expect(v(snap!.variables, "PageLocalText")!.value).toBe("''");
    expect(snap!.stack[0]).toEqual({ object: { type: "Page", id: 50152, name: "Trigger Demo Page" }, method: "OnOpenPage", line: 35 });
    expect(snap!.source).toMatchObject({ entry: "Page%50152.al", highlightLine: 35, startLine: 30, endLine: 40 });
    expect(snap!.source!.lines[5]).toBe("        PageLocalText := 'page trigger zoo';");
    expect(exc!.source!.highlightLine).toBe(36);
  });
  test("orphan without snappoints: partial, the non-exception context is 'recorded'", () => {
    const p = projectSnapshot(doc, null, readSource);
    expect(p.classification).toBe("partial");
    expect(p.points.map((x) => x.reasons)).toEqual([["exception"], ["recorded"]]);
  });
  test("exception index with no line context -> variables unavailable", () => {
    const d = structuredClone(doc); d.methods[0].exception.lineNumber = 9;
    const exc = projectSnapshot(d, armed, readSource).points.find((x) => x.reasons.includes("exception"))!;
    expect(exc.variables).toEqual({ unavailable: expect.stringContaining("no line context") });
    expect(exc.line).toBe(36); // from the exception span
  });
  test("repeated hits stay separate, in method order (page opened twice)", () => {
    const d = structuredClone(doc); const second = structuredClone(d.methods[0]); second.entry = "229.mdc"; second.exception = null; d.methods.push(second);
    const p = projectSnapshot(d, armed, readSource);
    expect(p.points.filter((x) => x.reasons.includes("snappoint")).map((x) => x.entry)).toEqual(["228.mdc", "229.mdc"]);
  });
  test("only the error happened: one exception point, no snappoint points", () => {
    const p = projectSnapshot(doc, [{ ...armed[0]!, line: 3, wireLine: 2 }], readSource);
    expect(p.points.map((x) => x.reasons)).toEqual([["exception"]]);
  });
  test("limits: 50 points exceptions first, depth/children/value caps, node budget", () => {
    const d = structuredClone(doc);
    const big = { name: "Big", type: "Text", value: "æ".repeat(499) + "😀" + "x".repeat(10), hasChildren: true,
      children: Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, type: "T", value: "x", hasChildren: true, children: [{ name: "g", type: "T", value: "y", hasChildren: true, children: [{ name: "gg", type: "T", value: "z", hasChildren: false, children: [] }] }] })) };
    d.methods[0].lineContexts[0].variables.push(big);
    const loops = Array.from({ length: 60 }, (_, i) => ({ ...structuredClone(d.methods[0]), entry: `${300 + i}.mdc`, exception: null }));
    d.methods.push(...loops);
    const p = projectSnapshot(d, armed, readSource);
    expect(p.points).toHaveLength(50);
    expect(p.points[0]!.reasons).toEqual(["exception"]);
    expect(p.omittedPoints).toBe(12); // 1 exception + 61 snappoint hits (original + 60 clones) = 62, 50 returned
    const node = (p.points[1]!.variables as Array<{ name: string }>).find((x) => x.name === "Big") as any;
    expect(node.value).toBe("æ".repeat(499)); // the cut at 500 would split the emoji's surrogate pair, so it is dropped
    expect(node.valueTruncated).toBe(true);
    expect(node.children).toHaveLength(50);
    expect(node.omittedChildren).toBe(10);
    expect(node.children[0].children[0].children).toEqual([]); // depth 3
    expect(node.children[0].children[0].omittedChildren).toBe(1);
    expect(p.points.some((x) => (x.variables as any).unavailable === "variable budget used")).toBe(true);
  });
  test("root variables are capped at 50 and counted", () => {
    const d = structuredClone(doc);
    d.methods[0].lineContexts[0].variables = Array.from({ length: 60 }, (_, i) => ({ name: `r${i}`, type: "T", value: "x", hasChildren: false, children: [] }));
    const snap = projectSnapshot(d, armed, readSource).points.find((x) => x.reasons.includes("snappoint"))!;
    expect(snap.variables).toHaveLength(50);
    expect(snap.omittedVariables).toBe(10);
  });
  test("budget running out mid-list counts the dropped roots and never overspends", () => {
    const d = structuredClone(doc);
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `r${i}`, type: "T", value: "x", hasChildren: false, children: [] }));
    d.methods[0].lineContexts[0].variables = mk(45);
    d.methods[0].lineContexts[1].variables = mk(45);
    d.methods.push(...Array.from({ length: 60 }, (_, i) => ({ ...structuredClone(d.methods[0]), entry: `${300 + i}.mdc`, exception: null })));
    const pts = projectSnapshot(d, armed, readSource).points;
    const count = (n: any): number => 1 + n.children.reduce((a: number, c: any) => a + count(c), 0);
    const total = pts.reduce((a, p) => a + (Array.isArray(p.variables) ? p.variables.reduce((b, n) => b + count(n), 0) : 0), 0);
    expect(total).toBe(2000);
    const cut = pts.find((p) => p.omittedVariables !== undefined && Array.isArray(p.variables) && p.variables.length < 45)!;
    expect(cut.omittedVariables).toBe(45 - (cut.variables as unknown[]).length);
    expect(pts.some((p) => (p.variables as any).unavailable === "variable budget used")).toBe(true);
  });
  test("missing or ambiguous source -> no window and a warning", () => {
    const p = projectSnapshot(doc, armed, () => null);
    expect(p.points.every((x) => x.source === undefined)).toBe(true);
    expect(p.warnings.join(" ")).toContain("source");
  });
  test("source match ignores case (converter 'CodeUnit' vs entry 'Codeunit%50130.al')", () => {
    const d = structuredClone(doc);
    d.methods[0].object = { type: "CodeUnit", typeId: 5, id: 50130, name: "Demo Payment Split" };
    d.sources = [{ entry: "Codeunit%50130.al", objectType: "Codeunit", objectId: 50130 }];
    const p = projectSnapshot(d, null, (e) => (e === "Codeunit%50130.al" ? SOURCE.join("\n") : null));
    expect(p.points[0]!.source?.entry).toBe("Codeunit%50130.al");
  });
  test("no method contexts at all (Background on BC29: source only) -> 'no execution was recorded', not the armed-line warning", () => {
    const d = structuredClone(doc); d.methods = [];
    const p = projectSnapshot(d, armed, readSource);
    expect(p.points).toEqual([]);
    expect(p.warnings.join(" ")).toContain("holds no method contexts");
    expect(p.warnings.join(" ")).not.toContain("none at an armed line");
    const withMethods = structuredClone(doc); withMethods.methods = withMethods.methods.map((m: Record<string, unknown>) => ({ ...m, exception: null, lines: [] }));
    expect(projectSnapshot(withMethods, [], readSource).warnings.join(" ")).toContain("none at an armed line");
  });
  test("rejects a document that is not bc-mdc-snapshot schema 1", () => {
    expect(() => projectSnapshot({ format: "x" }, armed, readSource)).toThrow();
  });
});
