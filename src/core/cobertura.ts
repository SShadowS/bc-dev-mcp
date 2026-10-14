import type { AlProcedureIdentity } from "./al-procedures";
import type { CoverageEntry } from "./types";

export interface CoberturaReport {
  xml: string;
  /** Procedures emitted as methods. */
  procedures: number;
  /** Emitted procedures with hits > 0. */
  covered: number;
  /** Covered procedures that match no emitted project procedure (other apps, or a local identity mismatch). */
  outside: number;
  /** Project procedures omitted because they have no compiler method identity. */
  unidentified: number;
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const rate = (covered: number, total: number) => String(total === 0 ? 0 : covered / total);

function comparePaths(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Procedure coverage as Cobertura XML in the layout `altool runtests --coverage procedure
 * --coverage-format cobertura` writes: one package/class per AL source file, one method per
 * procedure, hits = distinct tests that reached it. Counts are methods, not lines.
 * `excludedObjects` holds `${objectType}|${objectId}` keys (test codeunits) left out entirely.
 */
export function buildCobertura(
  coverage: CoverageEntry[],
  procedures: AlProcedureIdentity[],
  excludedObjects: Set<string>,
): CoberturaReport {
  const testsByProcedure = new Map<string, Set<string>>();
  for (const entry of coverage) {
    for (const p of entry.coveredProcedures) {
      const key = `${p.objectType}|${p.objectId}|${p.methodId}`;
      let tests = testsByProcedure.get(key);
      if (!tests) testsByProcedure.set(key, (tests = new Set()));
      tests.add(`${entry.testObjectId}|${entry.testMethodId}`);
    }
  }

  let unidentified = 0;
  const emitted = new Set<string>();
  const byFile = new Map<string, Array<{ name: string; methodId: number; line: number; hits: number }>>();
  for (const p of procedures) {
    if (excludedObjects.has(`${p.objectType}|${p.objectId}`)) continue;
    if (p.methodId === null) {
      unidentified++;
      continue;
    }
    const key = `${p.objectType}|${p.objectId}|${p.methodId}`;
    emitted.add(key);
    const file = p.relativeFile.replace(/\\/g, "/");
    let methods = byFile.get(file);
    if (!methods) byFile.set(file, (methods = []));
    methods.push({ name: p.name, methodId: p.methodId, line: p.startLine, hits: testsByProcedure.get(key)?.size ?? 0 });
  }
  let outside = 0;
  for (const key of testsByProcedure.keys()) {
    const [type, id] = key.split("|");
    if (!emitted.has(key) && !excludedObjects.has(`${type}|${id}`)) outside++;
  }

  let total = 0;
  let covered = 0;
  const packages: string[] = [];
  for (const file of [...byFile.keys()].sort(comparePaths)) {
    const methods = byFile.get(file)!.sort((a, b) => a.line - b.line);
    const hit = methods.filter((m) => m.hits > 0).length;
    total += methods.length;
    covered += hit;
    const lineXml = (m: { line: number; hits: number }, indent: string) =>
      `${indent}<line number="${m.line}" hits="${m.hits}" branch="false" />`;
    const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.al$/i, "");
    packages.push([
      `    <package name="AL" line-rate="${rate(hit, methods.length)}" branch-rate="0" complexity="0">`,
      "      <classes>",
      `        <class name="${escapeXml(name)}" filename="${escapeXml(file)}" line-rate="${rate(hit, methods.length)}" branch-rate="0" complexity="0">`,
      "          <methods>",
      ...methods.flatMap((m) => [
        `            <method name="${escapeXml(m.name)}" signature="${m.methodId}" line-rate="${m.hits > 0 ? 1 : 0}" branch-rate="0">`,
        "              <lines>",
        lineXml(m, "                "),
        "              </lines>",
        "            </method>",
      ]),
      "          </methods>",
      "          <lines>",
      ...methods.map((m) => lineXml(m, "            ")),
      "          </lines>",
      "        </class>",
      "      </classes>",
      "    </package>",
    ].join("\n"));
  }
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<coverage line-rate="${rate(covered, total)}" lines-covered="${covered}" lines-valid="${total}" branch-rate="0" branches-covered="0" branches-valid="0" complexity="0" version="1.0" timestamp="0">`,
    "  <sources>",
    "    <source></source>",
    "  </sources>",
    "  <packages>",
    ...packages,
    "  </packages>",
    "</coverage>",
    "",
  ].join("\n");
  return { xml, procedures: total, covered, outside, unidentified };
}
