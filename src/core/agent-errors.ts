import { z } from "zod";

export const AGENT_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "CONFIGURATION_ERROR",
  "AUTHENTICATION_FAILED",
  "ENDPOINT_UNREACHABLE",
  "UNSUPPORTED_SERVER",
  "NOT_FOUND",
  "NO_DEBUG_SESSION",
  "DEBUG_SESSION_NOT_PAUSED",
  "DEBUG_SESSION_IDENTITY_UNAVAILABLE",
  "DEBUG_SESSION_ACTIVE",
  "RECORD_WRITE_TRIAGE_ACTIVE",
  "RECORD_WRITE_TRIAGE_NOT_ACTIVE",
  "TEST_RUN_ACTIVE",
  "PROFILE_NOT_ACTIVE",
  "PROFILE_ACTIVE",
  "SQL_INSIGHT_NOT_ENABLED",
  "TOOL_DISABLED",
  "GIT_ERROR",
  "TIMEOUT",
  "SERVER_REJECTED",
  "PROTOCOL_ERROR",
  "INTERNAL_ERROR",
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export const AGENT_ERROR_CATEGORIES = ["validation", "configuration", "auth", "network", "state", "server", "protocol", "internal"] as const;

export type AgentErrorCategory = (typeof AGENT_ERROR_CATEGORIES)[number];

/** The JSON text body of every isError tool result. */
export const AgentErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(AGENT_ERROR_CODES),
    category: z.enum(AGENT_ERROR_CATEGORIES),
    message: z.string(),
    retryable: z.boolean(),
    tool: z.string(),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  }),
  nextSteps: z.array(z.string().min(1)).min(1),
});

export type AgentErrorBody = z.infer<typeof AgentErrorBodySchema>;

/** JSON Schema (draft 2020-12) of AgentErrorBody, for consumers outside TypeScript. */
export function agentErrorBodyJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgentErrorBodySchema) as Record<string, unknown>;
}

export class BcDevError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
    public readonly category: AgentErrorCategory,
    public readonly retryable = false,
    public readonly details: Record<string, string | number | boolean | null> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BcDevError";
  }
}
