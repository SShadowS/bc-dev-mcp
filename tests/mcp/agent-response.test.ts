import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { withAgentResponses } from "../../src/mcp/tools/agent-response";
import type { ToolDefinition } from "../../src/mcp/tools/shared";

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "bcdev_source",
    title: "test",
    description: "test",
    annotations: { readOnlyHint: true },
    schema: {},
    outputSchema: z.looseObject({ value: z.string().optional() }),
    handler: async () => ({ value: "ok" }),
    ...overrides,
  };
}

describe("withAgentResponses", () => {
  test("rejects a non-object output schema", () => {
    expect(() => withAgentResponses(tool({ outputSchema: z.union([z.string(), z.number()]) }))).toThrow(
      /output schema must be an object/,
    );
  });

  test("does not trust a handler payload's nextSteps as agent guidance", async () => {
    const wrapped = withAgentResponses(tool({ handler: async () => ({ value: "ok", nextSteps: ["untrusted wire guidance"] }) }));
    expect(await wrapped.handler({})).toEqual({ value: "ok", nextSteps: [] });
  });

  test("generates profile-finish guidance in the response layer", async () => {
    const wrapped = withAgentResponses(tool({
      name: "bcdev_profile_finish",
      handler: async () => ({ captured: true, kind: "instrumentation" }),
    }));
    const result = await wrapped.handler({}) as { nextSteps: string[] };
    expect(result.nextSteps[0]).toContain("al-perf");
    expect(result.nextSteps[1]).toContain("deterministic call-time");
  });

  test("record-write guidance follows arming, collection, truncation, and incomplete states", async () => {
    const status = withAgentResponses(tool({
      name: "bcdev_record_writes_status",
      handler: async () => ({ phase: "arming" }),
    }));
    expect((await status.handler({}) as { nextSteps: string[] }).nextSteps.join(" ")).toContain("Trigger");

    const collecting = withAgentResponses(tool({
      name: "bcdev_record_writes_status",
      handler: async () => ({ phase: "collecting" }),
    }));
    expect((await collecting.handler({}) as { nextSteps: string[] }).nextSteps.join(" ")).toContain("finish");

    const truncated = withAgentResponses(tool({
      name: "bcdev_record_writes_finish",
      handler: async () => ({ truncated: true, complete: false, summary: {} }),
    }));
    expect((await truncated.handler({}) as { nextSteps: string[] }).nextSteps.join(" ")).toContain("maxObservedWrites");

    const incomplete = withAgentResponses(tool({
      name: "bcdev_record_writes_finish",
      handler: async () => ({ truncated: false, complete: false, summary: {} }),
    }));
    expect((await incomplete.handler({}) as { nextSteps: string[] }).nextSteps.join(" ")).toContain("unresolved");
  });
});
