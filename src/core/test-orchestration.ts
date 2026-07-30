import type {
  CodeunitTestGroup,
  RunTestsResult,
  TestMethodResult,
  TestStatus,
} from "./types";

export type TestObservationStatus = TestStatus | "missing" | "ambiguous";
export type TestStabilityClassification =
  | "stablePassed"
  | "stableFailed"
  | "stableSkipped"
  | "flaky"
  | "inconsistent"
  | "incomplete";
export type TestOrchestrationOutcome = "passed" | "failed" | "unstable" | "incomplete";

export interface OrchestratedTestIdentity {
  codeunitId: number;
  method: string;
}

export interface TestRunObservation {
  run: number;
  status: TestObservationStatus;
  durationMs: number | null;
}

export interface OrchestratedTestCase extends OrchestratedTestIdentity {
  classification: TestStabilityClassification;
  complete: boolean;
  passCount: number;
  failCount: number;
  skipCount: number;
  missingCount: number;
  ambiguousCount: number;
  observations: TestRunObservation[];
}

export interface TestStatusSetDiff {
  added: OrchestratedTestIdentity[];
  removed: OrchestratedTestIdentity[];
}

export interface TestObservationChange extends OrchestratedTestIdentity {
  from: TestObservationStatus;
  to: TestObservationStatus;
}

export interface TestRunDiff {
  fromRun: number;
  toRun: number;
  passed: TestStatusSetDiff;
  failed: TestStatusSetDiff;
  changed: TestObservationChange[];
}

export interface TestOrchestrationSummary {
  tests: number;
  stablePassed: number;
  stableFailed: number;
  stableSkipped: number;
  flaky: number;
  inconsistent: number;
  incomplete: number;
  totalDurationMs: number;
}

export interface TestOrchestrationAnalysis {
  runsRequested: number;
  runsCompleted: number;
  complete: boolean;
  outcome: TestOrchestrationOutcome;
  summary: TestOrchestrationSummary;
  tests: OrchestratedTestCase[];
  diffs: TestRunDiff[];
  warnings: string[];
}

interface IdentityRecord extends OrchestratedTestIdentity {
  key: string;
}

// AL identifiers are case-insensitive. Keep the transformation length-preserving so legal
// quoted identifiers such as "Größe" are not silently expanded (matching the compiler-facing
// normalization used by the procedure identity engine).
function upperInvariantUtf16(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const unit = value[index]!;
    const upper = unit.toUpperCase();
    result += upper.length === 1 ? upper : unit;
  }
  return result;
}

function identityKey(codeunitId: number, method: string): string {
  return `${codeunitId}\u0000${upperInvariantUtf16(method.trim())}`;
}

function compareIdentity(left: OrchestratedTestIdentity, right: OrchestratedTestIdentity): number {
  if (left.codeunitId !== right.codeunitId) return left.codeunitId - right.codeunitId;
  if (left.method === right.method) return 0;
  return left.method < right.method ? -1 : 1;
}

function realRows(run: RunTestsResult): TestMethodResult[] {
  return run.results.filter((row) => row.method.trim() !== "");
}

function classify(observations: TestRunObservation[]): TestStabilityClassification {
  const statuses = new Set(observations.map((entry) => entry.status));
  if (statuses.has("passed") && statuses.has("failed")) return "flaky";
  if (statuses.has("missing") || statuses.has("ambiguous")) return "incomplete";
  if (statuses.size === 1) {
    if (statuses.has("passed")) return "stablePassed";
    if (statuses.has("failed")) return "stableFailed";
    if (statuses.has("skipped")) return "stableSkipped";
  }
  return "inconsistent";
}

function identity(record: IdentityRecord): OrchestratedTestIdentity {
  return { codeunitId: record.codeunitId, method: record.method };
}

function statusSet(
  tests: OrchestratedTestCase[],
  observationIndex: number,
  status: TestStatus,
): Set<string> {
  return new Set(
    tests
      .filter((test) => test.observations[observationIndex]?.status === status)
      .map((test) => identityKey(test.codeunitId, test.method)),
  );
}

function setDifference(
  left: Set<string>,
  right: Set<string>,
  identities: Map<string, IdentityRecord>,
): OrchestratedTestIdentity[] {
  return [...left]
    .filter((key) => !right.has(key))
    .map((key) => identity(identities.get(key)!))
    .sort(compareIdentity);
}

