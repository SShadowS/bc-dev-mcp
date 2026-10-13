import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { BcDevError } from "./agent-errors";

/*
 * Whole-program AL call graph seam (epic c03, child 5). Two engines write the same JSONL
 * envelope, lines `{"t":"node"|"edge"|...,"v":{...}}`:
 *
 * - al-sem (`alsem graph <project>`, schema `al-sem.callgraph` v1, issue SShadowS/al-sem#63):
 *   a `meta` line first, then a may-execute graph — runs reach the run object's triggers,
 *   open call sites reach bounded hub nodes, a node with `universal: true` stands for "may
 *   call anything", `hiddenCallers` marks routines with callers no edge shows. Changed code
 *   joins to nodes by location (sourcePath + line inside the routine's span).
 * - altool (`altool graph extract` + `stitch`, AL 30.0.2863738, 2026-10-13): no meta line,
 *   node ids `... / Codeunit 50926 Name # Member#methodId`, no Run edges and no triggers.
 *
 * `BC_DEV_CALLGRAPH_ENGINE` picks one (auto | al-sem | altool; auto prefers al-sem and falls
 * back to altool). Providers are ToolDeps functions so tests inject a fake graph.
 */

export const CALL_EDGE_KINDS = ["Direct", "Event", "Interface", "Run", "Trigger"] as const;
export type CallEdgeKind = (typeof CALL_EDGE_KINDS)[number];
export const CALL_EDGE_CONFIDENCES = ["Resolved", "OverApprox", "Open"] as const;
export type CallGraphEngine = "al-sem" | "altool";

export interface CallGraphNode {
  id: string;
  /** altool: Object | Method | BuiltInMethod; al-sem: Method | Trigger | Object | Hub (others passed through). */
  kind: string;
  /** "Codeunit", "Table", "Interface", ...; "" when absent. */
  objectType: string;
  objectId: number;
  objectName: string;
  memberName?: string;
  sourcePath?: string;
  line?: number;
  // al-sem v1 fields (absent on altool graphs).
  appId?: string;
  /** Enclosing field/action/dataitem of a member trigger. */
  member?: string;
  arity?: number;
  endLine?: number;
  dependency?: boolean;
  symbolOnly?: boolean;
  /** An engine-synthesized platform event publisher (no declaration). */
  synthetic?: boolean;
  test?: boolean;
  /** Ways the routine can run that no edge shows (unraisedPublisher, unboundSubscriber, ...). */
  hiddenCallers?: string[];
  /** Hub class: any | name | run | record | callbacks. */
  hub?: string;
  hubArg?: string;
  /** The universal hub: a caller of every node. */
  universal?: boolean;
}

export interface CallGraphEdge {
  caller: string;
  callee: string;
  /** One of CALL_EDGE_KINDS. An al-sem graph may carry a newer kind; it is read as indirect. */
  kind: string;
  /** Resolved | OverApprox | Open. An unknown al-sem value is read as Open. */
  confidence: string;
  via?: string;
  line?: number;
  conditions?: string[];
}

/** The al-sem `meta` line (the fields selection reads; others are kept). */
export interface AlSemGraphMeta {
  schema: string;
  version: number;
  engine: string;
  workspace?: { appId?: string; name?: string };
  apps: Array<{ appId?: string; name?: string; source?: string }>;
  assumptions: string[];
  recoveredFiles: string[];
  coverageHolds: boolean;
}

export interface CallGraph {
  /** Absent means altool (graphs built before the engine choice existed). */
  engine?: CallGraphEngine;
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  meta?: AlSemGraphMeta;
  /** How the graph was obtained, when that matters to the reader (an engine fallback). */
  warnings?: string[];
}

/** Builds the call graph for the AL project folder (containing app.json). */
export type CallGraphProvider = (project: string) => Promise<CallGraph>;

/** Env var naming the altool executable; otherwise `altool` is resolved from PATH. */
export const ALTOOL_ENV_VAR = "BC_DEV_ALTOOL";
/** Env var naming the alsem executable; otherwise `alsem` is resolved from PATH. */
export const ALSEM_ENV_VAR = "BC_DEV_ALSEM";
/** Env var choosing the engine: auto (default) | al-sem | altool. */
export const ENGINE_ENV_VAR = "BC_DEV_CALLGRAPH_ENGINE";

