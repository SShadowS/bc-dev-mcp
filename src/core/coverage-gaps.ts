import type { AlProcedureIdentity } from "./al-procedures";
import type { GitChangeSet, ChangedLineRange } from "./git-changes";
import type { CoverageEntry, CoverageGapAnalysis, CoverageGapProcedure } from "./types";
import { AL_OBJECT_TYPE } from "./al-objects";

function intersectRanges(
  ranges: ChangedLineRange[],
  startLine: number,
  endLine: number,
): ChangedLineRange[] {
  return ranges
    .filter((range) => range.end >= startLine && range.start <= endLine)
    .map((range) => ({ start: Math.max(range.start, startLine), end: Math.min(range.end, endLine) }));
}

function procedureKey(objectType: number, objectId: number, methodId: number): string {
  return `${objectType}|${objectId}|${methodId}`;
}

function coveredProcedureTests(coverage: CoverageEntry[]): Map<string, Array<{ testObjectId: number; testMethodId: number }>> {
  const byProcedure = new Map<string, Array<{ testObjectId: number; testMethodId: number }>>();
  const add = (key: string, test: { testObjectId: number; testMethodId: number }) => {
    const tests = byProcedure.get(key) ?? [];
    if (!tests.some((candidate) => candidate.testObjectId === test.testObjectId && candidate.testMethodId === test.testMethodId)) {
      tests.push(test);
    }
    byProcedure.set(key, tests);
  };
  for (const entry of coverage) {
    const test = { testObjectId: entry.testObjectId, testMethodId: entry.testMethodId };
    // WIRE: TestRunCompleted Tests[].ApplicationObjectId/MethodId identifies the executed
    // test procedure itself; CoveredProcedures is the separate list called by that test
    // (AL Development Tools 17.0.34.45391 TestRunCompleted payload, live BC28/SaaS).
    add(procedureKey(AL_OBJECT_TYPE.codeunit!, entry.testObjectId, entry.testMethodId), test);
    for (const procedure of entry.coveredProcedures) {
      add(procedureKey(procedure.objectType, procedure.objectId, procedure.methodId), test);
    }
  }
  return byProcedure;
}

export function analyzeCoverageGaps(
  changes: GitChangeSet,
  discovered: { procedures: AlProcedureIdentity[]; warnings?: string[] },
  coverage: CoverageEntry[],
  runAborted = false,
): CoverageGapAnalysis {
  const changeByFile = new Map(changes.files.map((file) => [file.relativeFile, file.ranges]));
  const coveredBy = coveredProcedureTests(coverage);
  const procedures: CoverageGapProcedure[] = [];
  const warnings = [...(discovered.warnings ?? [])];

  for (const procedure of discovered.procedures) {
    const ranges = changeByFile.get(procedure.relativeFile) ?? [];
    const changedRanges = intersectRanges(ranges, procedure.startLine, procedure.endLine);
    if (changedRanges.length === 0) continue;

    const tests = procedure.methodId === null
      ? []
      : (coveredBy.get(procedureKey(procedure.objectType, procedure.objectId, procedure.methodId)) ?? []);
    let status: CoverageGapProcedure["status"];
    let warning = procedure.identityWarning;
    if (tests.length > 0) status = "covered";
    else if (procedure.methodId === null) status = "unknown";
    else if (runAborted) {
      status = "unknown";
      warning = "The test run was aborted, so absence from its partial coverage cannot prove this procedure was not exercised.";
    } else status = "uncovered";

    if (status === "unknown" && warning) {
      warnings.push(`${procedure.relativeFile}:${procedure.startLine} ${procedure.name}: ${warning}`);
    }
    procedures.push({
      status,
      file: procedure.file,
      relativeFile: procedure.relativeFile,
      objectType: procedure.objectType,
      objectId: procedure.objectId,
      objectName: procedure.objectName,
      name: procedure.name,
      startLine: procedure.startLine,
      endLine: procedure.endLine,
      methodId: procedure.methodId,
      changedRanges,
      coveredBy: tests,
      ...(warning === undefined ? {} : { warning }),
    });
  }

  procedures.sort((a, b) => a.relativeFile.localeCompare(b.relativeFile) || a.startLine - b.startLine || a.name.localeCompare(b.name));
  const covered = procedures.filter((procedure) => procedure.status === "covered").length;
  const uncovered = procedures.filter((procedure) => procedure.status === "uncovered").length;
  const unknown = procedures.filter((procedure) => procedure.status === "unknown").length;
  return {
    baseRef: changes.baseRef,
    mergeBase: changes.mergeBase,
    head: changes.head,
    complete: !runAborted && unknown === 0,
    summary: {
      changedFiles: changes.files.length,
      changedProcedures: procedures.length,
      covered,
      uncovered,
      unknown,
    },
    procedures,
    warnings: [...new Set(warnings)],
  };
}