export function analyzeTestOrchestration(
  plan: CodeunitTestGroup[],
  runs: RunTestsResult[],
  runsRequested: number,
): TestOrchestrationAnalysis {
  const warnings: string[] = [];
  const identities = new Map<string, IdentityRecord>();

  const remember = (codeunitId: number, method: string) => {
    const normalized = method.trim();
    if (normalized === "") return;
    const key = identityKey(codeunitId, normalized);
    if (!identities.has(key)) identities.set(key, { key, codeunitId, method: normalized });
  };

  for (const group of plan) {
    if ((group.methods?.length ?? 0) > 0) {
      for (const method of group.methods ?? []) remember(group.id, method);
    }
  }

  const rowsByRun = runs.map((run) => {
    const rows = new Map<string, TestMethodResult[]>();
    for (const row of realRows(run)) {
      remember(row.codeunitId, row.method);
      const key = identityKey(row.codeunitId, row.method);
      const existing = rows.get(key);
      if (existing) existing.push(row);
      else rows.set(key, [row]);
    }
    return rows;
  });

  if (runs.length !== runsRequested) {
    warnings.push(`Only ${runs.length} of ${runsRequested} requested runs returned a result.`);
  }
  runs.forEach((run, index) => {
    if (run.runAborted === true) {
      const stoppedEarly = index === runs.length - 1 && runs.length < runsRequested;
      warnings.push(
        stoppedEarly
          ? `Run ${index + 1} aborted; later requested runs were not started because server-side cancellation could not be confirmed safely.`
          : `Run ${index + 1} aborted; its observations cannot establish complete stability.`,
      );
    }
    if (realRows(run).length === 0) {
      warnings.push(`Run ${index + 1} reported no real test methods.`);
    }
  });

  const tests: OrchestratedTestCase[] = [...identities.values()]
    .sort(compareIdentity)
    .map((testIdentity) => {
      const observations = Array.from({ length: runsRequested }, (_, index): TestRunObservation => {
        const rows = rowsByRun[index];
        if (!rows) {
          return { run: index + 1, status: "missing", durationMs: null };
        }
        const matches = rows.get(testIdentity.key) ?? [];
        if (matches.length === 0) {
          return { run: index + 1, status: "missing", durationMs: null };
        }
        if (matches.length > 1) {
          warnings.push(
            `Run ${index + 1} reported ${matches.length} rows for `
            + `${testIdentity.codeunitId}.${testIdentity.method}; that observation is ambiguous.`,
          );
          return { run: index + 1, status: "ambiguous", durationMs: null };
        }
        const row = matches[0]!;
        return { run: index + 1, status: row.status, durationMs: row.durationMs };
      });
      const classification = classify(observations);
      return {
        codeunitId: testIdentity.codeunitId,
        method: testIdentity.method,
        classification,
        complete: observations.every((entry) =>
          entry.status !== "missing" && entry.status !== "ambiguous"),
        passCount: observations.filter((entry) => entry.status === "passed").length,
        failCount: observations.filter((entry) => entry.status === "failed").length,
        skipCount: observations.filter((entry) => entry.status === "skipped").length,
        missingCount: observations.filter((entry) => entry.status === "missing").length,
        ambiguousCount: observations.filter((entry) => entry.status === "ambiguous").length,
        observations,
      };
    });

  const incompleteTests = tests.filter((test) => !test.complete).length;
  if (incompleteTests > 0) {
    warnings.push(
      `${incompleteTests} test ${incompleteTests === 1 ? "identity has" : "identities have"} `
      + "a missing or ambiguous observation; inspect tests[].observations.",
    );
  }
  if (tests.length === 0) {
    warnings.push("No real or explicitly requested test method identity was available for comparison.");
  }

  const diffs: TestRunDiff[] = [];
  for (let index = 1; index < runs.length; index++) {
    const previousPassed = statusSet(tests, index - 1, "passed");
    const currentPassed = statusSet(tests, index, "passed");
    const previousFailed = statusSet(tests, index - 1, "failed");
    const currentFailed = statusSet(tests, index, "failed");
    const changed = tests
      .filter((test) => test.observations[index - 1]!.status !== test.observations[index]!.status)
      .map((test) => ({
        codeunitId: test.codeunitId,
        method: test.method,
        from: test.observations[index - 1]!.status,
        to: test.observations[index]!.status,
      }))
      .sort(compareIdentity);
    diffs.push({
      fromRun: index,
      toRun: index + 1,
      passed: {
        added: setDifference(currentPassed, previousPassed, identities),
        removed: setDifference(previousPassed, currentPassed, identities),
      },
      failed: {
        added: setDifference(currentFailed, previousFailed, identities),
        removed: setDifference(previousFailed, currentFailed, identities),
      },
      changed,
    });
  }

  const summary: TestOrchestrationSummary = {
    tests: tests.length,
    stablePassed: tests.filter((test) => test.classification === "stablePassed").length,
    stableFailed: tests.filter((test) => test.classification === "stableFailed").length,
    stableSkipped: tests.filter((test) => test.classification === "stableSkipped").length,
    flaky: tests.filter((test) => test.classification === "flaky").length,
    inconsistent: tests.filter((test) => test.classification === "inconsistent").length,
    incomplete: tests.filter((test) => test.classification === "incomplete").length,
    totalDurationMs: runs
      .flatMap(realRows)
      .reduce((total, row) => total + row.durationMs, 0),
  };
  const complete = runs.length === runsRequested
    && runs.every((run) => run.runAborted !== true)
    && tests.length > 0
    && tests.every((test) => test.complete);
  const outcome: TestOrchestrationOutcome = !complete
    ? "incomplete"
    : summary.flaky > 0 || summary.inconsistent > 0
      ? "unstable"
      : summary.stableFailed > 0
        ? "failed"
        : "passed";

  return {
    runsRequested,
    runsCompleted: runs.length,
    complete,
    outcome,
    summary,
    tests,
    diffs,
    warnings,
  };
}
