import { AL_OBJECT_TYPE, type AlObjectIndex } from "./al-objects";
import type { RunTestsResult, TestCallStackFrame, TestFailure, TestRunSummary } from "./types";

const CALL_STACK_HEADER = /^\s*(?:al\s+)?call\s*stack\s*:?\s*$/i;
const FRAME = /^\s*"?(.+?)"?\s*\(([^)]+?)\s+(\d+)\)\.([^\r\n]+?)\s+line\s+(\d+)(?:\s+-.*)?$/i;

function objectTypeFromLabel(label: string): number | null {
  const key = label.toLowerCase().replace(/[^a-z]/g, "");
  return AL_OBJECT_TYPE[key] ?? null;
}

function parseFrame(raw: string): TestCallStackFrame {
  const match = FRAME.exec(raw);
  if (!match) {
    return { raw, objectType: null, objectId: null, objectName: null, methodName: null, line: null, file: null };
  }
  const methodWithArguments = match[4]!.trim();
  const methodName = methodWithArguments.replace(/\([^)]*\)\s*$/, "").trim();
  return {
    raw,
    objectType: objectTypeFromLabel(match[2]!),
    objectId: Number(match[3]),
    objectName: match[1]!.trim(),
    methodName: methodName || null,
    line: Number(match[5]),
    file: null,
  };
}

export function parseTestFailure(output: string): TestFailure {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  let stackStart = lines.findIndex((line) => CALL_STACK_HEADER.test(line));
  let hasHeader = stackStart >= 0;
  if (!hasHeader) {
    stackStart = lines.findIndex((line) => FRAME.test(line));
  }
  if (stackStart < 0) return { message: output.trim(), parsed: false, callStack: [] };
  const messageLines = lines.slice(0, stackStart);
  const frameLines = lines.slice(stackStart + (hasHeader ? 1 : 0)).filter((line) => line.trim() !== "");
  const callStack = frameLines.map(parseFrame);
  return {
    message: messageLines.join("\n").trim(),
    parsed: callStack.some((frame) => frame.objectId !== null || frame.methodName !== null || frame.line !== null),
    callStack,
  };
}

export function summarizeTestRun(result: RunTestsResult): TestRunSummary {
  const real = result.results.filter((row) => row.method.trim() !== "");
  const passed = real.filter((row) => row.status === "passed").length;
  const failed = real.filter((row) => row.status === "failed").length;
  const skipped = real.filter((row) => row.status === "skipped").length;
  return {
    outcome: result.runAborted ? "aborted" : failed > 0 ? "failed" : "passed",
    total: real.length,
    passed,
    failed,
    skipped,
    durationMs: real.reduce((sum, row) => sum + row.durationMs, 0),
    syntheticResults: result.results.length - real.length,
    failedTests: real.filter((row) => row.status === "failed").map((row) => ({ codeunitId: row.codeunitId, method: row.method })),
  };
}

export function testRunNeedsSourceMapping(result: RunTestsResult): boolean {
  return result.results.some((row) => row.failure?.callStack.some((frame) => frame.objectType !== null && frame.objectId !== null));
}

export function mapTestRunSources(result: RunTestsResult, index: AlObjectIndex): RunTestsResult {
  for (const row of result.results) {
    for (const frame of row.failure?.callStack ?? []) {
      if (frame.objectType !== null && frame.objectId !== null) {
        frame.file = index.byId(frame.objectType, frame.objectId)?.file ?? null;
      }
    }
  }
  return result;
}

export function enrichTestRun(result: RunTestsResult, index?: AlObjectIndex): RunTestsResult {
  for (const row of result.results) {
    if (row.status === "failed") row.failure = parseTestFailure(row.output);
    else delete row.failure;
  }
  result.summary = summarizeTestRun(result);
  if (index) mapTestRunSources(result, index);
  return result;
}
