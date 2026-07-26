import { z } from "zod";
import type { ToolDefinition } from "./shared";

const AL_PERF_HINT =
  "For deep analysis (anti-patterns, AI insights), pass this .alcpuprofile to al-perf (github.com/SShadowS/al-perf).";

function generatedNextSteps(name: string, result: Record<string, unknown>, params: Record<string, unknown>): string[] {
  switch (name) {
    case "bcdev_status":
      return result["supportsTestRunning"] === true
        ? ["Call bcdev_test_discover to find local AL tests, or bcdev_debug_attach to start debugging."]
        : ["Use a Business Central server with developer API 7.0 or newer for test and debugger tools."];
    case "bcdev_test_discover":
      return Array.isArray(result["tests"]) && result["tests"].length > 0
        ? ["Call bcdev_test_run with the returned codeunit IDs."]
        : [];
    case "bcdev_test_run": {
      const summary = result["summary"] as Record<string, unknown> | undefined;
      const steps: string[] = [];
      if (summary?.["outcome"] === "failed") steps.push("Call bcdev_debug_attach, then bcdev_debug_run_tests for the failed methods.");
      if (summary?.["outcome"] === "aborted") steps.push("Call bcdev_status, correct the abort cause, and retry bcdev_test_run.");
      const gaps = result["coverageGaps"] as {
        complete?: boolean;
        deployment?: Record<string, unknown>;
        summary?: Record<string, unknown>;
      } | undefined;
      if (Number(gaps?.summary?.["uncovered"] ?? 0) > 0) {
        steps.push("Add or select tests that exercise the uncovered changed procedures, then rerun bcdev_test_run with the same coverageAgainst ref.");
      }
      if (gaps?.deployment?.["status"] === "unverified" && Number(gaps?.summary?.["changedProcedures"] ?? 0) > 0) {
        steps.push("Publish the current changed AL objects, confirm that deployment, then rerun bcdev_test_run with changesDeployed: true and the same coverageAgainst ref.");
      } else if (Number(gaps?.summary?.["unknown"] ?? 0) > 0) {
        steps.push("Resolve the coverageGaps warnings before treating changed-procedure coverage as a complete gate.");
      }
      if (Number(gaps?.summary?.["unattributedChanges"] ?? 0) > 0) {
        steps.push("Review the changed lines with no procedure identity listed in coverageGaps warnings; procedure coverage cannot gate them.");
      }
      if (gaps?.complete === false && Number(gaps?.summary?.["unknown"] ?? 0) === 0 &&
          Number(gaps?.summary?.["unattributedChanges"] ?? 0) === 0) {
        steps.push("Review coverageGaps warnings and resolve incomplete discovery or an aborted run before using the result as a gate.");
      }
      return steps;
    }
    case "bcdev_debug_attach":
      return params["sessionId"] === undefined
        ? ["Create or trigger the matching session, then call bcdev_debug_wait."]
        : ["Call bcdev_debug_wait to confirm attachment, then drive the target operation."];
    case "bcdev_debug_run_tests":
    case "bcdev_debug_continue":
      return ["Call bcdev_debug_wait for the next debugger lifecycle event."];
    case "bcdev_debug_wait":
      if (result["timedOut"] === true) return ["Confirm that the matching session or workload has been triggered, then call bcdev_debug_wait again."];
      if (result["kind"] === "break") return ["Inspect with bcdev_debug_variables or bcdev_debug_eval, then call bcdev_debug_continue."];
      if (result["kind"] === "sessionBound") return ["Drive the operation you want to inspect, if it has not already begun, then call bcdev_debug_wait again."];
      if (result["kind"] === "testRunFinished") return ["Review the test results, then call bcdev_debug_detach."];
      if (result["kind"] === "fatal") return ["Call bcdev_debug_detach, then bcdev_status before retrying."];
      return [];
    case "bcdev_debug_variables":
      return ["Expand another variable path or call bcdev_debug_continue when inspection is complete."];
    case "bcdev_debug_eval":
    case "bcdev_debug_sql":
    case "bcdev_debug_breakpoints":
      return ["Continue the current investigation or call bcdev_debug_continue if the debugger is paused."];
    case "bcdev_source":
      return [];
    case "bcdev_debug_detach":
      return [];
    case "bcdev_record_writes_start":
      return ["Trigger the matching session and target operation, then call bcdev_record_writes_status."];
    case "bcdev_record_writes_status":
      if (result["phase"] === "arming") {
        return ["Trigger the matching session and target operation, then call bcdev_record_writes_status again."];
      }
      if (result["phase"] === "collecting") {
        return ["Let the target operation finish, then call bcdev_record_writes_finish for the grouped writer report."];
      }
      return ["Call bcdev_record_writes_finish to retrieve the retained report and clear the debugger slot."];
    case "bcdev_record_writes_finish": {
      const summary = result["summary"] as Record<string, unknown> | undefined;
      if (result["truncated"] === true) {
        return ["Narrow the target workload or deliberately raise maxObservedWrites, then rerun the capture."];
      }
      if (result["complete"] !== true) {
        return ["Review unresolved groups and warnings before treating the capture window as exhaustive, then rerun with trusted deployed source if needed."];
      }
      return Number(summary?.["matchedWrites"] ?? 0) > 0
        ? ["Review the grouped writer stacks and occurrence counts."]
        : [];
    }
    case "bcdev_profile_status":
      if (result["reachable"] !== true) {
        return ["Correct connectivity, authentication, or snapshot-port settings, then call bcdev_profile_status again."];
      }
      return result["sampleProfilingSupported"] === true
        ? ["Call bcdev_profile_start to arm a supported profile capture."]
        : ["Use a Business Central server that supports the requested profile mode."];
    case "bcdev_profile_start":
      return ["Trigger the target workload, then call bcdev_profile_poll until it reports ready."];
    case "bcdev_profile_poll": {
      switch (result["status"]) {
        case "Initialized":
          return ["Trigger or continue the target workload, then call bcdev_profile_poll again."];
        case "Started":
          return ["Call bcdev_profile_finish to save and summarize the capture."];
        case "Finished":
          return ["Call bcdev_profile_finish to retrieve and clear the completed capture."];
        case "Failed":
          return ["Call bcdev_profile_finish to clear the failed capture, then review the result before starting another capture."];
        default:
          return [];
      }
    }
    case "bcdev_profile_finish":
      if (result["captured"] === false) {
        return ["Start a new capture, trigger the matching workload, poll until ready, then call bcdev_profile_finish again."];
      }
      return result["kind"] === "instrumentation"
        ? [AL_PERF_HINT, "Instrumentation self-time is deterministic call-time, not statistical."]
        : [AL_PERF_HINT];
    default:
      return [];
  }
}

export function withAgentResponses(tool: ToolDefinition): ToolDefinition {
  if (!(tool.outputSchema instanceof z.ZodObject)) {
    throw new Error(`Tool ${tool.name} output schema must be an object to add agent response fields`);
  }
  const outputSchema = tool.outputSchema.extend({
    nextSteps: z.array(z.string()).describe("Contextual follow-up actions; empty when no useful next action exists"),
  });
  const handler = tool.handler;
  return {
    ...tool,
    outputSchema,
    handler: async (params) => {
      const value = await handler(params);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Tool ${tool.name} returned a non-object success result`);
      }
      const result = value as Record<string, unknown>;
      return { ...result, nextSteps: generatedNextSteps(tool.name, result, params) };
    },
  };
}
