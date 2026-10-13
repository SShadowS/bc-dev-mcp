import type { AlProcedureIdentity, AlUnattributedCode, AlUnsupportedExecutable, TestMethodIdentity } from "./al-procedures";
import { AL_OBJECT_TYPE } from "./al-objects";
import { reverseReachable, type CallGraph, type CallGraphNode } from "./call-graph";
import type { CoverageMap } from "./coverage-map";
import type { ChangedLineRange, GitChangeSet } from "./git-changes";

/*
 * Diff-scoped test selection (epic c03, child 6). Pure: the caller supplies the git change set,
 * procedure discovery over the changed files, the project's test methods, the call graph and an
 * optional recorded coverage map. Static reachability over-approximates (event/interface fan-out)
 * and coverage history under-approximates (stale or new code); the selection is their union, so
 * no reaching test is dropped. Output is sorted, so identical inputs give identical output.
 *
 * With an al-sem graph (schema al-sem.callgraph v1) changed procedures AND triggers join to graph
 * nodes by location, hub paths rank `dynamic`, and a node with hidden callers in a change's reverse
 * cone means static reachability is incomplete for it: coverage history must cover the change, or
 * selection falls back to the whole suite. "Uncoverable" is then a proof (under the graph's stated
 * assumptions); with altool it only means "no evidence".
 */

/** `event` covers every indirect static path (Event, Interface, Run or Trigger edge); `dynamic` a path through an al-sem hub. */
export type SelectionReason = "direct" | "event" | "coverage-history" | "new-test" | "dynamic";

