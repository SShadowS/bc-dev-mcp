import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAlSemStaticWritersProvider,
  diffStaticVsObserved,
  type AlSemJsonRunner,
  type StaticWriters,
} from "../../src/core/alsem-writes";
import { ALSEM_ENV_VAR } from "../../src/core/call-graph";
import type { RecordWriteWriterGroup } from "../../src/core/record-write-triage";

// Replays real `alsem query` output recorded from tests/fixtures/record-writes (al-sem 1.5.0, 2c48e56f).
const fixture = resolve("tests/fixtures/record-writes");
const recorded = (name: string) => readFileSync(join(fixture, "recorded", name), "utf8");
const APP_ID = "3c1b8a52-7d4e-4f0a-9b6e-2a5d9c7e1f43";

function replay(calls: string[][] = []): AlSemJsonRunner {
  const displayById = new Map<string, string>();
  for (const file of ["touches.table.json", "touches.unknown.json"]) {
    for (const r of JSON.parse(recorded(file)).payload.up.routines) displayById.set(r.stableId, r.display);
  }
  return async (_binary, args) => {
    calls.push(args);
    if (args[1] === "touches") {
      const selector = args[3];
      if (selector === "unknown") return { stdout: recorded("touches.unknown.json"), exitCode: 0 };
      if (selector === `${APP_ID}/table/50170` || selector === "RW Ledger") return { stdout: recorded("touches.table.json"), exitCode: 0 };
      return { stdout: recorded("touches.unmatched.json"), exitCode: 2 };
    }
    return { stdout: recorded(`effects.${displayById.get(args[3]!)}.json`), exitCode: 0 };
  };
}

const request = { project: fixture, tableId: 50170, includeTemporary: false };
const label = (s: { objectDisplay: string; routine: string; operation: string; line: number }) =>
  `${s.objectDisplay}.${s.routine} ${s.operation}@${s.line}`;

describe("static writer set from recorded al-sem output", () => {
  test("writes only, temporary excluded, inherited duplicates folded, unknown bucket kept apart", async () => {
    const { writers, warnings } = await createAlSemStaticWritersProvider({}, replay())(request);
    expect(warnings).toEqual([]);
    expect(writers!.alsemVersion).toBe("1.5.0");
    expect(writers!.table).toEqual({ selector: `${APP_ID}/table/50170`, name: "RW Ledger" });
    expect(writers!.sites.map(label).sort()).toEqual([
      "Codeunit RW Ledger Writer.Adjust Modify@16",
      "Codeunit RW Ledger Writer.Post Insert@7",
      "Codeunit RW Ledger Writer.Purge DeleteAll@24",
      "Codeunit RW Ledger Writer.Rekey Rename@32",
    ]);
    expect(writers!.sites[0]!.file).toBe("src/LedgerWriter.Codeunit.al");
    expect(writers!.unknownBucketSites.map(label)).toEqual(["Codeunit RW Ledger Writer.DynamicWrite Insert@57"]);
    expect(writers!.caveats.join(" ")).toContain("#28");
    expect(writers!.caveats.join(" ")).toContain("#9");
  });

  test("includeTemporary keeps the temporary-record write", async () => {
    const { writers } = await createAlSemStaticWritersProvider({}, replay())({ ...request, includeTemporary: true });
    expect(writers!.sites.map(label)).toContain("Codeunit RW Ledger Writer.ScratchOnly Insert@40");
  });

  test("falls back from the appId selector to the table name", async () => {
    const calls: string[][] = [];
    const run = replay(calls);
    // A project with no app.json id: only the name selector is tried.
    const dir = mkdtempSync(join(tmpdir(), "bcmcp-rw-"));
    const { writers } = await createAlSemStaticWritersProvider({}, run)({ project: dir, tableId: 18, tableName: "RW Ledger", includeTemporary: false });
    expect(writers!.table.selector).toBe("RW Ledger");
    // appId selector first when app.json has an id but alsem does not know that table
    writeFileSync(join(dir, "app.json"), JSON.stringify({ id: "other" }));
    const second = await createAlSemStaticWritersProvider({}, run)({ project: dir, tableId: 18, tableName: "RW Ledger", includeTemporary: false });
    expect(second.writers!.table.selector).toBe("RW Ledger");
    expect(calls.filter((c) => c[1] === "touches" && c[3] === "other/table/18")).toHaveLength(1);
  });

  test("an unresolvable table yields no writers and exactly one warning", async () => {
    const { writers, warnings } = await createAlSemStaticWritersProvider({}, replay())({ ...request, tableId: 99, tableName: "Nope" });
    expect(writers).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not resolve table 99");
  });

  test("a missing alsem binary is one warning, not an error", async () => {
    const run: AlSemJsonRunner = async () => { throw Object.assign(new Error("spawn alsem ENOENT"), { code: "ENOENT" }); };
    const { writers, warnings } = await createAlSemStaticWritersProvider({ [ALSEM_ENV_VAR]: "C:/x/alsem.exe" }, run)(request);
    expect(writers).toBeNull();
    expect(warnings).toEqual([expect.stringContaining(ALSEM_ENV_VAR)]);
    expect(warnings[0]).toContain("C:/x/alsem.exe");
  });

  test("an unknown schema major, wrong kind or non-JSON fails soft", async () => {
    for (const stdout of [
      JSON.stringify({ kind: "query.touches", schemaVersion: "2.0.0", payload: {} }),
      JSON.stringify({ kind: "query.effects", schemaVersion: "1.0.0", payload: {} }),
      "not json",
    ]) {
      const { writers, warnings } = await createAlSemStaticWritersProvider({}, async () => ({ stdout, exitCode: 0 }))(request);
      expect(writers).toBeNull();
      expect(warnings).toHaveLength(1);
    }
  });
});

