import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AL_OBJECT_TYPE, AlObjectIndex } from "../../core/al-objects";
import { BcDevError } from "../../core/agent-errors";
import { DebuggerClient } from "../../core/hubs/debugger-hub";
import { diffStaticVsObserved, type StaticWritersResult } from "../../core/alsem-writes";
import {
  RecordWriteCollector,
  type RecordWriteStatus,
} from "../../core/record-write-triage";
import type { ServerState } from "../state";
import {
  assertHandle,
  connectionShape,
  handleShape,
  normalizeDebugTarget,
  RECORDING_HANDLE,
  resolve,
  stackFrameSchema,
  type ToolDefinition,
  type ToolDeps,
} from "./shared";

const summarySchema = z.object({
  observedWrites: z.number().describe("All record-write breaks observed in this capture window"),
  matchedWrites: z.number().describe("Observed writes proven to target tableId"),
  uniqueWriters: z.number().describe("Distinct operation/receiver/full-stack groups writing tableId"),
  unrelatedWrites: z.number().describe("Observed writes proven to target another table"),
  unresolvedWrites: z.number().describe("Observed writes whose runtime table identity could not be proven"),
}).describe("Current record-write classification counts");

const targetSchema = z.object({
  tableId: z.number().describe("Requested numeric Business Central table ID"),
  tableName: z.string().nullable().describe("Runtime table name once an exact target match establishes it"),
}).describe("Capture target");

const writerSchema = z.object({
  operation: z.enum(["insert", "modify", "modifyAll", "rename", "delete", "deleteAll"])
    .describe("Documented AL record-write operation"),
  receiver: z.string().describe("AL record or RecordRef receiver evaluated at the break"),
  count: z.number().describe("Occurrences sharing this operation, receiver, and complete stack"),
  firstSequence: z.number().describe("First observed-write sequence in this group"),
  lastSequence: z.number().describe("Last observed-write sequence in this group"),
  source: z.enum(["deployed", "localAsserted"]).describe("Source provenance used to identify the receiver"),
  stack: z.array(stackFrameSchema).describe("Complete normalized AL call stack for this writer"),
}).describe("One grouped exact writer");

const unresolvedSchema = z.object({
  reason: z.enum([
    "sourceUnavailable",
    "statementSpanUnavailable",
    "writeStatementUnrecognized",
    "multipleWriteCandidates",
    "receiverUnsupported",
    "receiverUnavailable",
    "receiverTypeUnresolved",
    "inspectionFailed",
    "unexpectedBreak",
  ]).describe("Stable reason the runtime target table could not be proven"),
  operation: z.enum(["insert", "modify", "modifyAll", "rename", "delete", "deleteAll"])
    .nullable()
    .describe("Parsed write operation, when available"),
  receiver: z.string().nullable().describe("Parsed receiver, when available"),
  count: z.number().describe("Occurrences sharing this reason and complete stack"),
  firstSequence: z.number().describe("First observed-write sequence in this group"),
  lastSequence: z.number().describe("Last observed-write sequence in this group"),
  stack: z.array(stackFrameSchema).describe("Complete normalized AL call stack for the unresolved write"),
}).describe("One grouped unresolved write");

const strayBindsSchema = z.number()
  .describe("Binds that detached before any break (stray sessions, seen with breakOnNext WebServiceClient); each is listed in warnings");
const rearmsSchema = z.number().describe("Successful re-attaches after stray binds");

const statusSchema = z.object({
  phase: z.enum(["arming", "rearming", "collecting", "stopped", "failed"])
    .describe("Background capture lifecycle phase; rearming = a stray bind detached before any break and the debugger re-attaches after a delay (writes in that window are missed)"),
  target: targetSchema,
  sessionId: z.number().nullable().describe("Bound NST session ID, or null before binding/when identity lookup failed"),
  summary: summarySchema,
  strayBinds: strayBindsSchema,
  rearms: rearmsSchema,
  truncated: z.boolean().describe("true when maxObservedWrites released the workload before full observation"),
  warning: z.string().nullable().describe("Most recent redacted nonfatal or terminal warning"),
});

const reportSchema = z.object({
  target: targetSchema,
  outcome: z.enum(["completed", "truncated", "failed"]).describe("Final capture outcome"),
  stopReason: z.enum(["finished", "sessionDetached", "maxObservedWrites", "strayBindsExhausted", "fatal"])
    .describe("Why collection ended; strayBindsExhausted = more stray binds than maxRearms (re-arm with breakOnNext Background/WebClient or a sessionId)"),
  complete: z.boolean().describe("true only when every write observed in this capture window was classified without evidence loss"),
  truncated: z.boolean().describe("true when the observed-write safety cap ended collection"),
  summary: summarySchema,
  strayBinds: strayBindsSchema,
  rearms: rearmsSchema,
  writers: z.array(writerSchema).describe("Exact target-table writer groups"),
  unresolved: z.array(unresolvedSchema).describe("Fail-closed groups that could not be attributed to a runtime table"),
  warnings: z.array(z.string()).describe("Redacted lifecycle, source-trust, truncation, or classification warnings"),
});