/** WIRE: al-sem.callgraph major version this parser reads (al-sem spec 2026-10-13 §4.2). */
export const ALSEM_GRAPH_SCHEMA = "al-sem.callgraph";
export const ALSEM_GRAPH_VERSION = 1;

export type CommandRunner = (binary: string, args: string[]) => Promise<void>;

const execFileAsync = promisify(execFile);

export const runCommand: CommandRunner = async (binary, args) => {
  await execFileAsync(binary, args, { encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
};

const OBJECT_REF = / \/ (\w+) (\d+) /;

function malformed(engine: string, message: string, line: number): BcDevError {
  return new BcDevError("PROTOCOL_ERROR", `${engine} graph output is malformed: ${message}`, "protocol", false, { line });
}

function parseLines(text: string, engine: string): Array<{ t: unknown; v: Record<string, unknown>; lineNo: number }> {
  const rows: Array<{ t: unknown; v: Record<string, unknown>; lineNo: number }> = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === "") return;
    const lineNo = index + 1;
    let entry: { t?: unknown; v?: unknown };
    try {
      entry = JSON.parse(raw);
    } catch {
      throw malformed(engine, "line is not JSON", lineNo);
    }
    if (typeof entry.v !== "object" || entry.v === null) throw malformed(engine, "missing 'v' object", lineNo);
    rows.push({ t: entry.t, v: entry.v as Record<string, unknown>, lineNo });
  });
  return rows;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/** Parses altool `graph stitch` JSONL. */
export function parseCallGraphJsonl(text: string): CallGraph {
  const nodes: CallGraphNode[] = [];
  const edges: CallGraphEdge[] = [];
  for (const { t, v, lineNo } of parseLines(text, "altool")) {
    if (t === "node") {
      if (typeof v["id"] !== "string") throw malformed("altool", "node without string id", lineNo);
      const id = v["id"];
      const ref = OBJECT_REF.exec(id);
      nodes.push({
        id,
        kind: String(v["kind"] ?? ""),
        objectType: ref?.[1] ?? "",
        objectId: typeof v["objectId"] === "number" ? v["objectId"] : Number(ref?.[2] ?? 0),
        objectName: String(v["objectName"] ?? ""),
        ...(typeof v["memberName"] === "string" ? { memberName: v["memberName"] } : {}),
        ...(typeof v["sourcePath"] === "string" ? { sourcePath: v["sourcePath"] } : {}),
        ...(typeof v["line"] === "number" ? { line: v["line"] } : {}),
      });
    } else if (t === "edge") {
      const kind = v["kind"];
      if (typeof v["caller"] !== "string" || typeof v["callee"] !== "string") throw malformed("altool", "edge without caller/callee", lineNo);
      if (!CALL_EDGE_KINDS.includes(kind as CallEdgeKind)) throw malformed("altool", `unknown edge kind '${String(kind)}'`, lineNo);
      edges.push({ caller: v["caller"], callee: v["callee"], kind: kind as CallEdgeKind, confidence: String(v["confidence"] ?? "") });
    }
    // Other line types are ignored so newer altool output stays readable.
  }
  return { engine: "altool", nodes, edges };
}

/**
 * Parses `alsem graph` JSONL (schema al-sem.callgraph v1). The `meta` line must come first with a
 * version this parser knows. Unknown fields are ignored and unknown values read fail-safe: an
 * unknown edge kind stays as given (the walk treats any non-Direct kind as indirect), an unknown
 * confidence becomes Open, an unknown node kind only carries the walk.
 */
