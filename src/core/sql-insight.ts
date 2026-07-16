import type { VariableNode } from "./hubs/debugger-hub";

/**
 * Structures the `<Database Statistics>` scope the debugger exposes at a break when
 * EnableSqlInformationDebugger is on. Values arrive as display strings — parse leniently,
 * null on anything unparseable, never throw. Statement text is data: callers must not
 * place it in error messages or logs.
 */

export interface SqlStatement {
  statement: string;
  executionTime: string | null;
  durationMs: number | null;
  approxRowsRead: number | null;
}

export interface SqlInsight {
  currentLatencyMs: number | null;
  sqlExecutes: number | null;
  lastStatements: SqlStatement[];
  lastLongRunning: SqlStatement[];
}

// WIRE: node names observed live 2026-07-04 (v1 power-controls capture): `<Database Statistics>`
// top-level scope with `Current SQL Latency (ms)`, `Number of SQL Executes`, and the two
// statement lists whose SQLn children carry {Statement, Execution Time, Duration, Approx. Rows Read}
// (esp-decomp DebugAdapterScopesRequestHandler.cs — Database Statistics scope).
const STATS_NODE = "<Database Statistics>";
const LATENCY = "Current SQL Latency (ms)";
const EXECUTES = "Number of SQL Executes";
const LAST_STATEMENTS = "<Last SQL Statements>";
const LAST_LONG_RUNNING = "<Last Long Running SQL Statements>";

type Expand = (path: string) => Promise<VariableNode[]>;

function leniantNumber(summary: string | undefined): number | null {
  if (!summary) return null;
  const match = summary.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function find(nodes: VariableNode[], name: string): VariableNode | undefined {
  return nodes.find((n) => n.name === name);
}

async function childrenOf(node: VariableNode | undefined, path: string, expand: Expand): Promise<VariableNode[]> {
  if (!node) return [];
  if (node.children) return node.children; // inline children are authoritative, even when empty
  if (!node.hasChildren) return [];
  try {
    return await expand(path);
  } catch {
    return [];
  }
}

async function parseStatementList(list: VariableNode | undefined, path: string, expand: Expand): Promise<SqlStatement[]> {
  const entries = await childrenOf(list, path, expand);
  const statements: SqlStatement[] = [];
  for (const entry of entries) {
    const fields = await childrenOf(entry, `${path}.${entry.name}`, expand);
    const statement = find(fields, "Statement")?.summary ?? "";
    if (statement === "" && fields.length === 0) continue; // malformed child — skip, don't throw
    statements.push({
      statement,
      executionTime: find(fields, "Execution Time")?.summary || null,
      durationMs: leniantNumber(find(fields, "Duration")?.summary),
      approxRowsRead: leniantNumber(find(fields, "Approx. Rows Read")?.summary),
    });
  }
  return statements;
}

export async function parseDatabaseStatistics(nodes: VariableNode[], expand: Expand): Promise<SqlInsight | null> {
  const stats = find(nodes, STATS_NODE);
  if (!stats) return null;
  const children = await childrenOf(stats, STATS_NODE, expand);
  return {
    currentLatencyMs: leniantNumber(find(children, LATENCY)?.summary),
    sqlExecutes: leniantNumber(find(children, EXECUTES)?.summary),
    lastStatements: await parseStatementList(find(children, LAST_STATEMENTS), `${STATS_NODE}.${LAST_STATEMENTS}`, expand),
    lastLongRunning: await parseStatementList(find(children, LAST_LONG_RUNNING), `${STATS_NODE}.${LAST_LONG_RUNNING}`, expand),
  };
}