const recordingId = handleShape(RECORDING_HANDLE);

const staticSiteSchema = z.object({
  operation: z.string().describe("al-sem db operation: Insert | Modify | ModifyAll | Delete | DeleteAll | Rename"),
  objectType: z.string().describe("AL object type of the writing routine, e.g. Codeunit"),
  objectId: z.number(),
  objectDisplay: z.string(),
  routine: z.string(),
  file: z.string().describe("Workspace-relative path"),
  line: z.number().describe("1-based"),
  tempState: z.string().describe("al-sem temp-record state: known(false) | known(true) | unknown"),
  via: z.string().describe("direct = the routine writes itself; inherited = reached through a callee"),
}).describe("One statically known write site");

const staticWritersSchema = z.object({
  available: z.boolean().describe("false = al-sem is missing or could not answer; the cross-check is absent, not failed"),
  warnings: z.array(z.string()),
  alsemVersion: z.string().optional(),
  table: z.object({ selector: z.string(), name: z.string().nullable() }).optional()
    .describe("The alsem table selector that resolved (<appId>/table/<tableId> first, then the table name)"),
  routinesScanned: z.number().optional(),
  sites: z.array(staticSiteSchema).describe("Writes al-sem proves target the table"),
  unknownBucketSites: z.array(staticSiteSchema).describe("Writes whose target al-sem could not resolve (RecordRef/Variant); any might hit the table"),
  caveats: z.array(z.string()),
}).describe("al-sem static writer sites for the watched table");

const staticCrossCheckSchema = z.object({
  available: z.boolean(),
  warnings: z.array(z.string()),
  matched: z.number().optional().describe("Static sites that were also observed"),
  staticNotObserved: z.array(staticSiteSchema).optional().describe("Statically possible, never observed in this capture"),
  observedNotStatic: z.array(z.object({
    operation: z.string(),
    receiver: z.string(),
    count: z.number(),
    frame: z.object({
      objectType: z.number(), objectId: z.number(), objectName: z.string(), methodName: z.string(),
      line: z.number().describe("1-based"), file: z.string().optional(),
    }),
    inUnknownBucket: z.boolean().describe("true = al-sem has a write at this site but could not resolve its table"),
  })).optional().describe("Observed, but not in al-sem's proven static set for the table"),
  observationComplete: z.boolean().optional().describe("false = the capture was incomplete, so 'never observed' proves little"),
  caveats: z.array(z.string()).optional(),
}).describe("Static (al-sem) versus observed writer diff");

function staticWritersView(result: StaticWritersResult): z.infer<typeof staticWritersSchema> {
  const w = result.writers;
  return {
    available: w !== null,
    warnings: result.warnings,
    ...(w
      ? { alsemVersion: w.alsemVersion, table: w.table, routinesScanned: w.routinesScanned }
      : {}),
    sites: w?.sites ?? [],
    unknownBucketSites: w?.unknownBucketSites ?? [],
    caveats: w?.caveats ?? [],
  };
}

function requireTriage(state: ServerState, params: Record<string, unknown>): RecordWriteCollector {
  assertHandle(RECORDING_HANDLE, params, state.recordWrites ? state.recordingId : null);
  if (!state.recordWrites) {
    throw new BcDevError(
      "RECORD_WRITE_TRIAGE_NOT_ACTIVE",
      "No active record-write triage — call bcdev_record_writes_start first",
      "state",
    );
  }
  return state.recordWrites;
}

