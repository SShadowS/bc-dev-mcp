import type { AlProcedureIdentity, AlUnattributedCode, AlUnsupportedExecutable, TestMethodIdentity } from "./al-procedures";
import { AL_OBJECT_TYPE } from "./al-objects";
import { reverseReachable, type CallGraph } from "./call-graph";
import type { CoverageMap } from "./coverage-map";
import type { ChangedLineRange, GitChangeSet } from "./git-changes";

/*
 * Diff-scoped test selection (epic c03, child 6). Pure: the caller supplies the git change set,
 * procedure discovery over the changed files, the project's test methods, the call graph and an
 * optional recorded coverage map. Static reachability over-approximates (event/interface fan-out)
 * and coverage history under-approximates (stale or new code); the selection is their union, so
 * no reaching test is dropped. Output is sorted, so identical inputs give identical output.
 */

/** `event` covers every indirect static path (Event, Interface, Run or Trigger edge). */
export type SelectionReason = "direct" | "event" | "coverage-history" | "new-test";

export interface ChangedProcedureRef {
  objectType: number;
  objectId: number;
  objectName: string;
  name: string;
  methodId: number | null;
  relativeFile: string;
  startLine: number;
}

export interface SelectedTest {
  codeunitId: number;
  method: string;
  /** Strongest evidence; `reasons` lists all of it. */
  reason: SelectionReason;
  reasons: SelectionReason[];
  /** 0-1: new-test 1, static and history agree 0.95, direct 0.9, coverage-history 0.8, event only 0.5. */
  confidence: number;
  /** Changed procedures this test reaches, as "ObjectName.Procedure". */
  reaches: string[];
}

export interface TestShard {
  codeunits: Array<{ id: number; methods: string[] }>;
}

export interface TestSelection {
  selection: SelectedTest[];
  /** Changed non-test procedures that no test reaches statically or by coverage history. */
  uncoverable: ChangedProcedureRef[];
  changedProcedures: ChangedProcedureRef[];
  /** Codeunit-grouped run plan in rank order; `{id, methods}` matches bcdev_test_run `codeunits`. Covers every test when fallbackToAll. */
  shards: TestShard[];
  /** The diff touches something the selection cannot see; run the whole suite. */
  fallbackToAll: boolean;
  fallbackReasons: string[];
  warnings: string[];
}

export interface TestSelectionInput {
  changes: GitChangeSet;
  /** Procedure discovery over the changed AL files. */
  discovered: {
    procedures: AlProcedureIdentity[];
    unsupportedExecutables?: AlUnsupportedExecutable[];
    unattributedCode?: AlUnattributedCode[];
    complete?: boolean;
  };
  /** Every [Test] method of the project (discoverTestMethodIdentities). */
  tests: TestMethodIdentity[];
  graph: CallGraph;
  coverageMap?: CoverageMap | null;
  /** Maximum test codeunits per shard (default: one shard). */
  maxCodeunitsPerShard?: number;
}

const SCORE: Record<SelectionReason, number> = { "new-test": 1, direct: 0.9, "coverage-history": 0.8, event: 0.5 };
const AGREEMENT_SCORE = 0.95;
const NODE_IDENTITY = / \/ (\w+) (\d+) .* # (.+)#(-?\d+)$/;

