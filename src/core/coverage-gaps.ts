import type { AlProcedureIdentity, AlUnattributedCode, AlUnsupportedExecutable } from "./al-procedures";
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

function intersectLines(ranges: ChangedLineRange[], lines: number[]): number[] {
  return lines.filter((line) => ranges.some((range) => line >= range.start && line <= range.end));
}

function objectLabel(entry: AlUnattributedCode): string {
  if (entry.objectId === null) return "file-level declarations";
  const typeName = Object.keys(AL_OBJECT_TYPE).find((name) => AL_OBJECT_TYPE[name] === entry.objectType);
  return `${typeName ?? `objectType ${entry.objectType}`} ${entry.objectId} ${entry.objectName}`;
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
  discovered: {
    procedures: AlProcedureIdentity[];
    unsupportedExecutables?: AlUnsupportedExecutable[];
    unattributedCode?: AlUnattributedCode[];
    warnings?: string[];
    complete?: boolean;
  },
  coverage: CoverageEntry[] | undefined,
  runAborted = false,
  changesDeployed = false,
  coverageComplete = coverage !== undefined,
): CoverageGapAnalysis {
  // WIRE: TestRunCompleted carries test/procedure object and method identities, but no package
  // version, artifact hash, or source hash. Deployment freshness therefore must be asserted by
  // the caller and is never represented as tool-verified by this payload.
  const changeByFile = new Map(changes.files.map((file) => [file.relativeFile, file.ranges]));
  const coveredBy = coveredProcedureTests(coverage ?? []);
  const procedures: CoverageGapProcedure[] = [];
  const warnings = [...(discovered.warnings ?? [])];
  const changedUnsupportedExecutables = (discovered.unsupportedExecutables ?? []).flatMap((executable) => {
    const ranges = changeByFile.get(executable.relativeFile) ?? [];
    const changedRanges = intersectRanges(ranges, executable.startLine, executable.endLine);
    return changedRanges.length === 0 ? [] : [{ executable, changedRanges }];
  });
  for (const { executable, changedRanges } of changedUnsupportedExecutables) {
    warnings.push(
      `${executable.relativeFile}:${executable.startLine} ${executable.kind} ${executable.name}: ` +
      `${executable.warning} Changed lines ${changedRanges.map((range) => `${range.start}-${range.end}`).join(", ")} remain unknown.`,
    );
  }
  // Procedure coverage can only speak about procedures. Changed code that carries no method
  // identity — properties, field and control declarations, global variables, object headers,
  // namespace and using declarations — is reported and blocks `complete` rather than being
  // silently excluded from the gate.
  const changedUnattributed = (discovered.unattributedCode ?? []).flatMap((entry) => {
    const lines = intersectLines(changeByFile.get(entry.relativeFile) ?? [], entry.lines);
    return lines.length === 0 ? [] : [{ entry, lines }];
  });
  for (const { entry, lines } of changedUnattributed) {
    warnings.push(
      `${entry.relativeFile}:${lines[0]} ${objectLabel(entry)}: changed lines ${lines.join(", ")} ` +
      `belong to no procedure or trigger, so procedure coverage cannot prove they were exercised.`,
    );
  }

  for (const procedure of discovered.procedures) {
    const ranges = changeByFile.get(procedure.relativeFile) ?? [];
    const changedRanges = intersectRanges(ranges, procedure.startLine, procedure.endLine);
    if (changedRanges.length === 0) continue;

    const tests = procedure.methodId === null
      ? []
      : (coveredBy.get(procedureKey(procedure.objectType, procedure.objectId, procedure.methodId)) ?? []);
    let status: CoverageGapProcedure["status"];
    let warning = procedure.identityWarning;
    if (!changesDeployed) {
      status = "unknown";
      warning = [
        warning,
        "Current working-tree changes were not asserted as deployed, so server coverage cannot prove this local procedure was exercised.",
      ].filter((part): part is string => part !== undefined).join(" ");
    } else if (tests.length > 0) status = "covered";
    else if (procedure.methodId === null) status = "unknown";
    else if (runAborted) {
      status = "unknown";
      warning = "The test run was aborted, so absence from its partial coverage cannot prove this procedure was not exercised.";
    } else if (!coverageComplete) {
      status = "unknown";
      warning = "Business Central did not return a complete procedure-coverage payload, so absence from the available evidence cannot prove this procedure was not exercised.";
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
  if (procedures.length > 0 && !changesDeployed) {
    warnings.push("Deployment is unverified. Publish the current changed objects, then rerun with changesDeployed: true only after confirming that deployment.");
  }
  if (discovered.complete === false) {
    warnings.push("AL procedure discovery was incomplete; coverageGaps cannot be used as a complete gate.");
  }
  if (changedUnsupportedExecutables.length > 0) {
    warnings.push("Changed executable triggers have unvalidated coverage identities; coverageGaps cannot be used as a complete gate.");
  }
  if (changedUnattributed.length > 0) {
    warnings.push("Changed lines carry no procedure identity; coverageGaps cannot be used as a complete gate.");
  }
  return {
    baseRef: changes.baseRef,
    mergeBase: changes.mergeBase,
    head: changes.head,
    deployment: {
      status: changesDeployed ? "asserted" : "unverified",
      verified: false,
    },
    complete: discovered.complete !== false && !runAborted && unknown === 0 &&
      changedUnsupportedExecutables.length === 0 && changedUnattributed.length === 0,
    summary: {
      changedFiles: changes.files.length,
      changedProcedures: procedures.length,
      covered,
      uncovered,
      unknown,
      unattributedChanges: changedUnattributed.length,
    },
    procedures,
    warnings: [...new Set(warnings)],
  };
}
