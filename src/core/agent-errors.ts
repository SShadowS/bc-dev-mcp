export type AgentErrorCode =
  | "INVALID_ARGUMENT"
  | "CONFIGURATION_ERROR"
  | "AUTHENTICATION_FAILED"
  | "ENDPOINT_UNREACHABLE"
  | "UNSUPPORTED_SERVER"
  | "NOT_FOUND"
  | "NO_DEBUG_SESSION"
  | "DEBUG_SESSION_ACTIVE"
  | "TEST_RUN_ACTIVE"
  | "PROFILE_NOT_ACTIVE"
  | "PROFILE_ACTIVE"
  | "SQL_INSIGHT_NOT_ENABLED"
  | "TOOL_DISABLED"
  | "TIMEOUT"
  | "SERVER_REJECTED"
  | "PROTOCOL_ERROR"
  | "INTERNAL_ERROR";

export type AgentErrorCategory = "validation" | "configuration" | "auth" | "network" | "state" | "server" | "protocol" | "internal";

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