export function parseAlSemCallGraphJsonl(text: string): CallGraph {
  const rows = parseLines(text, "al-sem");
  const first = rows[0];
  // WIRE: al-sem spec 2026-10-13 §4.2 — exactly one meta line, first, schema + major version.
  if (!first || first.t !== "meta") throw malformed("al-sem", "the first line is not a meta line", first?.lineNo ?? 1);
  if (first.v["schema"] !== ALSEM_GRAPH_SCHEMA) {
    throw malformed("al-sem", `schema '${String(first.v["schema"])}' is not '${ALSEM_GRAPH_SCHEMA}'`, first.lineNo);
  }
  if (first.v["version"] !== ALSEM_GRAPH_VERSION) {
    throw malformed("al-sem", `schema version ${String(first.v["version"])} is not supported (this reader knows ${ALSEM_GRAPH_VERSION})`, first.lineNo);
  }
  const workspace = first.v["workspace"];
  const meta: AlSemGraphMeta = {
    schema: ALSEM_GRAPH_SCHEMA,
    version: ALSEM_GRAPH_VERSION,
    engine: str(first.v["engine"]) ?? "",
    ...(typeof workspace === "object" && workspace !== null
      ? { workspace: { appId: str((workspace as Record<string, unknown>)["appId"]), name: str((workspace as Record<string, unknown>)["name"]) } }
      : {}),
    apps: (Array.isArray(first.v["apps"]) ? first.v["apps"] : [])
      .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
      .map((a) => ({ appId: str(a["appId"]), name: str(a["name"]), source: str(a["source"]) })),
    assumptions: strings(first.v["assumptions"]) ?? [],
    recoveredFiles: strings(first.v["recoveredFiles"]) ?? [],
    coverageHolds: first.v["coverageHolds"] !== false,
  };
  const nodes: CallGraphNode[] = [];
  const edges: CallGraphEdge[] = [];
  for (const { t, v, lineNo } of rows.slice(1)) {
    if (t === "node") {
      const id = str(v["id"]);
      if (id === undefined) throw malformed("al-sem", "node without string id", lineNo);
      const node: CallGraphNode = {
        id,
        kind: str(v["kind"]) ?? "",
        objectType: str(v["objectType"]) ?? "",
        objectId: num(v["objectId"]) ?? 0,
        objectName: str(v["objectName"]) ?? "",
      };
      for (const key of ["memberName", "sourcePath", "appId", "member", "hub", "hubArg"] as const) {
        const value = str(v[key]);
        if (value !== undefined) node[key] = value;
      }
      for (const key of ["line", "endLine", "arity"] as const) {
        const value = num(v[key]);
        if (value !== undefined) node[key] = value;
      }
      for (const key of ["dependency", "symbolOnly", "synthetic", "test", "universal"] as const) {
        const value = bool(v[key]);
        if (value !== undefined) node[key] = value;
      }
      const hidden = v["hiddenCallers"];
      if (hidden !== undefined) {
        // An unreadable value still means "hidden callers" (fail-safe).
        node.hiddenCallers = Array.isArray(hidden) ? hidden.map((h) => String(h)) : ["unknown"];
      }
      nodes.push(node);
    } else if (t === "edge") {
      const caller = str(v["caller"]);
      const callee = str(v["callee"]);
      if (caller === undefined || callee === undefined) throw malformed("al-sem", "edge without caller/callee", lineNo);
      const confidence = str(v["confidence"]);
      const edge: CallGraphEdge = {
        caller,
        callee,
        kind: str(v["kind"]) ?? "",
        confidence: confidence !== undefined && (CALL_EDGE_CONFIDENCES as readonly string[]).includes(confidence) ? confidence : "Open",
      };
      const via = str(v["via"]);
      if (via !== undefined) edge.via = via;
      const line = num(v["line"]);
      if (line !== undefined) edge.line = line;
      const conditions = strings(v["conditions"]);
      if (conditions !== undefined) edge.conditions = conditions;
      edges.push(edge);
    }
    // Other line types are ignored: additive in schema v1.
  }
  return { engine: "al-sem", nodes, edges, meta };
}

/**
 * How each node reaches `targets` (targets included), walking edges backwards:
 * `direct` — a path of resolved Direct edges; `indirect` — a path with no Open edge (Event,
 * Interface, Run, Trigger or an unknown kind on it); `dynamic` — every path uses an Open edge
 * (an al-sem hub) or the universal hub, which is a caller of every node.
 */
