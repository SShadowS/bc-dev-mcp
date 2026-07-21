import { z } from "zod";
import type { ToolDefinition } from "./shared";

function generatedNextSteps(name: string, result: Record<string, unknown>): string[] {
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
      if (summary?.["outcome"] === "failed") return ["Call bcdev_debug_attach, then bcdev_debug_run_tests for the failed methods."];
      if (summary?.["outcome"] === "aborted") return ["Call bcdev_status, correct the abort cause, and retry bcdev_test_run."];
      return [];
    }
    case "bcdev_debug_attach":
    case "bcdev_debug_run_tests":
    case "bcdev_debug_continue":
      return ["Call bcdev_debug_wait for the next debugger lifecycle event."];
    case "bcdev_debug_wait":
      if (result["timedOut"] === true) return ["Call bcdev_debug_wait again to keep waiting."];
      if (result["kind"] === "break") return ["Inspect with bcdev_debug_variables or bcdev_debug_eval, then call bcdev_debug_continue."];
      if (result["kind"] === "sessionBound") return ["Trigger the target workload, then call bcdev_debug_wait for a break or completion event."];
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
    case "bcdev_profile_status":
      return ["Call bcdev_profile_start to arm a supported profile capture."];
    case "bcdev_profile_start":
      return ["Trigger the target workload, then call bcdev_profile_poll until it reports ready."];
    case "bcdev_profile_poll":
      return result["ready"] === true
        ? ["Call bcdev_profile_finish to save and summarize the capture."]
        : ["Trigger or continue the target workload, then call bcdev_profile_poll again."];
    case "bcdev_profile_finish":
      return [];
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
      const existing = Array.isArray(result["nextSteps"]) && result["nextSteps"].every((step) => typeof step === "string")
        ? result["nextSteps"] as string[]
        : null;
      return { ...result, nextSteps: existing ?? generatedNextSteps(tool.name, result) };
    },
  };
}
