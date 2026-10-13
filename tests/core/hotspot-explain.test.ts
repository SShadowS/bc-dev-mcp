import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALSEM_ENV_VAR } from "../../src/core/call-graph";
import { createAlSemAnalyze, explainHotspots, parseAlSemAnalyze, PERF_DETECTORS, type AlSemAnalyze } from "../../src/core/hotspot-explain";
import type { Hotspot } from "../../src/core/snapshot/profile-summary";

// Recorded `alsem analyze --format json --with-evidence --single-app` output over ws/ (see README).
const fixtureDir = join(import.meta.dir, "..", "fixtures", "alsem-hotspots");
const project = join(fixtureDir, "ws");
const recorded = readFileSync(join(fixtureDir, "analyze.json"), "utf8");

const hot = (fn: string, url: string, selfMs = 10): Hotspot => ({ function: fn, url, line: 1, selfSamples: 1, selfMs, selfPct: 10 });
const CU = "al-preview://allang/Codeunit/50100/Codeunit_50100.dal";
const returns = (text: string): AlSemAnalyze => async () => text;

describe("parseAlSemAnalyze", () => {
  test("reads findings, evidence (1-based lines) and fix hints", () => {
    const { findings, alsemVersion, warnings } = parseAlSemAnalyze(recorded);
    expect(warnings).toEqual([]);
    expect(alsemVersion).toBe("1.5.0");
    const d1 = findings.find((f) => f.detector === "d1-db-op-in-loop" && f.routine === "SumLines")!;
    expect(d1).toMatchObject({ title: "Database operation inside a loop", confidence: "likely", severity: "medium", file: "src/SlowLoop.Codeunit.al", line: 13, objectKey: "codeunit_50100" });
    expect(d1.fix).toContain("outside the loop");
    expect(d1.evidence.map((e) => [e.note, e.line])).toEqual([["repeat loop", 11], ["FindFirst on Cust. Ledger Entry (type not loaded)", 13]]);
  });

  test("an unknown schema major, wrong kind or non-JSON is a warning, not a throw", () => {
    const bump = JSON.stringify({ ...JSON.parse(recorded), schemaVersion: "2.0.0" });
    expect(parseAlSemAnalyze(bump).warnings[0]).toContain("schemaVersion '2.0.0'");
    expect(parseAlSemAnalyze(JSON.stringify({ kind: "other", schemaVersion: "1.1.0" })).warnings[0]).toContain("kind 'other'");
    expect(parseAlSemAnalyze("not json").warnings).toHaveLength(1);
  });

  test("skips a malformed finding and keeps unknown detector ids", () => {
    const doc = JSON.parse(recorded);
    doc.payload.findings = [{ detector: "d99-future", primaryLocation: { file: "ws:src/X.al", routineName: "R", line: 3, objectId: "a/Codeunit/1" } }, { detector: "broken" }];
    const { findings } = parseAlSemAnalyze(JSON.stringify(doc));
    expect(findings.map((f) => f.detector)).toEqual(["d99-future"]);
    expect(findings[0]!.title).toBe("d99-future");
  });
});

