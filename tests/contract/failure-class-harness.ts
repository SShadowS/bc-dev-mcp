/**
 * Four-failure-class MCP contract harness (epic c04).
 *
 * Self-contained on purpose: depends only on the shape of an MCP SDK `Client` and on a
 * `safeParse`-able error-body schema, so it can be copied verbatim into a sibling repo.
 *
 * For every tool the server lists, the fixture table must say, per failure class, either which
 * arguments provoke that failure or why the class does not apply. Every applicable call must
 * come back as `isError` with a single text block whose JSON validates against the error-body
 * schema, carries a non-empty `nextSteps`, and reports the fixture's expected `error.code`.
 * The fixture table must cover exactly the tools `tools/list` returns, so a new tool fails the
 * contract until someone classifies it.
 */

export const FAILURE_CLASSES = ["invalidPath", "missingAuth", "unsupportedFeature", "serverDisconnect"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * `args` + `code` = these arguments provoke the failure, which must surface as `error.code`
 * (pinning the code stops a fixture silently passing on an unrelated error, e.g. input
 * validation); `na` = class does not apply, with the reason.
 */
export type FailureCase = { args: Record<string, unknown>; code: string } | { na: string };
export type FailureTable = Record<string, Record<FailureClass, FailureCase>>;

export interface ContractClient {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

export interface ErrorBodySchema {
  safeParse(value: unknown): { success: boolean; error?: { message: string } };
}

export interface FailureClassContractOptions {
  /** A freshly connected client whose server's dependencies simulate the given failure class. */
  connect(failureClass: FailureClass): Promise<ContractClient>;
  table: FailureTable;
  errorBodySchema: ErrorBodySchema;
}

/** Runs the whole table; returns human-readable violations (empty = contract holds). */
export async function runFailureClassContract(options: FailureClassContractOptions): Promise<string[]> {
  const violations: string[] = [];
  for (const failureClass of FAILURE_CLASSES) {
    const client = await options.connect(failureClass);
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of listed) {
      if (!options.table[name]) violations.push(`${name}: listed by tools/list but missing from the fixture table`);
    }
    for (const name of Object.keys(options.table)) {
      if (!listed.includes(name)) violations.push(`${name}: in the fixture table but not listed by tools/list`);
    }
    for (const name of listed) {
      const fixture = options.table[name]?.[failureClass];
      if (!fixture) continue;
      if ("na" in fixture) {
        if (fixture.na.trim() === "") violations.push(`${name}/${failureClass}: not-applicable needs a reason`);
        continue;
      }
      const result = await callSafely(client, name, fixture.args);
      violations.push(...checkResult(name, failureClass, result, options.errorBodySchema, fixture.code));
    }
  }
  return violations;
}

async function callSafely(client: ContractClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (error) {
    return { protocolError: error instanceof Error ? error.message : String(error) };
  }
}

function checkResult(
  name: string,
  failureClass: FailureClass,
  result: unknown,
  schema: ErrorBodySchema,
  expectedCode: string,
): string[] {
  const where = `${name}/${failureClass}`;
  const r = result as { protocolError?: string; isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  if (r.protocolError !== undefined) return [`${where}: protocol-level failure instead of an isError result: ${r.protocolError}`];
  if (r.isError !== true) return [`${where}: expected isError, got a success result`];
  const text = r.content?.find((block) => block.type === "text")?.text;
  if (text === undefined) return [`${where}: isError result has no text content`];
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return [`${where}: error text is not JSON: ${text.slice(0, 200)}`];
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return [`${where}: error body fails the schema: ${parsed.error?.message ?? "unknown"}`];
  const { error, nextSteps } = body as { error?: { code?: unknown; message?: unknown }; nextSteps?: unknown };
  if (!Array.isArray(nextSteps) || nextSteps.length === 0) return [`${where}: error body has no nextSteps`];
  if (error?.code !== expectedCode) {
    return [`${where}: expected error.code ${expectedCode}, got ${String(error?.code)} (${String(error?.message).slice(0, 160)})`];
  }
  return [];
}
