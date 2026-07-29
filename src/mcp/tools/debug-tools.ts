import { z } from "zod";
import { AlObjectIndex } from "../../core/al-objects";
import { BcDevError } from "../../core/agent-errors";
import { DebuggerClient, type StepAction } from "../../core/hubs/debugger-hub";
import { parseDatabaseStatistics } from "../../core/sql-insight";
import { enrichTestRun } from "../../core/agent-results";
import { TestRunnerClient } from "../../core/hubs/test-runner-hub";
import { DebugSession, type ServerState } from "../state";
import {
  addedBreakpointSchema,
  annotateFiles,
  breakpointShape,
  claimTestRun,
  codeunitsShape,
  connectionShape,
  mapBreakpoints,
  normalizeDebugTarget,
  requireSession,
  requireTestRunningSupport,
  resolve,
  runTestsOutputSchema,
  stackFrameSchema,
  type ToolDefinition,
  type ToolDeps,
  variableNodeSchema,
} from "./shared";

const sqlStatementSchema = z.object({
  statement: z.string(),
  executionTime: z.string().nullable(),
  durationMs: z.number().nullable(),
  approxRowsRead: z.number().nullable(),
});

export function createDebugTools(state: ServerState, deps: ToolDeps): ToolDefinition[] {
  return [
    {
      name: "bcdev_debug_attach",
      title: "Attach AL debugger",
      description:
        "Attach the AL debugger to the BC server. By default it binds the next client; sessionId selects an existing NST session and userId filters the next client. Attach returns before binding — use bcdev_debug_wait for sessionBound and later events. One debugger session at a time.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      schema: {
        ...connectionShape,
        breakpoints: z
          .array(breakpointShape)
          .optional()
          .describe(
            "Breakpoints to set at attach. NOTE: BC rejects file/line breakpoints until the session has paused once — if this fails, attach with breakOnError:true and add them at the first break via bcdev_debug_breakpoints.",
          ),
        breakOnNext: z
          .enum(["WebClient", "WebServiceClient", "Background"])
          .optional()
          .describe("Client type for default/user-filtered next-session attach (default WebClient); an exact sessionId takes precedence"),
        sessionId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Positive NST session ID to attach to an existing session; mutually exclusive with userId and takes precedence over breakOnNext"),
        userId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Business Central user ID whose next matching session should bind; mutually exclusive with sessionId and filtered by breakOnNext client type"),
        breakOnError: z
          .union([z.boolean(), z.enum(["all", "unhandled"])])
          .optional()
          .describe("Pause on AL runtime errors: true/'all' = every error, 'unhandled' = skip errors caught by a try function, false = never (default true)"),
        breakOnRecordWrite: z
          .union([z.boolean(), z.enum(["all", "nonTemporary"])])
          .optional()
          .describe("Pause on record writes: true/'all' = every write, 'nonTemporary' = skip temporary-record writes, false = never (default false)"),
        skipSystemTriggers: z.boolean().optional().describe("Skip breaks inside system triggers (default true)"),
        sqlInsight: z.boolean().optional().describe("Collect live SQL statistics for bcdev_debug_sql at each break (default false)"),
        longRunningSqlThresholdMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Also track SQL statements slower than this many milliseconds (implies sqlInsight)"),
      },
      outputSchema: z.object({
        attached: z.literal(true),
        connectionId: z.string().nullable(),
        breakpoints: z.array(addedBreakpointSchema),
      }),
      handler: async (params) => {
        state.assertDebugSlotAvailable();
        const target = normalizeDebugTarget(params);
        const slotToken = state.claimDebugSlot("manual");
        const client = new DebuggerClient(deps.hubFactory);
        let session: DebugSession | null = null;
        try {
          const { config, authorization, project } = resolve(params, deps);
          const index = await AlObjectIndex.build(project);
          session = new DebugSession(client, index, slotToken);
          state.debug = session;
          client.onEvent = (e) => session?.push(e);
          await client.connect(config, authorization, {
            breakOnNext: params["breakOnNext"] as never,
            ...target,
            breakOnError: params["breakOnError"] as boolean | "all" | "unhandled" | undefined,
            breakOnRecordWrite: params["breakOnRecordWrite"] as boolean | "all" | "nonTemporary" | undefined,
            skipSystemTriggers: params["skipSystemTriggers"] as boolean | undefined,
            sqlInsight: params["sqlInsight"] as boolean | undefined,
            longRunningSqlThresholdMs: params["longRunningSqlThresholdMs"] as number | undefined,
          });
          const breakpoints = await mapBreakpoints(
            session,
            project,
            (params["breakpoints"] as Array<{ file: string; line: number; condition?: string }> | undefined) ?? [],
          );
          return { attached: true, connectionId: client.connectionId, breakpoints };
        } catch (err) {
          if (state.debug === session) state.debug = null;
          state.releaseDebugSlot(slotToken);
          await client.stop().catch(() => {});
          throw err;
        }
      },
    },
    {
      name: "bcdev_debug_run_tests",
      title: "Run tests under debugger",
      description: "Run tests bound to the active debug session so breakpoints and break-on-error fire during the run. Results arrive via bcdev_debug_wait's testRunFinished event.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      schema: {
        ...connectionShape,
        codeunits: codeunitsShape,
        company: z.string().optional().describe("BC company name (default: the server's default company)"),
      },
      outputSchema: z.object({ started: z.literal(true), hint: z.string() }),
      handler: async (params) => {
        const session = requireSession(state);
        claimTestRun(state);
        try {
          const { config, authorization } = resolve(params, deps);
          await requireTestRunningSupport(config, authorization, deps);
          const debuggingContext = session.client.connectionId ?? "";
          void new TestRunnerClient(deps.hubFactory)
            .run(config, authorization, params["codeunits"] as Array<{ id: number; methods?: string[] }>, {
              company: params["company"] as string | undefined,
              debuggingContext,
            })
            .then((result) => {
              session.lastTestRun = enrichTestRun(result, session.index);
              session.push({ kind: "testRunFinished" });
            })
            .catch((err) => {
              session.push({ kind: "fatal", message: `Test run failed to start: ${String(err)}` });
            })
            .finally(() => {
              state.testRunActive = false;
            });
          return {
            started: true,
            hint: "Call bcdev_debug_wait to receive break events; testRunFinished signals completion and carries the results.",
          };
        } catch (error) {
          state.testRunActive = false;
          throw error;
        }
      },
    },
    {
      name: "bcdev_debug_wait",
      title: "Wait for debugger event",
      description:
        "Wait for the next debugger event (sessionBound, break, testRunFinished, detached, fatal). Timing out is a normal result — call again to keep waiting. Events queue up to 100 between calls; beyond that the oldest are discarded and droppedEvents reports how many.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      schema: { timeoutMs: z.number().min(1).max(300000).optional().describe("Max wait in milliseconds (default 30000, max 300000)") },
      // single loose object, NOT a union (SDK 1.29 drops non-object outputSchema)
      outputSchema: z.looseObject({
        timedOut: z.boolean().optional().describe("true = no event within timeoutMs; normal — call again"),
        kind: z.enum(["sessionBound", "break", "testRunFinished", "detached", "fatal"]).optional(),
        sessionId: z.number().nullable().optional().describe("Bound NST session ID on kind=sessionBound; null when identity lookup failed"),
        hostId: z.string().nullable().optional().describe("Bound NST host ID on kind=sessionBound; null when identity lookup failed"),
        warning: z.string().optional().describe("Nonfatal NST identity lookup detail on a warning-form sessionBound event"),
        objectType: z.number().optional(),
        objectId: z.number().optional(),
        file: z.string().optional().describe("Local source file of the break, when mappable"),
        line: z.number().optional().describe("1-based"),
        errorMessage: z.string().optional().describe("Present when the break came from break-on-error"),
        stack: z.array(stackFrameSchema).optional(),
        results: runTestsOutputSchema.nullable().optional().describe("Test results, on kind=testRunFinished"),
        terminateSession: z.boolean().optional(),
        message: z.string().optional().describe("Fatal error detail, on kind=fatal"),
        droppedEvents: z.number().optional().describe("Events discarded because the 100-event queue overflowed (cumulative for the session); absent when none were lost"),
      }),
      handler: async (params) => {
        const session = requireSession(state);
        const event = await session.wait((params["timeoutMs"] as number | undefined) ?? 30000);
        const result =
          "timedOut" in event
            ? event
            : event.kind === "testRunFinished"
              ? { ...event, results: session.lastTestRun }
              : annotateFiles(session, event as never);
        return session.droppedEvents > 0 ? { ...result, droppedEvents: session.droppedEvents } : result;
      },
    },
    {
      name: "bcdev_debug_continue",
      title: "Continue / step",
      description:
        "Resume from a break: continue, stepOver, stepInto, or stepOut — then bcdev_debug_wait for the next event. abort terminates the paused operation (a bound test run reports it as failed); release lets it run to completion undebugged. Both end debugging with a detached event.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      schema: {
        action: z
          .enum(["continue", "stepOver", "stepInto", "stepOut", "release", "abort"])
          .describe("continue resumes; step actions advance one statement (over/into/out of calls); abort kills the paused operation and detaches; release lets it finish undebugged and detaches — re-attach to debug again"),
      },
      outputSchema: z.object({ ok: z.literal(true) }),
      handler: async (params) => {
        const session = requireSession(state);
        const transition = session.beginResume();
        try {
          await session.client.step(params["action"] as StepAction);
          return { ok: true };
        } catch (error) {
          session.rollbackResume(transition);
          throw error;
        }
      },
    },
    {
      name: "bcdev_debug_variables",
      title: "Inspect variables",
      description: "Inspect variables at a break: frame locals by default, a child path via expand, or global variables via globals.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      schema: {
        frameId: z.number().describe("Stack frame index from the break event: 0 = innermost frame"),
        // WIRE: ExpandNode path is dot-joined node names, parentPath + '.' + name; globals root is the literal <Globals>
        // (esp-decomp DebugAdapterVariablesRequestHandler.cs:186 and :16 GlobalsPath).
        expand: z
          .string()
          .optional()
          .describe(
            "Dot-joined variable path to expand, e.g. 'Customer' or 'Customer.Fields'. Segment names come from the variable list; global variables live under '<Globals>'.",
          ),
        globals: z.boolean().optional().describe("Return the frame's global variables instead of locals"),
      },
      outputSchema: z.object({ variables: z.array(variableNodeSchema) }),
      handler: async (params) => {
        const client = requireSession(state).client;
        const frameId = params["frameId"] as number;
        if (params["expand"]) return { variables: await client.expandNode(frameId, params["expand"] as string) };
        if (params["globals"]) return { variables: await client.expandGlobals(frameId) };
        return { variables: await client.getVariables(frameId) };
      },
    },
    {
      name: "bcdev_debug_eval",
      title: "Evaluate watch expression",
      description: "Evaluate a watch expression at a break. Only simple identifier/member paths resolve; compound expressions with operators return <Out Of Scope>.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      schema: {
        frameId: z.number().describe("Stack frame index from the break event: 0 = innermost frame"),
        expression: z.string().describe('AL identifier or member path, e.g. CustomerName or Customer."No." — operators are not evaluated'),
      },
      outputSchema: z.object({ result: variableNodeSchema.nullable().describe("null when the expression did not resolve") }),
      handler: async (params) => {
        const node = await requireSession(state).client.evalWatch(params["frameId"] as number, params["expression"] as string);
        return { result: node ?? null };
      },
    },
    {
      name: "bcdev_debug_sql",
      title: "SQL statistics at a break",
      description:
        "Read live SQL cost at a break: current latency, execute count, and the last (and long-running) SQL statements. Requires attaching with sqlInsight: true.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      schema: {
        frameId: z.number().optional().describe("Stack frame index from the break event (default 0 = innermost frame)"),
      },
      outputSchema: z.object({
        currentLatencyMs: z.number().nullable(),
        sqlExecutes: z.number().nullable(),
        lastStatements: z.array(sqlStatementSchema),
        lastLongRunning: z.array(sqlStatementSchema).describe("Statements slower than longRunningSqlThresholdMs, when that was set"),
      }),
      handler: async (params) => {
        const client = requireSession(state).client;
        const frameId = (params["frameId"] as number | undefined) ?? 0;
        const insight = await parseDatabaseStatistics(
          await client.getVariables(frameId),
          (path) => client.expandNode(frameId, path),
        );
        if (!insight) throw new BcDevError("SQL_INSIGHT_NOT_ENABLED", "SQL insight is off — re-attach with sqlInsight: true (bcdev_debug_attach)", "state");
        return insight;
      },
    },
    {
      name: "bcdev_debug_breakpoints",
      title: "Manage breakpoints",
      description: "Add or remove breakpoints in the active session. Adds only succeed after the session has paused at least once.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      schema: {
        add: z.array(breakpointShape).optional().describe("Breakpoints to add"),
        remove: z.array(z.number()).optional().describe("Breakpoint IDs to remove (returned by a previous add)"),
      },
      outputSchema: z.object({ added: z.array(addedBreakpointSchema), removed: z.array(z.number()) }),
      handler: async (params) => {
        const session = requireSession(state);
        const removed: number[] = [];
        for (const id of (params["remove"] as number[] | undefined) ?? []) {
          await session.client.removeBreakpoint(id);
          session.breakpoints.delete(id);
          removed.push(id);
        }
        const project = session.index.projectDir;
        const added = await mapBreakpoints(
          session,
          project,
          (params["add"] as Array<{ file: string; line: number; condition?: string }> | undefined) ?? [],
        );
        return { added, removed };
      },
    },
    {
      name: "bcdev_debug_detach",
      title: "Detach debugger",
      description: "Stop debugging and close the session.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      schema: {},
      outputSchema: z.object({ detached: z.literal(true) }),
      handler: async () => {
        const session = requireSession(state);
        state.debug = null;
        try {
          await session.client.stop();
        } finally {
          if (session.debugSlotToken) state.releaseDebugSlot(session.debugSlotToken);
        }
        return { detached: true };
      },
    },
  ];
}
