import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AlObjectIndex } from "../../core/al-objects";
import { BcDevError } from "../../core/agent-errors";
import { DebuggerClient } from "../../core/hubs/debugger-hub";
import {
  RecordWriteCollector,
  type RecordWriteReport,
  type RecordWriteStatus,
} from "../../core/record-write-triage";
import type { ServerState } from "../state";
import {
  connectionShape,
  normalizeDebugTarget,
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

const statusSchema = z.object({
  phase: z.enum(["arming", "collecting", "stopped", "failed"]).describe("Background capture lifecycle phase"),
  target: targetSchema,
  sessionId: z.number().nullable().describe("Bound NST session ID, or null before binding/when identity lookup failed"),
  summary: summarySchema,
  truncated: z.boolean().describe("true when maxObservedWrites released the workload before full observation"),
  warning: z.string().nullable().describe("Most recent redacted nonfatal or terminal warning"),
});

const reportSchema = z.object({
  target: targetSchema,
  outcome: z.enum(["completed", "truncated", "failed"]).describe("Final capture outcome"),
  stopReason: z.enum(["finished", "sessionDetached", "maxObservedWrites", "fatal"]).describe("Why collection ended"),
  complete: z.boolean().describe("true only when every write observed in this capture window was classified without evidence loss"),
  truncated: z.boolean().describe("true when the observed-write safety cap ended collection"),
  summary: summarySchema,
  writers: z.array(writerSchema).describe("Exact target-table writer groups"),
  unresolved: z.array(unresolvedSchema).describe("Fail-closed groups that could not be attributed to a runtime table"),
  warnings: z.array(z.string()).describe("Redacted lifecycle, source-trust, truncation, or classification warnings"),
});

function requireTriage(state: ServerState): RecordWriteCollector {
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
  };
}

export function createRecordWriteTools(state: ServerState, deps: ToolDeps): ToolDefinition[] {
  return [
    {
      name: "bcdev_record_writes_start",
      title: "Start table write triage",
      description:
        "Arm background record-write triage for one numeric table ID. Business Central breaks globally; the collector identifies each runtime receiver, groups exact target stacks, and auto-continues. Trigger the matching workload after start, then check status and finish.",
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
      },
      outputSchema: z.object({
        armed: z.literal(true).describe("Debugger attach succeeded and background collection is armed"),
        connectionId: z.string().nullable().describe("Debugger hub connection ID"),
        target: targetSchema,
        includeTemporary: z.boolean().describe("Whether temporary writes are included"),
        changesDeployed: z.boolean().describe("Caller-provided local source deployment assertion"),
        maxObservedWrites: z.number().describe("Effective observed-write safety cap"),
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
          collector = new RecordWriteCollector({
            ...options,
            client,
            localSource: async (objectType, objectId) => {
              const file = index.byId(objectType, objectId)?.file;
              if (!file) return null;
              return await readFile(file, "utf8").catch(() => null);
            },
            localFile: (objectType, objectId) => index.byId(objectType, objectId)?.file,
          });
          state.recordWrites = collector;
          state.recordWriteSlotToken = slotToken;
          client.onEvent = (event) => collector?.onEvent(event);
          await client.connect(config, authorization, {
            breakOnNext: params["breakOnNext"] as "WebClient" | "WebServiceClient" | "Background" | undefined,
            ...target,
            breakOnError: false,
            breakOnRecordWrite: options.includeTemporary ? "all" : "nonTemporary",
            skipSystemTriggers: false,
          });
          return {
            armed: true,
            connectionId: client.connectionId,
            target: { tableId: options.tableId, tableName: null },
            includeTemporary: options.includeTemporary,
            changesDeployed: options.changesDeployed,
            maxObservedWrites: options.maxObservedWrites,
          };
        } catch (error) {
          if (state.recordWrites === collector) state.recordWrites = null;
          if (state.recordWriteSlotToken === slotToken) state.recordWriteSlotToken = null;
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
      schema: {},
      outputSchema: statusSchema,
      handler: async (): Promise<RecordWriteStatus> => requireTriage(state).status(),
    },
    {
      name: "bcdev_record_writes_finish",
      title: "Finish table write triage",
      description:
        "Finish the capture window, release a paused workload undebugged if necessary, close the debugger, and return grouped exact writers plus fail-closed unresolved evidence.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      schema: {},
      outputSchema: reportSchema,
      handler: async (): Promise<RecordWriteReport> => {
        const collector = requireTriage(state);
        state.recordWrites = null;
        const slotToken = state.recordWriteSlotToken;
        state.recordWriteSlotToken = null;
        try {
          return await collector.finish();
        } finally {
          if (slotToken) state.releaseDebugSlot(slotToken);
        }
      },
    },
  ];
}
