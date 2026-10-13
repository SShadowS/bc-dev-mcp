import {
  ERROR_CATEGORIES,
  TOOLBOX_CORE_ERROR_CODES,
  ToolboxError,
  errorBodySchema,
  type ErrorCategory,
  type ErrorDetails,
  type ToolboxCoreErrorCode,
} from "@sshadows/bc-toolbox-envelope";
import { z } from "zod";

/*
 * Error codes come in two disjoint sets:
 *
 * - TOOLBOX_CORE_ERROR_CODES: the shared toolbox vocabulary (epic c04), owned by
 *   @sshadows/bc-toolbox-envelope. Any toolbox MCP server or CLI may emit these, so an
 *   agent can branch on them without knowing which tool failed.
 * - BC_DEV_MCP_ERROR_CODES: extensions for state only this server has
 *   (debug sessions, test runs, profiles, record-write triage, git changes).
 *
 * Extension rule: a new code goes into the core set (in the shared package) only if it
 * means the same thing for any tool; otherwise it goes into the extension set. An
 * extension code never reuses a core name, codes are never renamed, and a consumer that
 * does not know an extension code falls back to error.category and error.retryable.
 */
export { TOOLBOX_CORE_ERROR_CODES, type ToolboxCoreErrorCode };

export const BC_DEV_MCP_ERROR_CODES = [
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
  "GIT_ERROR",
] as const;

export const AGENT_ERROR_CODES = [...TOOLBOX_CORE_ERROR_CODES, ...BC_DEV_MCP_ERROR_CODES] as const;

export type BcDevMcpErrorCode = (typeof BC_DEV_MCP_ERROR_CODES)[number];
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export const AGENT_ERROR_CATEGORIES = ERROR_CATEGORIES;
export type AgentErrorCategory = ErrorCategory;

/** The JSON text body of every isError tool result: the shared body, codes limited to core + ours. */
export const AgentErrorBodySchema = errorBodySchema(BC_DEV_MCP_ERROR_CODES);

export type AgentErrorBody = Omit<z.infer<typeof AgentErrorBodySchema>, "error"> & {
  error: Omit<z.infer<typeof AgentErrorBodySchema>["error"], "code"> & { code: AgentErrorCode };
};

/** JSON Schema (draft 2020-12) of AgentErrorBody, for consumers outside TypeScript. */
export function agentErrorBodyJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgentErrorBodySchema) as Record<string, unknown>;
}

export class BcDevError extends ToolboxError<AgentErrorCode> {
  constructor(
    code: AgentErrorCode,
    message: string,
    category: AgentErrorCategory,
    retryable = false,
    details: ErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(code, message, category, retryable, details, options);
    this.name = "BcDevError";
  }
}
