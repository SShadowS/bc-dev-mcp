import { resolve as resolvePath } from "node:path";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { HubFactory } from "../../core/hubs/signalr-base";
import { BcDevError } from "../../core/agent-errors";
import type { BreakpointVerification } from "../../core/hubs/debugger-hub";
import { fetchServerInfo, type DevServerInfo } from "../../core/server-info";
import type { AuthorizationProvider, AuthorizationProviderFactory } from "../../core/authorization";
import { resolveConnection } from "../../core/launch-config";
import type { ConnectionConfig } from "../../core/types";
import { DEFAULT_DEV_PORT } from "../../core/urls";
import { DebugSession, ServerState } from "../state";

export interface ToolDeps {
  hubFactory: HubFactory;
  authorizationFactory: AuthorizationProviderFactory;
  fetchFn: typeof fetch;
  env: Record<string, string | undefined>;
  cwd: string;
  serverInfoCacheTtlMs?: number;
  serverInfoTimeoutMs?: number;
  now?: () => number;
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

export function claimTestRun(state: ServerState): void {
  if (state.testRunActive) {
    throw new BcDevError("TEST_RUN_ACTIVE", "A test run is already running — wait for it to finish", "state");
  }
  state.testRunActive = true;
}

interface CachedServerInfo {
  promise: Promise<DevServerInfo>;
  expiresAt: number | null;
}

const DEFAULT_SERVER_INFO_CACHE_TTL_MS = 60_000;
const serverInfoByDeps = new WeakMap<ToolDeps, Map<string, CachedServerInfo>>();

function assertTestRunningSupport(info: DevServerInfo): void {
  if (!info.supportsTestRunning) {
    throw new BcDevError(
      "UNSUPPORTED_SERVER",
      `Business Central developer API ${info.webApiVersion} does not support TestRunnerHub; version 7.0 or newer is required`,
      "server",
      false,
      { webApiVersion: info.webApiVersion },
    );
  }
}

function connectionCacheKey(config: ConnectionConfig): string {
  return config.environmentType === "OnPrem"
    ? `OnPrem|${config.server}|${config.serverInstance}|${config.port ?? DEFAULT_DEV_PORT}|${config.tenant ?? "default"}`
    : `${config.environmentType}|${config.environmentName}|${config.tenant}`;
}

export async function requireTestRunningSupport(
  config: ConnectionConfig,
  authorization: AuthorizationProvider,
  deps: ToolDeps,
): Promise<void> {
  let byTarget = serverInfoByDeps.get(deps);
  if (!byTarget) {
    byTarget = new Map();
    serverInfoByDeps.set(deps, byTarget);
  }
  const key = connectionCacheKey(config);
  const now = deps.now ?? Date.now;
  const cached = byTarget.get(key);
  if (cached && (cached.expiresAt === null || cached.expiresAt > now())) {
    const info = await cached.promise;
    assertTestRunningSupport(info);
    return;
  }
  const promise = fetchServerInfo(config, authorization, deps.fetchFn, deps.serverInfoTimeoutMs);
  const entry: CachedServerInfo = { promise, expiresAt: null };
  byTarget.set(key, entry);
  void promise.then(
    () => {
      if (byTarget?.get(key) === entry) {
        entry.expiresAt = now() + (deps.serverInfoCacheTtlMs ?? DEFAULT_SERVER_INFO_CACHE_TTL_MS);
      }
    },
    () => {
      if (byTarget?.get(key) === entry) byTarget.delete(key);
    },
  );
  const info = await promise;
  assertTestRunningSupport(info);
}

// Wire-derived data is always loose: unknown fields from BC must never fail output validation.
export const testMethodResultSchema = z.looseObject({
  codeunitId: z.number(),
  method: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number(),
  output: z.string().describe("Failure message + AL callstack for failed tests; empty when passed"),
  failure: z.object({
    message: z.string(),
    parsed: z.boolean(),
    callStack: z.array(z.object({
      raw: z.string(),
      objectType: z.number().nullable(),
      objectId: z.number().nullable(),
      objectName: z.string().nullable(),
      methodName: z.string().nullable(),
      line: z.number().nullable().describe("1-based source line when parsed"),
      file: z.string().nullable().describe("Local source file when the frame maps to the project"),
    })),
  }).optional(),
});

export const runTestsOutputSchema = z.looseObject({
  results: z.array(testMethodResultSchema),
  summary: z.object({
    outcome: z.enum(["passed", "failed", "aborted"]),
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    durationMs: z.number(),
    syntheticResults: z.number(),
    failedTests: z.array(z.object({ codeunitId: z.number(), method: z.string() })),
  }),
  sourceMappingWarning: z.string().optional().describe("Nonfatal warning when local AL files could not be indexed; server test results remain complete"),
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
  changeState: z.enum(["unchanged", "new", "valueChanged", "descendantChanged", "unknown"]),
  changed: z.boolean().describe("true when Business Central reports a new, value-changed, or descendant-changed node"),
  get children(): z.ZodOptional<z.ZodArray<z.ZodTypeAny>> {
    return z.array(variableNodeSchema as z.ZodTypeAny).optional();
  },
});

export const addedBreakpointSchema = z.object({
  breakpointId: z.number().describe("ID for bcdev_debug_breakpoints remove"),
  file: z.string(),
  line: z.number().describe("1-based"),
  verification: z.object({
    status: z.enum(["verified", "relocated", "unverified"]),
    methodName: z.string().nullable(),
    internalMethodName: z.string().nullable(),
    objectType: z.number().nullable(),
    objectId: z.number().nullable(),
    span: z.object({
      from: z.object({ line: z.number().describe("1-based"), column: z.number().describe("1-based") }),
      to: z.object({ line: z.number().describe("1-based"), column: z.number().describe("1-based") }),
    }).nullable(),
  }),
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
): Promise<Array<{ breakpointId: number; file: string; line: number; verification: BreakpointVerification }>> {
  await session.index.refresh();
  const results: Array<{ breakpointId: number; file: string; line: number; verification: BreakpointVerification }> = [];
  for (const spec of specs) {
    const abs = resolvePath(project, spec.file);
    const ref = session.index.byFile(abs);
    if (!ref) throw new Error(`No AL object declaration found in ${spec.file} — cannot set breakpoint`);
    const registration = await session.client.addBreakpoint(ref.objectType, ref.objectId, spec.line, spec.condition);
    session.breakpoints.set(registration.breakpointId, spec);
    results.push({ breakpointId: registration.breakpointId, file: spec.file, line: spec.line, verification: registration.verification });
  }
  return results;
}

export function requireSession(state: ServerState): DebugSession {
  if (!state.debug) throw new BcDevError("NO_DEBUG_SESSION", "No debug session — call bcdev_debug_attach first", "state");
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
