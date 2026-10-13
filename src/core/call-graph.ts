import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { BcDevError } from "./agent-errors";

/*
 * Whole-program AL call graph seam (epic c03, child 5). The production provider shells
 * out to `altool graph` (ships in the AL extension's bin folder): `extract` compiles one
 * app folder into a fact shard, `stitch` resolves Event/Interface edges and writes JSONL
 * lines `{"t":"node"|"edge","v":{...}}`. Shape established against AL 30.0.2863738 on
 * tests/fixtures/test-selection (2026-10-13). al-sem has no usable CLI, so altool is the
 * only engine; the provider is a ToolDeps function so tests inject a fake graph.
 */

export const CALL_EDGE_KINDS = ["Direct", "Event", "Interface", "Run", "Trigger"] as const;
export type CallEdgeKind = (typeof CALL_EDGE_KINDS)[number];

export interface CallGraphNode {
  id: string;
  /** altool node kind: Object | Method | BuiltInMethod (others passed through). */
  kind: string;
  /** Parsed from the node id ("Codeunit", "Table", "Interface", ...); "" when absent. */
  objectType: string;
  objectId: number;
  objectName: string;
  memberName?: string;
  sourcePath?: string;
  line?: number;
}

export interface CallGraphEdge {
  caller: string;
  callee: string;
  kind: CallEdgeKind;
  /** "Resolved" for static calls; "OverApprox" for event/interface fan-out. */
  confidence: string;
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

/** Builds the call graph for the AL project folder (containing app.json). */
export type CallGraphProvider = (project: string) => Promise<CallGraph>;

/** Env var naming the altool executable; otherwise `altool` is resolved from PATH. */
export const ALTOOL_ENV_VAR = "BC_DEV_ALTOOL";

export type CommandRunner = (binary: string, args: string[]) => Promise<void>;

const execFileAsync = promisify(execFile);

export const runCommand: CommandRunner = async (binary, args) => {
  await execFileAsync(binary, args, { encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
};

const OBJECT_REF = / \/ (\w+) (\d+) /;

function malformed(message: string, line: number): BcDevError {
  return new BcDevError("PROTOCOL_ERROR", `altool graph output is malformed: ${message}`, "protocol", false, { line });
}

export function parseCallGraphJsonl(text: string): CallGraph {
  const nodes: CallGraphNode[] = [];
  const edges: CallGraphEdge[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === "") return;
    const lineNo = index + 1;
    let entry: { t?: unknown; v?: Record<string, unknown> };
    try {
      entry = JSON.parse(raw);
    } catch {
      throw malformed("line is not JSON", lineNo);
    }
    const v = entry.v;
    if (typeof v !== "object" || v === null) throw malformed("missing 'v' object", lineNo);
    if (entry.t === "node") {
      if (typeof v["id"] !== "string") throw malformed("node without string id", lineNo);
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
    } else if (entry.t === "edge") {
      const kind = v["kind"];
      if (typeof v["caller"] !== "string" || typeof v["callee"] !== "string") throw malformed("edge without caller/callee", lineNo);
      if (!CALL_EDGE_KINDS.includes(kind as CallEdgeKind)) throw malformed(`unknown edge kind '${String(kind)}'`, lineNo);
      edges.push({ caller: v["caller"], callee: v["callee"], kind: kind as CallEdgeKind, confidence: String(v["confidence"] ?? "") });
    }
    // Other line types are ignored so newer altool output stays readable.
  });
  return { nodes, edges };
}

/**
 * Transitive callers of `targets` (targets included). `direct` means a path of Direct
 * edges exists; `indirect` means every path crosses an Event/Interface/Run/Trigger edge.
 */
export function reverseReachable(graph: CallGraph, targets: Iterable<string>): Map<string, "direct" | "indirect"> {
  const callersOf = new Map<string, CallGraphEdge[]>();
  for (const edge of graph.edges) {
    if (edge.caller === edge.callee) continue; // altool emits a self "declaration" edge per method
    const list = callersOf.get(edge.callee);
    if (list) list.push(edge);
    else callersOf.set(edge.callee, [edge]);
  }
  const walk = (directOnly: boolean): Set<string> => {
    const seen = new Set(targets);
    const queue = [...seen];
    while (queue.length > 0) {
      for (const edge of callersOf.get(queue.pop()!) ?? []) {
        if (directOnly && edge.kind !== "Direct") continue;
        if (!seen.has(edge.caller)) {
          seen.add(edge.caller);
          queue.push(edge.caller);
        }
      }
    }
    return seen;
  };
  const direct = walk(true);
  const result = new Map<string, "direct" | "indirect">();
  for (const id of walk(false)) result.set(id, direct.has(id) ? "direct" : "indirect");
  return result;
}

function unavailable(binary: string, cause: unknown): BcDevError {
  return new BcDevError(
    "CONFIGURATION_ERROR",
    `AL call-graph engine '${binary}' was not found. Set ${ALTOOL_ENV_VAR} to the altool.exe path `
      + "(AL extension bin folder, e.g. %USERPROFILE%\\.vscode\\extensions\\ms-dynamics-smb.al-<version>\\bin\\altool.exe) "
      + "or put altool on PATH.",
    "configuration",
    false,
    { binary, envVar: ALTOOL_ENV_VAR },
    { cause },
  );
}

function failed(binary: string, step: string, error: unknown): BcDevError {
  const stderr = typeof error === "object" && error !== null && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "").trim()
    : "";
  const stdout = typeof error === "object" && error !== null && "stdout" in error
    ? String((error as { stdout?: unknown }).stdout ?? "").trim()
    : "";
  const output = (stderr || stdout).slice(0, 2000);
  return new BcDevError(
    "CONFIGURATION_ERROR",
    `altool graph ${step} failed${output === "" ? "" : `: ${output}`}. Check that the project compiles (symbols downloaded).`,
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
          if ((error as { code?: unknown })?.code === "ENOENT") throw unavailable(binary, error);
          throw failed(binary, step, error);
        }
      }
      return parseCallGraphJsonl(await readFile(graphFile, "utf8"));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}
