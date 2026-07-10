import { z } from "zod";
import { AlObjectIndex } from "../../core/al-objects";
import { DebuggerClient, type StepAction } from "../../core/hubs/debugger-hub";
import { TestRunnerClient } from "../../core/hubs/test-runner-hub";
import { DebugSession, type ServerState } from "../state";
import {
  addedBreakpointSchema,
  annotateFiles,
  breakpointShape,
  codeunitsShape,
  connectionShape,
  mapBreakpoints,
  requireSession,
  resolve,
  runTestsOutputSchema,
  stackFrameSchema,
  type ToolDefinition,
  type ToolDeps,
  variableNodeSchema,
} from "./shared";

export function createDebugTools(state: ServerState, deps: ToolDeps): ToolDefinition[] {
  return [
    {
      name: "bcdev_debug_attach",
      title: "Attach AL debugger",
      description: "Attach the AL debugger to the BC server. One session at a time. Follow with bcdev_debug_run_tests, then bcdev_debug_wait.",
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
          .describe("Which client session type the debugger binds to (default WebClient)"),
        breakOnError: z.boolean().optional().describe("Pause when an AL runtime error occurs (default true)"),
        breakOnRecordWrite: z.boolean().optional().describe("Pause on record writes (default false)"),
        skipSystemTriggers: z.boolean().optional().describe("Skip breaks inside system triggers (default true)"),
      },
      outputSchema: z.object({
        attached: z.literal(true),
        connectionId: z.string().nullable(),
        breakpoints: z.array(addedBreakpointSchema),
      }),
      handler: async (params) => {
        if (state.debug) throw new Error("Debug session already active — call bcdev_debug_detach first");
        const { config, project } = resolve(params, deps);
        const client = new DebuggerClient(deps.hubFactory);
        const index = await AlObjectIndex.build(project);
        const session = new DebugSession(client, index);
        state.debug = session; // claim the slot before awaiting — blocks concurrent attach
        client.onEvent = (e) => session.push(e);
        try {
          await client.connect(config, {
            breakOnNext: params["breakOnNext"] as never,
            breakOnError: params["breakOnError"] as boolean | undefined,
            breakOnRecordWrite: params["breakOnRecordWrite"] as boolean | undefined,
            skipSystemTriggers: params["skipSystemTriggers"] as boolean | undefined,
          });
          const breakpoints = await mapBreakpoints(
            session,
            project,
            (params["breakpoints"] as Array<{ file: string; line: number; condition?: string }> | undefined) ?? [],
          );
          return { attached: true, connectionId: client.connectionId, breakpoints };
        } catch (err) {
          state.debug = null;
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
        if (state.testRunActive) throw new Error("A test run is already running — wait for it to finish");
        const { config } = resolve(params, deps);
        const debuggingContext = session.client.connectionId ?? "";
        state.testRunActive = true;
        void new TestRunnerClient(deps.hubFactory)
          .run(config, params["codeunits"] as Array<{ id: number; methods?: string[] }>, {
            company: params["company"] as string | undefined,
            debuggingContext,
          })
          .then((result) => {
            session.lastTestRun = result;
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
      },
    },
    {
      name: "bcdev_debug_wait",
      title: "Wait for debugger event",
      description:
        "Wait for the next debugger event (break, testRunFinished, detached, fatal). Timing out is a normal result — call again to keep waiting. Events queue up to 100 between calls; beyond that the oldest are discarded and droppedEvents reports how many.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      schema: { timeoutMs: z.number().min(1).max(300000).optional().describe("Max wait in milliseconds (default 30000, max 300000)") },
      // single loose object, NOT a union (SDK 1.29 drops non-object outputSchema)
      outputSchema: z.looseObject({
        timedOut: z.boolean().optional().describe("true = no event within timeoutMs; normal — call again"),
        kind: z.enum(["break", "testRunFinished", "detached", "fatal"]).optional(),
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
      description: "Resume from a break: continue, stepOver, stepInto, or stepOut. Then bcdev_debug_wait for the next event.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      schema: {
        action: z
          .enum(["continue", "stepOver", "stepInto", "stepOut"])
          .describe("continue resumes; the step actions advance one statement (over/into/out of calls)"),
      },
      outputSchema: z.object({ ok: z.literal(true) }),
      handler: async (params) => {
        await requireSession(state).client.step(params["action"] as StepAction);
        return { ok: true };
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
        await session.client.stop();
        return { detached: true };
      },
    },
  ];
}
