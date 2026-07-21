import { describe, expect, test } from "bun:test";
import { parseDatabaseStatistics } from "../../src/core/sql-insight";
import type { VariableNode } from "../../src/core/hubs/debugger-hub";

// Fixture reconstructed from the live 2026-07-04 capture (v1 power-controls spec):
// GetVariables grows a `<Database Statistics>` top-level node when EnableSqlInformationDebugger
// is on; statement lists expand to SQLn nodes whose children carry the metrics.
function node(name: string, summary = "", hasChildren = false, children?: VariableNode[]): VariableNode {
  return { name, typeName: "", summary, hasChildren, changeState: "unchanged", changed: false, children };
}

const topLevel: VariableNode[] = [
  node("Rec", "Record Item", true),
  node("<Database Statistics>", "", true),
];

const statsChildren: VariableNode[] = [
  node("Current SQL Latency (ms)", "0.42"),
  node("Number of SQL Executes", "17"),
  node("<Last SQL Statements>", "", true),
  node("<Last Long Running SQL Statements>", "", true),
];

const sql1Children: VariableNode[] = [
  node("Statement", "SELECT * FROM [Item] WHERE [No_] = @0"),
  node("Execution Time", "2026-07-16T10:00:00"),
  node("Duration", "3 ms"),
  node("Approx. Rows Read", "1"),
];

function expander(routes: Record<string, VariableNode[]>): (path: string) => Promise<VariableNode[]> {
  return async (path) => routes[path] ?? [];
}

describe("parseDatabaseStatistics", () => {
  test("returns null when the statistics node is absent", async () => {
    const result = await parseDatabaseStatistics([node("Rec", "Record Item", true)], expander({}));
    expect(result).toBeNull();
  });

  test("parses metrics and statement lists via expansion", async () => {
    const result = await parseDatabaseStatistics(
      topLevel,
      expander({
        "<Database Statistics>": statsChildren,
        "<Database Statistics>.<Last SQL Statements>": [node("SQL1", "", true)],
        "<Database Statistics>.<Last SQL Statements>.SQL1": sql1Children,
        "<Database Statistics>.<Last Long Running SQL Statements>": [],
      }),
    );
    expect(result).toEqual({
      currentLatencyMs: 0.42,
      sqlExecutes: 17,
      lastStatements: [
        {
          statement: "SELECT * FROM [Item] WHERE [No_] = @0",
          executionTime: "2026-07-16T10:00:00",
          durationMs: 3,
          approxRowsRead: 1,
        },
      ],
      lastLongRunning: [],
    });
  });

  test("uses inline children when present instead of expanding", async () => {
    const inline: VariableNode[] = [
      node("<Database Statistics>", "", true, [
        node("Current SQL Latency (ms)", "1"),
        node("Number of SQL Executes", "2"),
        node("<Last SQL Statements>", "", true, [node("SQL1", "", true, sql1Children)]),
        node("<Last Long Running SQL Statements>", "", true, []),
      ]),
    ];
    let expanded = 0;
    const result = await parseDatabaseStatistics(inline, async () => {
      expanded++;
      return [];
    });
    expect(expanded).toBe(0);
    expect(result?.lastStatements).toHaveLength(1);
  });

  test("tolerates malformed metrics and children without throwing", async () => {
    const result = await parseDatabaseStatistics(
      topLevel,
      expander({
        "<Database Statistics>": [
          node("Current SQL Latency (ms)", "n/a"),
          node("<Last SQL Statements>", "", true),
        ],
        "<Database Statistics>.<Last SQL Statements>": [node("SQL1", "", true)],
        "<Database Statistics>.<Last SQL Statements>.SQL1": [node("Statement", "SELECT 1")],
      }),
    );
    expect(result).toEqual({
      currentLatencyMs: null,
      sqlExecutes: null,
      lastStatements: [{ statement: "SELECT 1", executionTime: null, durationMs: null, approxRowsRead: null }],
      lastLongRunning: [],
    });
  });
});