export function reverseReachable(graph: CallGraph, targets: Iterable<string>): Map<string, "direct" | "indirect" | "dynamic"> {
  const callersOf = new Map<string, CallGraphEdge[]>();
  for (const edge of graph.edges) {
    if (edge.caller === edge.callee) continue; // altool emits a self "declaration" edge per method
    const list = callersOf.get(edge.callee);
    if (list) list.push(edge);
    else callersOf.set(edge.callee, [edge]);
  }
  const universal = graph.nodes.filter((n) => n.universal === true).map((n) => n.id);
  const walk = (allowed: (edge: CallGraphEdge) => boolean, withUniversal: boolean): Set<string> => {
    const seen = new Set(targets);
    const queue = [...seen];
    while (queue.length > 0) {
      const next = queue.pop()!;
      const callers = (callersOf.get(next) ?? []).filter(allowed).map((edge) => edge.caller);
      if (withUniversal) callers.push(...universal);
      for (const caller of callers) {
        if (!seen.has(caller)) {
          seen.add(caller);
          queue.push(caller);
        }
      }
    }
    return seen;
  };
  const direct = walk((edge) => edge.kind === "Direct" && edge.confidence !== "Open", false);
  const indirect = walk((edge) => edge.confidence !== "Open", false);
  const result = new Map<string, "direct" | "indirect" | "dynamic">();
  for (const id of walk(() => true, true)) result.set(id, direct.has(id) ? "direct" : indirect.has(id) ? "indirect" : "dynamic");
  return result;
}

export function unavailable(binary: string, envVar: string, hint: string, cause: unknown): BcDevError {
  return new BcDevError(
    "CONFIGURATION_ERROR",
    `AL call-graph engine '${binary}' was not found. Set ${envVar} to its path ${hint}or put it on PATH.`,
    "configuration",
    false,
    { binary, envVar, notFound: true },
    { cause },
  );
}

export function toolOutput(error: unknown): string {
  const read = (key: "stderr" | "stdout") =>
    typeof error === "object" && error !== null && key in error ? String((error as Record<string, unknown>)[key] ?? "").trim() : "";
  return (read("stderr") || read("stdout")).slice(0, 2000);
}

export function failed(binary: string, step: string, error: unknown, advice: string): BcDevError {
  const output = toolOutput(error);
  return new BcDevError(
    "CONFIGURATION_ERROR",
    `${step} failed${output === "" ? "" : `: ${output}`}. ${advice}`,
    "configuration",
    false,
    { binary, step },
    { cause: error },
  );
}