function normalizeStart(params: Record<string, unknown>): {
  tableId: number;
  includeTemporary: boolean;
  changesDeployed: boolean;
  maxObservedWrites: number;
  maxRearms: number;
} {
  const tableId = params["tableId"];
  if (typeof tableId !== "number" || !Number.isSafeInteger(tableId) || tableId <= 0) {
    throw new BcDevError("INVALID_ARGUMENT", "tableId must be a positive integer", "validation");
  }
  const maxObservedWrites = params["maxObservedWrites"] ?? 500;
  if (
    typeof maxObservedWrites !== "number"
    || !Number.isInteger(maxObservedWrites)
    || maxObservedWrites < 1
    || maxObservedWrites > 10000
  ) {
    throw new BcDevError(
      "INVALID_ARGUMENT",
      "maxObservedWrites must be an integer from 1 through 10000",
      "validation",
    );
  }
  const maxRearms = params["maxRearms"] ?? 3;
  if (typeof maxRearms !== "number" || !Number.isInteger(maxRearms) || maxRearms < 0 || maxRearms > 10) {
    throw new BcDevError("INVALID_ARGUMENT", "maxRearms must be an integer from 0 through 10", "validation");
  }
  if (params["includeTemporary"] !== undefined && typeof params["includeTemporary"] !== "boolean") {
    throw new BcDevError("INVALID_ARGUMENT", "includeTemporary must be a boolean", "validation");
  }
  if (params["changesDeployed"] !== undefined && typeof params["changesDeployed"] !== "boolean") {
    throw new BcDevError("INVALID_ARGUMENT", "changesDeployed must be a boolean", "validation");
  }
  return {
    tableId,
    includeTemporary: (params["includeTemporary"] as boolean | undefined) ?? false,
    changesDeployed: (params["changesDeployed"] as boolean | undefined) ?? false,
    maxObservedWrites,
    maxRearms,
  };
}