function group(over: Partial<RecordWriteWriterGroup> & { line: number; objectId?: number; methodName?: string; operation?: RecordWriteWriterGroup["operation"] }): RecordWriteWriterGroup {
  return {
    operation: over.operation ?? "insert",
    receiver: "Ledger",
    count: over.count ?? 1,
    firstSequence: 1,
    lastSequence: 1,
    source: "deployed",
    stack: [{ objectType: 5, objectId: over.objectId ?? 50171, objectName: "RW Ledger Writer", methodName: over.methodName ?? "Post", line: over.line, ...(over.stack?.[0]?.statementSpan ? { statementSpan: over.stack[0].statementSpan } : {}) }],
  };
}

describe("static versus observed diff", () => {
  let writers: StaticWriters;
  const load = async () => (writers = (await createAlSemStaticWritersProvider({}, replay())(request)).writers!);

  test("matched, statically-possible-never-observed, and observed-not-static (unknown bucket flagged)", async () => {
    await load();
    const diff = diffStaticVsObserved(writers, [
      group({ line: 7 }), // Post Insert
      group({ line: 16, operation: "modify", methodName: "Adjust" }),
      group({ line: 57, methodName: "DynamicWrite" }), // in al-sem's unknown bucket
      group({ line: 99, objectId: 50172, methodName: "Elsewhere", operation: "delete" }), // al-sem has no idea
    ], true);
    expect(diff.matched).toBe(2);
    expect(diff.staticNotObserved.map(label).sort()).toEqual([
      "Codeunit RW Ledger Writer.Purge DeleteAll@24",
      "Codeunit RW Ledger Writer.Rekey Rename@32",
    ]);
    expect(diff.observedNotStatic.map((o) => [o.frame.methodName, o.inUnknownBucket])).toEqual([
      ["DynamicWrite", true],
      ["Elsewhere", false],
    ]);
    expect(diff.observationComplete).toBe(true);
  });

  test("a multi-line statement matches on its span; operation must agree", async () => {
    await load();
    const spanned = group({ line: 6 });
    spanned.stack[0]!.statementSpan = { from: { line: 6, column: 9 }, to: { line: 8, column: 3 } };
    expect(diffStaticVsObserved(writers, [spanned], false).matched).toBe(1);
    expect(diffStaticVsObserved(writers, [group({ line: 7, operation: "modify" })], false).observedNotStatic).toHaveLength(1);
    expect(diffStaticVsObserved(writers, [], false).observationComplete).toBe(false);
  });
});

function liveAlsem(): string | undefined {
  const binary = process.env[ALSEM_ENV_VAR]?.trim() || "alsem";
  const probe = spawnSync(binary, ["--help"], { encoding: "utf8", windowsHide: true });
  return probe.status === 0 && probe.stdout.includes("query") ? binary : undefined;
}

describe("live alsem (skipped unless alsem is installed)", () => {
  const binary = liveAlsem();
  test.if(binary !== undefined)("the live static set equals the one built from recorded output", async () => {
    const live = await createAlSemStaticWritersProvider({ [ALSEM_ENV_VAR]: binary })(request);
    const recordedSet = await createAlSemStaticWritersProvider({}, replay())(request);
    expect(live.warnings).toEqual([]);
    expect(live.writers!.sites.map(label).sort()).toEqual(recordedSet.writers!.sites.map(label).sort());
    expect(live.writers!.unknownBucketSites.map(label)).toEqual(recordedSet.writers!.unknownBucketSites.map(label));
  });
});