export function createAltoolCallGraphProvider(
  env: Record<string, string | undefined>,
  run: CommandRunner = runCommand,
): CallGraphProvider {
  const binary = env[ALTOOL_ENV_VAR]?.trim() || "altool";
  return async (project) => {
    const work = await mkdtemp(join(tmpdir(), "bcdev-graph-"));
    try {
      const shards = join(work, "shards");
      const graphFile = join(work, "graph.jsonl");
      for (const [step, args] of [
        ["extract", ["graph", "extract", "--app", resolve(project), "--out", shards]],
        ["stitch", ["graph", "stitch", "--shards", shards, "--out", graphFile]],
      ] as const) {
        try {
          await run(binary, [...args]);
        } catch (error) {
          if ((error as { code?: unknown })?.code === "ENOENT") {
            throw unavailable(
              binary,
              ALTOOL_ENV_VAR,
              "(AL extension bin folder, e.g. %USERPROFILE%\\.vscode\\extensions\\ms-dynamics-smb.al-<version>\\bin\\altool.exe) ",
              error,
            );
          }
          throw failed(binary, `altool graph ${step}`, error, "Check that the project compiles (symbols downloaded).");
        }
      }
      return parseCallGraphJsonl(await readFile(graphFile, "utf8"));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}

/** Runs `alsem graph <project> --out <file>` (al-sem's whole-program engine; no compile needed). */
export function createAlSemCallGraphProvider(
  env: Record<string, string | undefined>,
  run: CommandRunner = runCommand,
): CallGraphProvider {
  const binary = env[ALSEM_ENV_VAR]?.trim() || "alsem";
  return async (project) => {
    const work = await mkdtemp(join(tmpdir(), "bcdev-alsem-graph-"));
    try {
      const graphFile = join(work, "graph.jsonl");
      try {
        await run(binary, ["graph", resolve(project), "--out", graphFile]);
      } catch (error) {
        if ((error as { code?: unknown })?.code === "ENOENT") throw unavailable(binary, ALSEM_ENV_VAR, "(alsem.exe from an al-sem release) ", error);
        throw failed(binary, "alsem graph", error, "Check that the project has an app.json and that its .alpackages holds the dependencies.");
      }
      return parseAlSemCallGraphJsonl(await readFile(graphFile, "utf8"));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}

/**
 * The configured engine (BC_DEV_CALLGRAPH_ENGINE). `auto` (default) uses al-sem; when the alsem
 * binary is not found it uses altool, and when al-sem runs but fails (or writes output this reader
 * rejects) it uses altool and says so in the graph's warnings. `al-sem` and `altool` use only that
 * engine and surface its errors.
 */
export function createCallGraphProvider(
  env: Record<string, string | undefined>,
  run: CommandRunner = runCommand,
): CallGraphProvider {
  const choice = (env[ENGINE_ENV_VAR]?.trim() || "auto").toLowerCase();
  const alsem = createAlSemCallGraphProvider(env, run);
  const altool = createAltoolCallGraphProvider(env, run);
  if (choice === "al-sem") return alsem;
  if (choice === "altool") return altool;
  if (choice !== "auto") {
    return async () => {
      throw new BcDevError(
        "CONFIGURATION_ERROR",
        `${ENGINE_ENV_VAR}='${choice}' is not an engine; use auto, al-sem or altool.`,
        "configuration",
        false,
        { envVar: ENGINE_ENV_VAR, value: choice },
      );
    };
  }
  return async (project) => {
    try {
      return await alsem(project);
    } catch (error) {
      const notFound = error instanceof BcDevError && error.details["notFound"] === true;
      const reason = error instanceof Error ? error.message : String(error);
      let graph: CallGraph;
      try {
        graph = await altool(project);
      } catch (fallbackError) {
        // Both engines failed: keep al-sem's reason, which the altool error would hide.
        if (fallbackError instanceof BcDevError) {
          throw new BcDevError(fallbackError.code, `${fallbackError.message} (al-sem was tried first: ${reason})`, fallbackError.category, fallbackError.retryable,
            { ...fallbackError.details, alsemError: reason }, { cause: fallbackError });
        }
        throw fallbackError;
      }
      if (notFound) return graph;
      return { ...graph, warnings: [...(graph.warnings ?? []), `al-sem call graph unavailable (${reason}); used altool instead.`] };
    }
  };
}

/** What a graph depends on: every .al file, app.json and .alpackages/*.app (path, size, mtime). */
export async function alProjectFingerprint(project: string): Promise<string> {
  const root = resolve(project);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const rel = relative(root, path).split(sep).join("/");
    if (rel.startsWith(".git/") || rel.includes("node_modules/")) continue;
    const lower = rel.toLowerCase();
    if (!(lower.endsWith(".al") || lower === "app.json" || (lower.startsWith(".alpackages/") && lower.endsWith(".app")))) continue;
    const info = await stat(path);
    parts.push(`${rel}|${info.size}|${info.mtimeMs}`);
  }
  return `${root}\n${parts.sort().join("\n")}`;
}

/**
 * Reuses a built graph while the project's AL inputs are unchanged (fingerprint), so repeated
 * bcdev_test_select calls on one commit skip the multi-second engine run. Concurrent calls share
 * one build; failures are not cached.
 */
export function cachedCallGraphProvider(
  inner: CallGraphProvider,
  fingerprint: (project: string) => Promise<string> = alProjectFingerprint,
  maxEntries = 4,
): CallGraphProvider {
  const cache = new Map<string, Promise<CallGraph>>();
  return async (project) => {
    const key = await fingerprint(project);
    let graph = cache.get(key);
    if (graph) {
      cache.delete(key); // re-insert: Map order doubles as LRU order
    } else {
      graph = inner(project);
      graph.catch(() => cache.delete(key));
    }
    cache.set(key, graph);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    return graph;
  };
}
