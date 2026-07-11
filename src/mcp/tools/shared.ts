import { resolve as resolvePath } from "node:path";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { HubFactory } from "../../core/hubs/signalr-base";
import type { AuthorizationProvider, AuthorizationProviderFactory } from "../../core/authorization";
import { resolveConnection } from "../../core/launch-config";
import type { ConnectionConfig } from "../../core/types";
import { DebugSession, ServerState } from "../state";

export interface ToolDeps {
  hubFactory: HubFactory;
  authorizationFactory: AuthorizationProviderFactory;
  fetchFn: typeof fetch;
  env: Record<string, string | undefined>;
  cwd: string;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  outputSchema: z.ZodTypeAny;
  annotations: ToolAnnotations;
  handler(params: Record<string, unknown>): Promise<unknown>;
}

// Wire-derived data is always loose: unknown fields from BC must never fail output validation.
export const testMethodResultSchema = z.looseObject({
  codeunitId: z.number(),
  method: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number(),
  output: z.string().describe("Failure message + AL callstack for failed tests; empty when passed"),
});

export const runTestsOutputSchema = z.looseObject({
  results: z.array(testMethodResultSchema),
  coverage: z
    .array(
      z.looseObject({
        testObjectId: z.number(),
        testMethodId: z.number(),
        coveredProcedures: z.array(
          z.looseObject({
            objectType: z.number(),
            objectId: z.number(),
            methodId: z.number(),
            file: z.string().optional().describe("Local source file, when the object id maps to the project"),
          }),
        ),
      }),
    )
    .optional(),
  runAborted: z.boolean().optional(),
  abortReason: z.string().optional(),
});

export const variableNodeSchema = z.looseObject({
  name: z.string(),
  typeName: z.string(),
  summary: z.string().describe("Rendered value"),
  hasChildren: z.boolean().describe("true = expandable via bcdev_debug_variables expand"),
  get children(): z.ZodOptional<z.ZodArray<z.ZodTypeAny>> {
    return z.array(variableNodeSchema as z.ZodTypeAny).optional();
  },
});

export const addedBreakpointSchema = z.object({
  breakpointId: z.number().describe("ID for bcdev_debug_breakpoints remove"),
  file: z.string(),
  line: z.number().describe("1-based"),
});

export const stackFrameSchema = z.looseObject({
  objectType: z.number(),
  objectId: z.number(),
  objectName: z.string(),
  methodName: z.string(),
  line: z.number().describe("1-based"),
  file: z.string().optional().describe("Local source file, when the object id maps to the project"),
});

export const connectionShape = {
  project: z.string().optional().describe("AL project directory (default: server cwd); source for .vscode/launch.json connection defaults and .al file scanning"),
  environmentType: z.enum(["OnPrem", "Sandbox", "Production"]).optional().describe("Target kind (default: from launch.json; server implies OnPrem)"),
  environmentName: z.string().optional().describe("Business Central SaaS environment name (default: from launch.json)"),
  server: z.string().optional().describe("On-prem BC server base URL, e.g. http://bcserver (default: from launch.json)"),
  serverInstance: z.string().optional().describe("On-prem BC server instance name, e.g. BC (default: from launch.json)"),
  port: z.number().optional().describe("Developer service port (default: from launch.json, else 7049)"),
  tenant: z.string().optional().describe("Tenant ID/domain (SaaS: required via launch/param/BC_DEV_ENTRA_TENANT; OnPrem default: 'default')"),
} as const;

export const codeunitsShape = z
  .array(
    z.object({
      id: z.number().describe("Test codeunit object ID (from bcdev_test_discover)"),
      methods: z.array(z.string()).optional().describe("Run only these [Test] method names (default: all in the codeunit)"),
    }),
  )
  .min(1)
  .describe("Test codeunits to run, optionally restricted to named methods");

export const breakpointShape = z.object({
  file: z.string().describe("AL source file, relative to project (absolute also accepted)"),
  line: z.number().describe("1-based line number, as shown in an editor"),
  condition: z.string().optional().describe("Optional AL condition expression — break only when it evaluates true"),
});

export function resolve(
  params: Record<string, unknown>,
  deps: ToolDeps,
): { config: ConnectionConfig; authorization: AuthorizationProvider; project: string } {
  const project = (params["project"] as string | undefined) ?? deps.cwd;
  const overrides = {
    environmentType: params["environmentType"] as "OnPrem" | "Sandbox" | "Production" | undefined,
    environmentName: params["environmentName"] as string | undefined,
    server: params["server"] as string | undefined,
    serverInstance: params["serverInstance"] as string | undefined,
    port: params["port"] as number | undefined,
    tenant: params["tenant"] as string | undefined,
  };
  const config = resolveConnection(overrides, project, deps.env);
  return { config, authorization: deps.authorizationFactory(config), project };
}

export async function mapBreakpoints(
  session: DebugSession,
  project: string,
  specs: Array<{ file: string; line: number; condition?: string }>,
): Promise<Array<{ breakpointId: number; file: string; line: number }>> {
  await session.index.refresh();
  const results: Array<{ breakpointId: number; file: string; line: number }> = [];
  for (const spec of specs) {
    const abs = resolvePath(project, spec.file);
    const ref = session.index.byFile(abs);
    if (!ref) throw new Error(`No AL object declaration found in ${spec.file} — cannot set breakpoint`);
    const breakpointId = await session.client.addBreakpoint(ref.objectType, ref.objectId, spec.line, spec.condition);
    session.breakpoints.set(breakpointId, spec);
    results.push({ breakpointId, file: spec.file, line: spec.line });
  }
  return results;
}

export function requireSession(state: ServerState): DebugSession {
  if (!state.debug) throw new Error("No debug session — call bcdev_debug_attach first");
  return state.debug;
}

export function annotateFiles(session: DebugSession, event: Record<string, unknown>): Record<string, unknown> {
  if (event["kind"] !== "break") return event;
  const withFile = (frame: { objectType: number; objectId: number }) =>
    session.index.byId(frame.objectType, frame.objectId)?.file;
  const stack = (event["stack"] as Array<Record<string, unknown>>).map((f) => ({
    ...f,
    file: withFile(f as never),
  }));
  return { ...event, file: withFile(event as never), stack };
}
