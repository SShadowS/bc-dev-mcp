import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichTestRun, parseTestFailure, summarizeTestRun } from "../../src/core/agent-results";
import { AlObjectIndex } from "../../src/core/al-objects";
import type { RunTestsResult } from "../../src/core/types";

describe("agent test results", () => {
  test("parses an AL call stack while preserving raw lines", () => {
    const failure = parseTestFailure(
      'Attempted to divide by zero.\r\nCallStack:\r\n"Demo Payment Split"(CodeUnit 50130).SplitAmount(Decimal,Integer) line 10 - Demo by Me\r\nlocalized frame text',
    );
    expect(failure.message).toBe("Attempted to divide by zero.");
    expect(failure.parsed).toBe(true);
    expect(failure.callStack).toEqual([
      {
        raw: '"Demo Payment Split"(CodeUnit 50130).SplitAmount(Decimal,Integer) line 10 - Demo by Me',
        objectType: 5,
        objectId: 50130,
        objectName: "Demo Payment Split",
        methodName: "SplitAmount",
        line: 10,
        file: null,
      },
      {
        raw: "localized frame text",
        objectType: null,
        objectId: null,
        objectName: null,
        methodName: null,
        line: null,
        file: null,
      },
    ]);
  });

  test("keeps an opaque failure as the message", () => {
    expect(parseTestFailure("Expected 2, got 3")).toEqual({
      message: "Expected 2, got 3",
      parsed: false,
      callStack: [],
    });
  });

  test("summarizes real methods and excludes synthetic rollup rows", () => {
    const result: RunTestsResult = {
      results: [
        { codeunitId: 1, method: "Pass", status: "passed", durationMs: 4, output: "" },
        { codeunitId: 1, method: "Fail", status: "failed", durationMs: 6, output: "boom" },
        { codeunitId: 1, method: "Skip", status: "skipped", durationMs: 1, output: "" },
        { codeunitId: 1, method: "", status: "failed", durationMs: 99, output: "rollup" },
      ],
    };
    expect(summarizeTestRun(result)).toEqual({
      outcome: "failed",
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      durationMs: 11,
      syntheticResults: 1,
      failedTests: [{ codeunitId: 1, method: "Fail" }],
    });
    result.runAborted = true;
    expect(summarizeTestRun(result).outcome).toBe("aborted");
  });

  test("maps parsed frames to local AL files", async () => {
    const project = mkdtempSync(join(tmpdir(), "bc-agent-results-"));
    const file = join(project, "Demo.Codeunit.al");
    writeFileSync(file, 'codeunit 50130 "Demo Payment Split"\n{\n}\n');
    const index = await AlObjectIndex.build(project);
    const result: RunTestsResult = {
      results: [{
        codeunitId: 50131,
        method: "Fails",
        status: "failed",
        durationMs: 3,
        output: 'boom\nCallStack:\n"Demo Payment Split"(CodeUnit 50130).SplitAmount() line 10',
      }],
    };
    enrichTestRun(result, index);
    expect(result.summary?.outcome).toBe("failed");
    expect(result.results[0]?.failure?.callStack[0]?.file).toBe(file);
  });

  test("does not materialize the optional failure key on non-failed rows", () => {
    const result = enrichTestRun({
      results: [{ codeunitId: 50100, method: "Passes", status: "passed", durationMs: 1, output: "", failure: undefined }],
    });
    expect(Object.hasOwn(result.results[0]!, "failure")).toBe(false);
  });
});
