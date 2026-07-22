import { BcDevError, type AgentErrorCategory, type AgentErrorCode } from "../core/agent-errors";
import { redactAuthorization } from "../core/redaction";
import { DevEndpointError } from "../core/server-info";

export interface AgentErrorBody {
  error: {
    code: AgentErrorCode;
    category: AgentErrorCategory;
    message: string;
    retryable: boolean;
    tool: string;
    details: Record<string, string | number | boolean | null>;
  };
  nextSteps: string[];
}

function fromKnownMessage(message: string): BcDevError {
  const lower = message.toLowerCase();
  if (lower.includes("no debug session")) return new BcDevError("NO_DEBUG_SESSION", message, "state");
  if (lower.includes("debug session already active")) return new BcDevError("DEBUG_SESSION_ACTIVE", message, "state");
  if (lower.includes("test run is already") || lower.includes("test run is in progress")) return new BcDevError("TEST_RUN_ACTIVE", message, "state");
  if (lower.includes("no active profile") || lower.includes("no profile capture")) return new BcDevError("PROFILE_NOT_ACTIVE", message, "state");
  if (lower.includes("profile capture already active")) return new BcDevError("PROFILE_ACTIVE", message, "state");
  if (lower.includes("sql insight is off")) return new BcDevError("SQL_INSIGHT_NOT_ENABLED", message, "state");
  if (/tool\s+\S+\s+disabled/.test(lower)) return new BcDevError("TOOL_DISABLED", message, "state");
  if (lower.includes("unable to attach") || lower.includes("unable to bind") || lower.includes("server rejected")) {
    return new BcDevError("SERVER_REJECTED", message, "server");
  }
  if (
    lower.includes("server did not return") ||
    lower.includes("business central returned an invalid") ||
    lower.includes("server returned breakpoint")
  ) {
    return new BcDevError("PROTOCOL_ERROR", message, "protocol");
  }
  // Specific transient/resource failures must win over broad words such as "invalid".
  if (lower.includes("timed out") || lower.includes("timeout")) return new BcDevError("TIMEOUT", message, "network", true);
  if (lower.includes("not found") || lower.includes("no al object declaration")) return new BcDevError("NOT_FOUND", message, "server");
  if (lower.includes("must be") || lower.includes("mutually exclusive") || lower.includes("invalid") || lower.includes("requires")) {
    return new BcDevError("INVALID_ARGUMENT", message, "validation");
  }
  if (lower.includes("missing required connection fields") || lower.includes("launch.json") || lower.includes("not supported")) {
    return new BcDevError("CONFIGURATION_ERROR", message, "configuration");
  }
  if (lower.includes("rejected")) return new BcDevError("SERVER_REJECTED", message, "server");
  return new BcDevError("INTERNAL_ERROR", message, "internal");
}

export function normalizeAgentError(error: unknown): BcDevError {
  if (error instanceof BcDevError) return error;
  if (error instanceof DevEndpointError) {
    if (error.kind === "auth") return new BcDevError("AUTHENTICATION_FAILED", error.message, "auth", false, {}, { cause: error });
    if (error.kind === "unreachable") return new BcDevError("ENDPOINT_UNREACHABLE", error.message, "network", true, {}, { cause: error });
    return new BcDevError("SERVER_REJECTED", error.message, "server", false, {}, { cause: error });
  }
  return fromKnownMessage(error instanceof Error ? error.message : String(error));
}

function recoverySteps(code: AgentErrorCode): string[] {
  switch (code) {
    case "NO_DEBUG_SESSION": return ["Call bcdev_debug_attach before using debugger session tools."];
    case "DEBUG_SESSION_ACTIVE": return ["Call bcdev_debug_detach before starting another debugger session."];
    case "TEST_RUN_ACTIVE": return ["Wait for the active test run to finish, then retry."];
    case "PROFILE_NOT_ACTIVE": return ["Call bcdev_profile_start before polling or finishing a profile."];
    case "PROFILE_ACTIVE": return ["Call bcdev_profile_finish before starting another profile capture."];
    case "SQL_INSIGHT_NOT_ENABLED": return ["Detach, then call bcdev_debug_attach with sqlInsight: true before retrying SQL inspection."];
    case "TOOL_DISABLED": return ["Use an enabled tool, or enable the requested tool before retrying."];
    case "GIT_ERROR": return ["Verify the AL project Git repository and coverageAgainst ref, then retry bcdev_test_run."];
    case "AUTHENTICATION_FAILED": return ["Call bcdev_status after correcting the configured Business Central credentials or Azure CLI login."];
    case "ENDPOINT_UNREACHABLE": return ["Call bcdev_status after confirming the Business Central endpoint is reachable."];
    case "UNSUPPORTED_SERVER": return ["Call bcdev_status and use a Business Central server that supports the required developer API feature."];
    case "NOT_FOUND": return ["Verify the requested object, source file, session, or package identifier and retry."];
    case "TIMEOUT": return ["Retry the operation; if it repeats, call bcdev_status to verify connectivity."];
    case "INVALID_ARGUMENT": return ["Correct the tool arguments using the published input schema, then retry."];
    case "CONFIGURATION_ERROR": return ["Correct the AL project launch configuration or explicit connection parameters, then call bcdev_status."];
    case "SERVER_REJECTED": return ["Review the Business Central rejection, correct the target or server state, and retry."];
    case "PROTOCOL_ERROR": return ["Call bcdev_status and verify the Business Central version matches the supported developer API contract."];
    case "INTERNAL_ERROR": return ["Retry once; if the failure repeats, capture the redacted message and report it as a bc-dev-mcp issue."];
  }
}

const SENSITIVE_DETAIL_KEY = /authorization|authentication|token|password|secret|credential/i;

function redactDetails(details: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => {
    if (SENSITIVE_DETAIL_KEY.test(key)) return [key, "[REDACTED]"];
    return [key, typeof value === "string" ? redactAuthorization(value) : value];
  }));
}

export function agentErrorBody(tool: string, error: unknown): AgentErrorBody {
  const normalized = normalizeAgentError(error);
  return {
    error: {
      code: normalized.code,
      category: normalized.category,
      message: redactAuthorization(normalized.message),
      retryable: normalized.retryable,
      tool,
      details: redactDetails(normalized.details),
    },
    nextSteps: recoverySteps(normalized.code),
  };
}