export function createRecordWriteTools(state: ServerState, deps: ToolDeps): ToolDefinition[] {
  return [
    {
      name: "bcdev_record_writes_start",
      title: "Start table write triage",
      description:
        "Arm background record-write triage for one numeric table ID. Business Central breaks globally; the collector identifies each runtime receiver, groups exact target stacks, and auto-continues. Trigger the matching workload after start, then check status and finish. A next-session or user-filtered attach whose bound session detaches before any break (a stray bind; about half the attaches with breakOnNext WebServiceClient on BC28) is re-armed automatically after ~10 s, up to maxRearms; status shows phase rearming, and a workload started during that window is missed, so trigger it only after status has shown phase arming for about 2.5 s (a stray detaches within milliseconds of an attach). Returns recordingId, an opaque handle to pass to bcdev_record_writes_status/finish (optional there; it must match when given); it stays valid until bcdev_record_writes_finish or server restart.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      schema: {
        ...connectionShape,
        tableId: z.number().int().positive().describe("Positive Business Central table ID to match exactly at runtime"),
        breakOnNext: z
          .enum(["WebClient", "WebServiceClient", "Background"])
          .optional()
          .describe("Client type for default/user-filtered next-session attach (default WebClient); exact sessionId takes precedence"),
        sessionId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Positive existing NST session ID; mutually exclusive with userId"),
        userId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Business Central user ID whose next matching session should bind; mutually exclusive with sessionId"),
        includeTemporary: z
          .boolean()
          .optional()
          .describe("Include temporary-record writes (default false; false uses the proven nonTemporary debugger mode)"),
        changesDeployed: z
          .boolean()
          .optional()
          .describe("Caller assertion that local AL source is exactly deployed; required before local-source fallback can prove a match"),
        maxObservedWrites: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe("Safety cap across all observed writes (default 500); reaching it releases the workload undebugged"),
        maxRearms: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe("Stray binds (detach before any break) re-armed per capture before stopping with strayBindsExhausted (default 3; ignored with sessionId)"),
      },
      outputSchema: z.object({
        armed: z.literal(true).describe("Debugger attach succeeded and background collection is armed"),
        recordingId: z.string().describe("Opaque handle for this capture; pass it to bcdev_record_writes_status/finish. Valid until bcdev_record_writes_finish"),
        connectionId: z.string().nullable().describe("Debugger hub connection ID"),
        target: targetSchema,
        includeTemporary: z.boolean().describe("Whether temporary writes are included"),
        changesDeployed: z.boolean().describe("Caller-provided local source deployment assertion"),
        maxObservedWrites: z.number().describe("Effective observed-write safety cap"),
        maxRearms: z.number().describe("Effective stray-bind re-arm budget (0 with sessionId: an exact session that detaches has ended)"),
        staticWriters: staticWritersSchema.optional()
          .describe("al-sem static writer sites for the table; omitted when no static provider is configured"),
      }),
      handler: async (params) => {
        state.assertDebugSlotAvailable();
        const target = normalizeDebugTarget(params);
        const options = normalizeStart(params);
        const slotToken = state.claimDebugSlot("recordWrites");
        const client = new DebuggerClient(deps.hubFactory);
        let collector: RecordWriteCollector | null = null;
        try {
          const { config, authorization, project } = resolve(params, deps);
          const index = await AlObjectIndex.build(project);
          const attachOptions = {
            breakOnNext: params["breakOnNext"] as "WebClient" | "WebServiceClient" | "Background" | undefined,
            ...target,
            breakOnError: false,
            breakOnRecordWrite: options.includeTemporary ? "all" as const : "nonTemporary" as const,
            skipSystemTriggers: false,
          };
          const attach = () => client.connect(config, authorization, attachOptions);
          // An exact session that detaches has ended; only next-session/user-filtered arms can bind a stray.
          const maxRearms = target.sessionId === undefined ? options.maxRearms : 0;
          collector = new RecordWriteCollector({
            tableId: options.tableId,
            changesDeployed: options.changesDeployed,
            maxObservedWrites: options.maxObservedWrites,
            client,
            localSource: async (objectType, objectId) => {
              const file = index.byId(objectType, objectId)?.file;
              if (!file) return null;
              return await readFile(file, "utf8").catch(() => null);
            },
            localFile: (objectType, objectId) => index.byId(objectType, objectId)?.file,
            // maxRearms 0 still counts the stray (strayBindsExhausted on the first); only an exact session never has strays.
            ...(target.sessionId === undefined ? { rearm: { attach, maxRearms } } : {}),
          });
          const id = randomUUID();
          state.recordWrites = collector;
          state.recordWriteSlotToken = slotToken;
          state.recordingId = id;
          client.onEvent = (event) => collector?.onEvent(event);
          await attach();
          // Optional al-sem enrichment (never throws): seeds the finish-time static-vs-observed diff.
          let staticWriters: z.infer<typeof staticWritersSchema> | undefined;
          if (deps.staticWriters) {
            const tableName = index.byId(AL_OBJECT_TYPE["table"]!, options.tableId)?.name ?? null;
            const result = await deps.staticWriters({ project, tableId: options.tableId, tableName, includeTemporary: options.includeTemporary });
            state.recordWriteStatic = { project, tableId: options.tableId, includeTemporary: options.includeTemporary, tableName, result };
            staticWriters = staticWritersView(result);
          }
          return {
            armed: true,
            recordingId: id,
            connectionId: client.connectionId,
            target: { tableId: options.tableId, tableName: null },
            includeTemporary: options.includeTemporary,
            changesDeployed: options.changesDeployed,
            maxObservedWrites: options.maxObservedWrites,
            maxRearms,
            ...(staticWriters ? { staticWriters } : {}),
          };
        } catch (error) {
          if (state.recordWrites === collector) {
            state.recordWrites = null;
            state.recordingId = null;
          }
          if (state.recordWriteSlotToken === slotToken) state.recordWriteSlotToken = null;
          state.recordWriteStatic = null;
          state.releaseDebugSlot(slotToken);
          await client.stop().catch(() => {});
          throw error;
        }
      },
    },
    {
      name: "bcdev_record_writes_status",
      title: "Check table write triage",
      description:
        "Read background table-write triage progress. Collection and automatic continuation do not depend on polling.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      schema: { recordingId },
      outputSchema: statusSchema,
      handler: async (params): Promise<RecordWriteStatus> => requireTriage(state, params).status(),
    },
    {
      name: "bcdev_record_writes_finish",
      title: "Finish table write triage",
      description:
        "Finish the capture window, release a paused workload undebugged if necessary, close the debugger, and return grouped exact writers plus fail-closed unresolved evidence.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      schema: { recordingId },
      outputSchema: reportSchema.extend({
        staticCrossCheck: staticCrossCheckSchema.optional()
          .describe("al-sem static writer sites diffed against the observed stacks; omitted when no static provider was configured at start"),
      }),
      handler: async (params) => {
        const collector = requireTriage(state, params);
        state.recordWrites = null;
        state.recordingId = null;
        const slotToken = state.recordWriteSlotToken;
        state.recordWriteSlotToken = null;
        const seed = state.recordWriteStatic;
        state.recordWriteStatic = null;
        try {
          const report = await collector.finish();
          if (!seed || !deps.staticWriters) return report;
          let result = seed.result;
          // The table was not resolvable at start (e.g. a base-app table): retry with the runtime name the debugger reported.
          const observedName = report.target.tableName;
          if (!result.writers && observedName && observedName !== seed.tableName) {
            const retry = await deps.staticWriters({ project: seed.project, tableId: seed.tableId, tableName: observedName, includeTemporary: seed.includeTemporary });
            if (retry.writers) result = retry;
          }
          // Unavailable: start already carried the single warning, so finish stays silent.
          if (!result.writers) return report;
          return {
            ...report,
            staticCrossCheck: { available: true, warnings: result.warnings, ...diffStaticVsObserved(result.writers, report.writers, report.complete) },
          };
        } finally {
          if (slotToken) state.releaseDebugSlot(slotToken);
        }
      },
    },
  ];
}
