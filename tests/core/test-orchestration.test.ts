import { describe, expect, test } from "bun:test";
import { analyzeTestOrchestration } from "../../src/core/test-orchestration";
import type { RunTestsResult, TestMethodResult } from "../../src/core/types";

function run(
  results: TestMethodResult[],
  options: { aborted?: boolean } = {},
): RunTestsResult {
  return {
    results,
    ...(options.aborted
      ? { runAborted: true, abortReason: "synthetic dropped connection" }
      : {}),
  };
}

const row = (
  method: string,
  status: "passed" | "failed" | "skipped",
  durationMs = 1,
  codeunitId = 50100,
): TestMethodResult => ({
  codeunitId,
  method,
  status,
  durationMs,
  output: status === "failed" ? "boom" : "",
});

describe("test orchestration analysis", () => {
  test("classifies stable pass, fail, and skip while excluding synthetic rows", () => {
    const runs = [1, 2, 3].map(() => run([
      row("Passes", "passed", 2),
      row("Fails", "failed", 3),
      row("Skipped", "skipped", 1),
      row("", "failed", 100),
    ]));
    const result = analyzeTestOrchestration([{ id: 50100 }], runs, 3);

    expect(result).toMatchObject({
      complete: true,
      outcome: "failed",
      runsRequested: 3,
      runsCompleted: 3,
      summary: {
        tests: 3,
        stablePassed: 1,
        stableFailed: 1,
        stableSkipped: 1,
        flaky: 0,
        inconsistent: 0,
        incomplete: 0,
        totalDurationMs: 18,
      },
      warnings: [],
    });
    expect(result.tests.map((entry) => [entry.method, entry.classification])).toEqual([
      ["Fails", "stableFailed"],
      ["Passes", "stablePassed"],
      ["Skipped", "stableSkipped"],
    ]);
    expect(result.diffs).toHaveLength(2);
    for (const diff of result.diffs) {
      expect(diff.passed).toEqual({ added: [], removed: [] });
      expect(diff.failed).toEqual({ added: [], removed: [] });
      expect(diff.changed).toEqual([]);
    }
  });

  test("flags pass/fail flakes and returns exact adjacent passed and failed set diffs", () => {
    const result = analyzeTestOrchestration([{ id: 50100 }], [
      run([row("A", "passed"), row("B", "failed")]),
      run([row("A", "failed"), row("B", "passed")]),
      run([row("A", "passed"), row("B", "passed")]),
    ], 3);

    expect(result.complete).toBe(true);
    expect(result.outcome).toBe("unstable");
    expect(result.summary.flaky).toBe(2);
    expect(result.tests.map((entry) => ({
      method: entry.method,
      classification: entry.classification,
      passCount: entry.passCount,
      failCount: entry.failCount,
    }))).toEqual([
      { method: "A", classification: "flaky", passCount: 2, failCount: 1 },
      { method: "B", classification: "flaky", passCount: 2, failCount: 1 },
    ]);
    expect(result.diffs[0]).toEqual({
      fromRun: 1,
      toRun: 2,
      passed: {
        added: [{ codeunitId: 50100, method: "B" }],
        removed: [{ codeunitId: 50100, method: "A" }],
      },
      failed: {
        added: [{ codeunitId: 50100, method: "A" }],
        removed: [{ codeunitId: 50100, method: "B" }],
      },
      changed: [
        { codeunitId: 50100, method: "A", from: "passed", to: "failed" },
        { codeunitId: 50100, method: "B", from: "failed", to: "passed" },
      ],
    });
    expect(result.diffs[1]).toEqual({
      fromRun: 2,
      toRun: 3,
      passed: {
        added: [{ codeunitId: 50100, method: "A" }],
        removed: [],
      },
      failed: {
        added: [],
        removed: [{ codeunitId: 50100, method: "A" }],
      },
      changed: [
        { codeunitId: 50100, method: "A", from: "failed", to: "passed" },
      ],
    });
  });

  test("distinguishes skipped-status inconsistency from pass/fail flakiness", () => {
    const result = analyzeTestOrchestration([{ id: 50100 }], [
      run([row("SometimesSkipped", "passed")]),
      run([row("SometimesSkipped", "skipped")]),
      run([row("SometimesSkipped", "passed")]),
    ], 3);

    expect(result).toMatchObject({
      complete: true,
      outcome: "unstable",
      summary: { flaky: 0, inconsistent: 1, incomplete: 0 },
    });
    expect(result.tests[0]).toMatchObject({
      classification: "inconsistent",
      passCount: 2,
      skipCount: 1,
    });
  });

  test("fails missing, duplicate, empty, and aborted evidence closed", () => {
    const result = analyzeTestOrchestration(
      [{ id: 50100, methods: ["NeverReported", "Duplicate"] }],
      [
        run([
          row("Duplicate", "passed"),
          row("duplicate", "failed"),
          row("", "passed"),
        ]),
        run([row("", "failed")], { aborted: true }),
      ],
      2,
    );

    expect(result.complete).toBe(false);
    expect(result.outcome).toBe("incomplete");
    expect(result.tests).toEqual([
      {
        codeunitId: 50100,
        method: "Duplicate",
        classification: "incomplete",
        complete: false,
        passCount: 0,
        failCount: 0,
        skipCount: 0,
        missingCount: 1,
        ambiguousCount: 1,
        observations: [
          { run: 1, status: "ambiguous", durationMs: null },
          { run: 2, status: "missing", durationMs: null },
        ],
      },
      {
        codeunitId: 50100,
        method: "NeverReported",
        classification: "incomplete",
        complete: false,
        passCount: 0,
        failCount: 0,
        skipCount: 0,
        missingCount: 2,
        ambiguousCount: 0,
        observations: [
          { run: 1, status: "missing", durationMs: null },
          { run: 2, status: "missing", durationMs: null },
        ],
      },
    ]);
    expect(result.warnings.join("\n")).toContain("Run 2 aborted");
    expect(result.warnings.join("\n")).toContain("Run 2 reported no real test methods");
    expect(result.warnings.join("\n")).toContain("observation is ambiguous");
    expect(result.warnings.join("\n")).toContain("2 test identities");
  });

  test("matches requested and reported method spellings case-insensitively", () => {
    const result = analyzeTestOrchestration(
      [{ id: 50100, methods: ["mIxEd"] }],
      [
        run([row("Mixed", "passed", 1)]),
        run([row("MIXED", "passed", 2)]),
      ],
      2,
    );

    expect(result.complete).toBe(true);
    expect(result.tests).toEqual([{
      codeunitId: 50100,
      method: "mIxEd",
      classification: "stablePassed",
      complete: true,
      passCount: 2,
      failCount: 0,
      skipCount: 0,
      missingCount: 0,
      ambiguousCount: 0,
      observations: [
        { run: 1, status: "passed", durationMs: 1 },
        { run: 2, status: "passed", durationMs: 2 },
      ],
    }]);
  });

  test("retains positive flaky evidence while marking a missing run incomplete", () => {
    const result = analyzeTestOrchestration(
      [{ id: 50100, methods: ["Intermittent"] }],
      [
        run([row("Intermittent", "passed")]),
        run([]),
        run([row("Intermittent", "failed")]),
      ],
      3,
    );

    expect(result.complete).toBe(false);
    expect(result.outcome).toBe("incomplete");
    expect(result.tests[0]).toMatchObject({
      classification: "flaky",
      complete: false,
      passCount: 1,
      failCount: 1,
      missingCount: 1,
    });
  });

  test("reports fewer returned runs without inventing observations", () => {
    const result = analyzeTestOrchestration(
      [{ id: 50100, methods: ["A"] }],
      [run([row("A", "passed")])],
      3,
    );
    expect(result).toMatchObject({
      runsRequested: 3,
      runsCompleted: 1,
      complete: false,
      outcome: "incomplete",
    });
    expect(result.tests[0]?.observations).toHaveLength(1);
    expect(result.warnings[0]).toContain("Only 1 of 3");
  });
});