const key = (objectType: number, objectId: number, methodId: number) => `${objectType}|${objectId}|${methodId}`;
const nameKey = (objectType: number, objectId: number, name: string) => `${objectType}|${objectId}|${name.toLowerCase()}`;
const testKey = (codeunitId: number, method: string) => `${codeunitId}|${method.toLowerCase()}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const overlaps = (ranges: ChangedLineRange[], start: number, end: number) =>
  ranges.some((range) => range.end >= start && range.start <= end);

/** Indexes graph method nodes by compiler identity and by name (the altool id suffix is the methodId). */
function indexGraph(graph: CallGraph) {
  const byId = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, k: string, id: string) => map.set(k, [...(map.get(k) ?? []), id]);
  for (const node of graph.nodes) {
    const match = NODE_IDENTITY.exec(node.id);
    const objectType = match ? AL_OBJECT_TYPE[match[1]!.toLowerCase()] : undefined;
    if (!match || objectType === undefined) continue;
    add(byId, key(objectType, Number(match[2]), Number(match[4])), node.id);
    add(byName, nameKey(objectType, Number(match[2]), match[3]!), node.id);
  }
  return (objectType: number, objectId: number, methodId: number | null, name: string) =>
    (methodId === null ? undefined : byId.get(key(objectType, objectId, methodId))) ?? byName.get(nameKey(objectType, objectId, name)) ?? [];
}

const label = (p: { objectName: string; name: string }) => `${p.objectName}.${p.name}`;

export function selectTests(input: TestSelectionInput): TestSelection {
  const { changes, discovered, tests, graph, coverageMap } = input;
  const fallbackReasons: string[] = [];
  const warnings: string[] = [];
  const rangesOf = new Map(changes.files.map((file) => [file.relativeFile, file.ranges]));
  const changedIn = (item: { relativeFile: string; startLine: number; endLine: number }) =>
    overlaps(rangesOf.get(item.relativeFile) ?? [], item.startLine, item.endLine);

  if (changes.nonAlFiles.length > 0) fallbackReasons.push(`Non-AL files changed: ${changes.nonAlFiles.join(", ")}`);
  if (changes.unresolvedAlFiles.length > 0) fallbackReasons.push(`AL files changed without current lines (deleted, binary or mode-only): ${changes.unresolvedAlFiles.join(", ")}`);
  if (discovered.complete === false) fallbackReasons.push("AL procedure discovery was incomplete for the changed files");
  for (const trigger of (discovered.unsupportedExecutables ?? []).filter(changedIn)) {
    fallbackReasons.push(`Changed ${trigger.kind} ${trigger.objectName}.${trigger.name} (${trigger.relativeFile}:${trigger.startLine}) has no procedure identity`);
  }
  for (const code of discovered.unattributedCode ?? []) {
    const lines = code.lines.filter((line) => overlaps(rangesOf.get(code.relativeFile) ?? [], line, line));
    if (lines.length > 0) fallbackReasons.push(`Changed lines ${lines.join(", ")} in ${code.relativeFile} belong to no procedure (properties, declarations or globals)`);
  }

  const testByKey = new Map(tests.map((test) => [testKey(test.codeunitId, test.method), test]));
  const testByIdentity = new Map(tests.flatMap((test) => (test.methodId === null ? [] : [[key(AL_OBJECT_TYPE.codeunit!, test.codeunitId, test.methodId), test] as const])));
  const nodesFor = indexGraph(graph);
  const testByNode = new Map<string, TestMethodIdentity>();
  for (const test of tests) {
    for (const id of nodesFor(AL_OBJECT_TYPE.codeunit!, test.codeunitId, test.methodId, test.method)) testByNode.set(id, test);
  }

  const changed = discovered.procedures.filter(changedIn).sort((a, b) =>
    compare(a.relativeFile, b.relativeFile) || a.startLine - b.startLine || compare(a.name, b.name));
  const changedProcedures: ChangedProcedureRef[] = changed.map((p) => ({
    objectType: p.objectType, objectId: p.objectId, objectName: p.objectName, name: p.name,
    methodId: p.methodId, relativeFile: p.relativeFile, startLine: p.startLine,
  }));

  const evidence = new Map<string, { test: TestMethodIdentity; reasons: Set<SelectionReason>; reaches: Set<string> }>();
  const note = (test: TestMethodIdentity, reason: SelectionReason, procedure: string) => {
    const k = testKey(test.codeunitId, test.method);
    const slot = evidence.get(k) ?? { test, reasons: new Set(), reaches: new Set() };
    slot.reasons.add(reason);
    slot.reaches.add(procedure);
    evidence.set(k, slot);
  };

  const historyByProcedure = new Map<string, TestMethodIdentity[]>();
  if (coverageMap) {
    if (!coverageMap.complete) warnings.push("The coverage map is incomplete (aborted run or missing payload); history may miss tests.");
    for (const entry of coverageMap.tests) {
      const test = testByIdentity.get(key(AL_OBJECT_TYPE.codeunit!, entry.codeunitId, entry.methodId))
        ?? (entry.method === null ? undefined : testByKey.get(testKey(entry.codeunitId, entry.method)));
      if (!test) continue; // test no longer exists in the project
      for (const p of entry.procedures) {
        const k = key(p.objectType, p.objectId, p.methodId);
        historyByProcedure.set(k, [...(historyByProcedure.get(k) ?? []), test]);
      }
    }
  } else {
    warnings.push("No coverage map supplied; selection uses static reachability only.");
  }
  const mapped = new Set(coverageMap?.tests.map((entry) => key(AL_OBJECT_TYPE.codeunit!, entry.codeunitId, entry.methodId)) ?? []);

  const uncoverable: ChangedProcedureRef[] = [];
  changed.forEach((procedure, index) => {
    const name = label(procedure);
    const ownTest = procedure.objectType === AL_OBJECT_TYPE.codeunit
      ? testByKey.get(testKey(procedure.objectId, procedure.name))
      : undefined;
    if (ownTest) {
      const known = ownTest.methodId !== null && mapped.has(key(AL_OBJECT_TYPE.codeunit!, ownTest.codeunitId, ownTest.methodId));
      note(ownTest, known ? "direct" : "new-test", name);
      return;
    }
    let reached = false;
    const nodes = nodesFor(procedure.objectType, procedure.objectId, procedure.methodId, procedure.name);
    if (nodes.length === 0) {
      fallbackReasons.push(`Changed procedure ${name} (${procedure.relativeFile}:${procedure.startLine}) is not in the call graph`);
    }
    for (const [id, how] of reverseReachable(graph, nodes)) {
      const test = testByNode.get(id);
      if (!test) continue;
      note(test, how === "direct" ? "direct" : "event", name);
      reached = true;
    }
    if (procedure.methodId !== null) {
      for (const test of historyByProcedure.get(key(procedure.objectType, procedure.objectId, procedure.methodId)) ?? []) {
        note(test, "coverage-history", name);
        reached = true;
      }
    }
    if (!reached) uncoverable.push(changedProcedures[index]!);
  });

  const selection: SelectedTest[] = [...evidence.values()].map(({ test, reasons, reaches }) => {
    const ordered = (Object.keys(SCORE) as SelectionReason[]).filter((reason) => reasons.has(reason));
    const reason = ordered[0]!;
    const agree = reasons.has("coverage-history") && (reasons.has("direct") || reasons.has("event"));
    return {
      codeunitId: test.codeunitId,
      method: test.method,
      reason,
      reasons: ordered,
      confidence: reason === "new-test" ? 1 : agree ? AGREEMENT_SCORE : SCORE[reason],
      reaches: [...reaches].sort(compare),
    };
  });
  selection.sort((a, b) =>
    b.confidence - a.confidence || b.reaches.length - a.reaches.length || a.codeunitId - b.codeunitId || compare(a.method, b.method));

  const fallbackToAll = fallbackReasons.length > 0;
  const runList = fallbackToAll
    ? [...tests].sort((a, b) => a.codeunitId - b.codeunitId || compare(a.method, b.method))
    : selection;
  return {
    selection,
    uncoverable,
    changedProcedures,
    shards: shard(runList, input.maxCodeunitsPerShard),
    fallbackToAll,
    fallbackReasons,
    warnings,
  };
}

function shard(run: Array<{ codeunitId: number; method: string }>, maxCodeunits = Number.POSITIVE_INFINITY): TestShard[] {
  const groups = new Map<number, string[]>();
  for (const { codeunitId, method } of run) groups.set(codeunitId, [...(groups.get(codeunitId) ?? []), method]);
  const size = Math.max(1, Math.floor(maxCodeunits));
  const codeunits = [...groups].map(([id, methods]) => ({ id, methods }));
  const shards: TestShard[] = [];
  for (let i = 0; i < codeunits.length; i += size) shards.push({ codeunits: codeunits.slice(i, i + size) });
  return shards;
}