export interface ChangedProcedureRef {
  /** Triggers are selected only with an al-sem graph; altool graphs have no trigger identity. */
  kind: "procedure" | "trigger";
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
  /** 0-1: new-test 1, static and history agree 0.95, direct 0.9, coverage-history 0.8, event only 0.5, dynamic only 0.3. */
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

const SCORE: Record<SelectionReason, number> = { "new-test": 1, direct: 0.9, "coverage-history": 0.8, event: 0.5, dynamic: 0.3 };
const AGREEMENT_SCORE = 0.95;
const NODE_IDENTITY = / \/ (\w+) (\d+) .* # (.+)#(-?\d+)$/;

/** The al-sem assumptions (`meta.assumptions`), in words. */
const ASSUMPTION_TEXT: Record<string, string> = {
  opaqueCodeRunsNoObjectsById: "symbol-only (no source) code is assumed not to run objects of this app by a runtime id",
  platformEntryPointsNotModelled: "code the platform starts on its own (session and company initialization, global triggers) has no caller in the graph",
};

const key = (objectType: number, objectId: number, methodId: number) => `${objectType}|${objectId}|${methodId}`;
const nameKey = (objectType: number, objectId: number, name: string) => `${objectType}|${objectId}|${name.toLowerCase()}`;
const testKey = (codeunitId: number, method: string) => `${codeunitId}|${method.toLowerCase()}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const overlaps = (ranges: ChangedLineRange[], start: number, end: number) =>
  ranges.some((range) => range.end >= start && range.start <= end);
/** Repo-relative path key: `/`-separated, case-folded on win32 (git's recorded case can differ from the disk's). */
const pathKey = (path: string) => {
  const slashed = path.split("\\").join("/").replace(/^\.\//, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
};
/** A node's member name compared the way discovery reads names: a doubled quote is one quote. */
const memberOf = (node: CallGraphNode) => (node.memberName ?? "").split('""').join('"').toLowerCase();

/** Indexes altool method nodes by compiler identity and by name (the altool id suffix is the methodId). */
function indexAltoolGraph(graph: CallGraph) {
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

interface Locatable {
  objectType: number;
  objectId: number;
  objectName: string;
  name: string;
  relativeFile: string;
  startLine: number;
  endLine: number;
}

/**
 * Joins discovered code to al-sem workspace nodes by location: the same sourcePath, the node's
 * `line` inside the discovered `[startLine, endLine]` (discovery starts at the first attribute,
 * al-sem at the keyword), and the same name. Falls back to every node of the object with the name,
 * with a warning; empty when neither finds a node.
 */
function indexAlSemGraph(graph: CallGraph) {
  const byPath = new Map<string, CallGraphNode[]>();
  const byName = new Map<string, CallGraphNode[]>();
  for (const node of graph.nodes) {
    if (node.dependency !== false || (node.kind !== "Method" && node.kind !== "Trigger")) continue;
    if (node.sourcePath !== undefined && node.line !== undefined) {
      const k = pathKey(node.sourcePath);
      byPath.set(k, [...(byPath.get(k) ?? []), node]);
    }
    const objectType = AL_OBJECT_TYPE[node.objectType.toLowerCase()];
    if (objectType !== undefined) {
      const k = nameKey(objectType, node.objectId, memberOf(node));
      byName.set(k, [...(byName.get(k) ?? []), node]);
    }
  }
  return (item: Locatable): { nodes: CallGraphNode[]; warning?: string } => {
    const located = (byPath.get(pathKey(item.relativeFile)) ?? []).filter((node) =>
      item.startLine <= node.line! && node.line! <= item.endLine && memberOf(node) === item.name.toLowerCase());
    if (located.length > 0) return { nodes: located };
    const named = byName.get(nameKey(item.objectType, item.objectId, item.name)) ?? [];
    if (named.length === 0) return { nodes: [] };
    return {
      nodes: named,
      warning: `${item.objectName}.${item.name} (${item.relativeFile}:${item.startLine}) has no call-graph node at its location; joined by name, so every overload of it counts.`,
    };
  };
}

const label = (p: { objectName: string; name: string }) => `${p.objectName}.${p.name}`;
const nodeLabel = (n: CallGraphNode) => (n.hub !== undefined ? n.id : `${n.objectName}.${n.memberName ?? n.kind}`);

type Changed = Locatable & { kind: "procedure" | "trigger"; methodId: number | null };

export function selectTests(input: TestSelectionInput): TestSelection {
  const { changes, discovered, tests, graph, coverageMap } = input;
  const alSem = graph.engine === "al-sem";
  const fallbackReasons: string[] = [];
  const warnings: string[] = [...(graph.warnings ?? [])];
  const rangesOf = new Map(changes.files.map((file) => [pathKey(file.relativeFile), file.ranges]));
  const changedIn = (item: { relativeFile: string; startLine: number; endLine: number }) =>
    overlaps(rangesOf.get(pathKey(item.relativeFile)) ?? [], item.startLine, item.endLine);

  if (changes.nonAlFiles.length > 0) fallbackReasons.push(`Non-AL files changed: ${changes.nonAlFiles.join(", ")}`);
  if (changes.unresolvedAlFiles.length > 0) fallbackReasons.push(`AL files changed without current lines (deleted, binary or mode-only): ${changes.unresolvedAlFiles.join(", ")}`);
  if (discovered.complete === false) fallbackReasons.push("AL procedure discovery was incomplete for the changed files");
  const changedTriggers = (discovered.unsupportedExecutables ?? []).filter(changedIn);
  if (!alSem) {
    for (const trigger of changedTriggers) {
      fallbackReasons.push(`Changed ${trigger.kind} ${trigger.objectName}.${trigger.name} (${trigger.relativeFile}:${trigger.startLine}) has no procedure identity`);
    }
  }
  for (const code of discovered.unattributedCode ?? []) {
    const lines = code.lines.filter((line) => overlaps(rangesOf.get(pathKey(code.relativeFile)) ?? [], line, line));
    if (lines.length > 0) fallbackReasons.push(`Changed lines ${lines.join(", ")} in ${code.relativeFile} belong to no procedure (properties, declarations or globals)`);
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const altoolNodes = alSem ? undefined : indexAltoolGraph(graph);
  const alSemNodes = alSem ? indexAlSemGraph(graph) : undefined;
  if (alSem && graph.meta) {
    const workspace = graph.meta.workspace?.name;
    const recovered = new Set(graph.meta.recoveredFiles.map((f) => pathKey(f)));
    for (const file of changes.files) {
      if (workspace !== undefined && recovered.has(pathKey(`${workspace}::${file.relativeFile}`))) {
        fallbackReasons.push(`Changed file ${file.relativeFile} did not parse cleanly for al-sem; its calls may be missing from the graph`);
      }
    }
    if (!graph.meta.coverageHolds) warnings.push("al-sem reported a coverage-contract failure (an engine defect); the affected routines are linked to the universal hub, so selection is coarser.");
    if (tests.length > 0 && !graph.nodes.some((node) => node.test === true)) {
      fallbackReasons.push(
        "The al-sem call graph has no [Test] method. The tests probably live in another app than the code they test (a separate test app), which selection does not support yet.",
      );
    }
  }

  const testByKey = new Map(tests.map((test) => [testKey(test.codeunitId, test.method), test]));
  const testByIdentity = new Map(tests.flatMap((test) => (test.methodId === null ? [] : [[key(AL_OBJECT_TYPE.codeunit!, test.codeunitId, test.methodId), test] as const])));
  const testByNode = new Map<string, TestMethodIdentity>();
  for (const test of tests) {
    let ids: string[];
    if (alSemNodes) {
      const found = test.relativeFile !== undefined && test.startLine !== undefined && test.endLine !== undefined
        ? alSemNodes({ objectType: AL_OBJECT_TYPE.codeunit!, objectId: test.codeunitId, objectName: test.codeunitName, name: test.method, relativeFile: test.relativeFile, startLine: test.startLine, endLine: test.endLine })
        : alSemNodes({ objectType: AL_OBJECT_TYPE.codeunit!, objectId: test.codeunitId, objectName: test.codeunitName, name: test.method, relativeFile: "", startLine: 0, endLine: -1 });
      ids = found.nodes.map((node) => node.id);
      for (const node of found.nodes.filter((n) => n.test !== true)) {
        warnings.push(`Test ${test.codeunitName}.${test.method} joined call-graph node ${node.id}, which al-sem does not mark as a test.`);
      }
    } else {
      ids = altoolNodes!(AL_OBJECT_TYPE.codeunit!, test.codeunitId, test.methodId, test.method);
    }
    for (const id of ids) testByNode.set(id, test);
  }

  const changed: Changed[] = [
    ...discovered.procedures.filter(changedIn).map((p) => ({ ...p, kind: "procedure" as const })),
    ...(alSem ? changedTriggers.map((t) => ({ ...t, kind: "trigger" as const, methodId: null })) : []),
  ].sort((a, b) => compare(a.relativeFile, b.relativeFile) || a.startLine - b.startLine || compare(a.name, b.name));
  const changedProcedures: ChangedProcedureRef[] = changed.map((p) => ({
    kind: p.kind, objectType: p.objectType, objectId: p.objectId, objectName: p.objectName, name: p.name,
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
  const opaqueApps = new Set<string>();
  changed.forEach((item, index) => {
    const name = label(item);
    const ownTest = item.kind === "procedure" && item.objectType === AL_OBJECT_TYPE.codeunit
      ? testByKey.get(testKey(item.objectId, item.name))
      : undefined;
    if (ownTest) {
      const known = ownTest.methodId !== null && mapped.has(key(AL_OBJECT_TYPE.codeunit!, ownTest.codeunitId, ownTest.methodId));
      note(ownTest, known ? "direct" : "new-test", name);
      return;
    }
    let reached = false;
    let ids: string[];
    if (alSemNodes) {
      const found = alSemNodes(item);
      if (found.warning) warnings.push(found.warning);
      ids = found.nodes.map((node) => node.id);
    } else {
      ids = altoolNodes!(item.objectType, item.objectId, item.methodId, item.name);
    }
    if (ids.length === 0) {
      fallbackReasons.push(`Changed ${item.kind} ${name} (${item.relativeFile}:${item.startLine}) is not in the call graph`);
    }
    const cone = reverseReachable(graph, ids);
    for (const [id, how] of cone) {
      const test = testByNode.get(id);
      if (!test) continue;
      note(test, how === "direct" ? "direct" : how === "indirect" ? "event" : "dynamic", name);
      reached = true;
    }
    let history = false;
    if (item.methodId !== null) {
      for (const test of historyByProcedure.get(key(item.objectType, item.objectId, item.methodId)) ?? []) {
        note(test, "coverage-history", name);
        reached = true;
        history = true;
      }
    }
    let hiddenUnresolved = false;
    if (alSem) {
      const hidden: string[] = [];
      for (const id of cone.keys()) {
        const node = nodeById.get(id);
        if (!node) continue;
        if (node.hiddenCallers && node.hiddenCallers.length > 0) hidden.push(`${nodeLabel(node)} (${node.hiddenCallers.join(", ")})`);
        if (node.hub === "callbacks" && node.hubArg !== undefined) opaqueApps.add(node.hubArg);
      }
      hidden.sort(compare);
      if (hidden.length > 0) {
        if (history) {
          warnings.push(`${name} can also run through ${hidden.join("; ")}, which the call graph does not show; coverage history covers it.`);
        } else {
          fallbackReasons.push(`Changed ${item.kind} ${name} can also run through ${hidden.join("; ")}, which the call graph does not show, and no coverage history covers it`);
          hiddenUnresolved = true;
        }
      }
    }
    if (!reached && !hiddenUnresolved) uncoverable.push(changedProcedures[index]!);
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

  if (alSem) {
    if (opaqueApps.size > 0) {
      const names = [...opaqueApps].map((appId) => graph.meta?.apps.find((a) => a.appId === appId)?.name ?? appId).sort(compare);
      warnings.push(`Symbol-only apps without source limited the precision (tests reached through their code rank 'dynamic'): ${names.join(", ")}`);
    }
    const leaned = uncoverable.length > 0 || selection.some((s) => s.reasons.includes("dynamic"));
    const assumptions = graph.meta?.assumptions ?? [];
    if (leaned && assumptions.length > 0) {
      warnings.push(`This selection relies on al-sem's stated assumptions: ${assumptions.map((a) => ASSUMPTION_TEXT[a] ?? a).join("; ")}.`);
    }
  } else if (uncoverable.length > 0) {
    warnings.push("The altool graph has no Codeunit.Run or trigger edges, so 'uncoverable' means no evidence was found, not that no test can reach the change.");
  }

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