describe("explainHotspots", () => {
  test("attaches findings to the hotspot in the same object + routine only", async () => {
    const hotspots = [hot("SumLines", CU), hot("Quiet", CU), hot("SumLines", "al-preview://allang/Codeunit/50101/Codeunit_50101.dal"), hot("Unblock", CU)];
    const result = await explainHotspots(hotspots, project, returns(recorded));
    expect(result.warnings).toEqual([]);
    const [sum, quiet, otherObject, unblock] = result.hotspots;
    expect(sum!.findings!.map((f) => f.detector)).toEqual(["d1-db-op-in-loop"]);
    expect(quiet!.findings).toBeUndefined();
    expect(otherObject!.findings).toBeUndefined();
    expect(unblock!.findings!.map((f) => f.detector).sort()).toEqual(["d1-db-op-in-loop", "d5-set-based-opportunity"]);
    expect(unblock!.findings![0]).not.toHaveProperty("objectKey");
    expect(result.analysis).toMatchObject({ source: "al-sem", alsemVersion: "1.5.0", findingsTotal: 3, findingsMatched: 3 });
    expect(result.analysis!.notes.join(" ")).toContain("al-sem#28");
  });

  test("matches a real .al path url and is case-insensitive on the routine", async () => {
    const result = await explainHotspots([hot("sumlines", `file:///C:/work/app/src/SlowLoop.Codeunit.al`)], project, returns(recorded));
    expect(result.hotspots[0]!.findings).toHaveLength(1);
  });

  test("a frame declared by another app is not the workspace's, even with the same object id", async () => {
    // WIRE: the frame url carries no app segment (live 2026-10-13); node.declaringApplication.appId is the only discriminator.
    let calls = 0;
    const ws = "22222222-0000-0000-0000-00000000a115"; // tests/fixtures/alsem-hotspots/ws/app.json
    const analyze: AlSemAnalyze = async () => {
      calls++;
      return recorded;
    };
    const other = await explainHotspots([{ ...hot("SumLines", CU), appId: "99999999000000000000000000000001" }], project, analyze);
    expect(calls).toBe(0);
    expect(other.hotspots[0]!.findings).toBeUndefined();
    const own = await explainHotspots([{ ...hot("SumLines", CU), appId: ws.replace(/-/g, "") }, { ...hot("SumLines", CU), appId: "99999999000000000000000000000001" }], project, analyze);
    expect(calls).toBe(1);
    expect(own.hotspots[0]!.findings).toHaveLength(1);
    expect(own.hotspots[1]!.findings).toBeUndefined();
    expect(own.analysis!.findingsMatched).toBe(1);
  });

  test("caps findings per hotspot and counts the rest", async () => {
    const doc = JSON.parse(recorded);
    const one = doc.payload.findings[0];
    doc.payload.findings = Array.from({ length: 7 }, () => one);
    const result = await explainHotspots([hot("SumLines", CU)], project, returns(JSON.stringify(doc)));
    expect(result.hotspots[0]!.findings).toHaveLength(5);
    expect(result.hotspots[0]!.omittedFindings).toBe(2);
  });

  test("does not run alsem when no hotspot is in the workspace app", async () => {
    let calls = 0;
    const result = await explainHotspots([hot("OnOpenPage", "al-preview://allang/Page/22/Page_22.dal"), hot("IdleTime", "al-preview://allang/Undefined:-1")], project, async () => {
      calls++;
      return recorded;
    });
    expect(calls).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.analysis).toBeUndefined();
  });

  test("does not run alsem when the folder is not an AL workspace", async () => {
    let calls = 0;
    const result = await explainHotspots([hot("SumLines", CU)], fixtureDir, async () => {
      calls++;
      return recorded;
    });
    expect(calls).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  test("skips with a warning above the size threshold", async () => {
    let calls = 0;
    const result = await explainHotspots([hot("SumLines", CU)], project, async () => {
      calls++;
      return recorded;
    }, { maxAlFiles: 0 });
    expect(calls).toBe(0);
    expect(result.warnings[0]).toContain("limit 0");
    expect(result.hotspots[0]!.findings).toBeUndefined();
  });

  test("alsem missing: one warning naming the env var, hotspots unchanged", async () => {
    const missing = Object.assign(new Error("spawn alsem ENOENT"), { code: "ENOENT" });
    const hotspots = [hot("SumLines", CU)];
    const result = await explainHotspots(hotspots, project, async () => { throw missing; });
    expect(result.hotspots).toBe(hotspots);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(ALSEM_ENV_VAR);
  });

  test("timeout and failure are warnings", async () => {
    const timedOut = await explainHotspots([hot("SumLines", CU)], project, async () => { throw Object.assign(new Error("t"), { killed: true }); }, { timeoutMs: 5000 });
    expect(timedOut.warnings[0]).toContain("timed out after 5s");
    const failed = await explainHotspots([hot("SumLines", CU)], project, async () => { throw Object.assign(new Error("x"), { stderr: "boom" }); });
    expect(failed.warnings[0]).toContain("boom");
  });

  test("an unknown schema major is a warning and leaves hotspots unchanged", async () => {
    const result = await explainHotspots([hot("SumLines", CU)], project, returns(JSON.stringify({ ...JSON.parse(recorded), schemaVersion: "3.0.0" })));
    expect(result.warnings[0]).toContain("not supported");
    expect(result.hotspots[0]!.findings).toBeUndefined();
  });

  test("drops a detector id alsem rejects and retries", async () => {
    const seen: string[][] = [];
    const result = await explainHotspots([hot("SumLines", CU)], project, async (_p, detectors) => {
      seen.push(detectors);
      if (detectors.includes("d3-missing-setloadfields")) throw Object.assign(new Error("e"), { stderr: "al-sem: Unknown detector: d3-missing-setloadfields" });
      return recorded;
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(PERF_DETECTORS.filter((d) => d !== "d3-missing-setloadfields"));
    expect(result.warnings).toEqual([]);
    expect(result.hotspots[0]!.findings).toHaveLength(1);
    expect(result.analysis!.detectors).not.toContain("d3-missing-setloadfields");
  });
});

describe("createAlSemAnalyze", () => {
  test("a missing binary rejects with ENOENT (explainHotspots turns it into the not-found warning)", async () => {
    const run = createAlSemAnalyze({ [ALSEM_ENV_VAR]: join(fixtureDir, "no-such-alsem.exe") });
    await expect(run(project, ["d1-db-op-in-loop"], 5000)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/** The alsem binary to run live, when one is installed. */
function liveAlsem(): string | undefined {
  const binary = process.env[ALSEM_ENV_VAR]?.trim() || "alsem";
  const probe = spawnSync(binary, ["analyze", "--help"], { encoding: "utf8", windowsHide: true });
  return probe.status === 0 && probe.stdout.includes("--with-evidence") ? binary : undefined;
}

describe("live alsem (skipped unless alsem is installed)", () => {
  const binary = liveAlsem();
  test.if(binary !== undefined)("explains the recorded hotspots from a real analyze run", async () => {
    const result = await explainHotspots([hot("SumLines", CU), hot("Unblock", CU)], project, createAlSemAnalyze({ [ALSEM_ENV_VAR]: binary }));
    expect(result.warnings).toEqual([]);
    expect(result.hotspots[0]!.findings![0]).toMatchObject({ detector: "d1-db-op-in-loop", line: 13 });
    expect(result.hotspots[1]!.findings!.map((f) => f.detector)).toContain("d5-set-based-opportunity");
  });
});
