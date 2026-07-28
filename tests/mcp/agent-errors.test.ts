import { describe, expect, test } from "bun:test";
import { BcDevError } from "../../src/core/agent-errors";
import { DevEndpointError } from "../../src/core/server-info";
import { agentErrorBody, normalizeAgentError } from "../../src/mcp/agent-errors";

describe("agent errors", () => {
  test("maps known state and endpoint failures to stable codes", () => {
    expect(normalizeAgentError(new Error("No debug session — call bcdev_debug_attach first")).code).toBe("NO_DEBUG_SESSION");
    expect(normalizeAgentError(new DevEndpointError("denied", "auth"))).toMatchObject({
      code: "AUTHENTICATION_FAILED",
      retryable: false,
    });
    expect(normalizeAgentError(new DevEndpointError("offline", "unreachable"))).toMatchObject({
      code: "ENDPOINT_UNREACHABLE",
      retryable: true,
    });
    expect(normalizeAgentError(new Error("Unable to attach. launch.json user was rejected by Business Central")).code).toBe("SERVER_REJECTED");
    expect(normalizeAgentError(new Error("Server returned breakpoint metadata for another AL object")).code).toBe("PROTOCOL_ERROR");
  });

  test("native debugger state relies on typed errors rather than loose message matching", () => {
    expect(normalizeAgentError(new Error("debug session identity cache failed")).code).toBe("INTERNAL_ERROR");
    expect(normalizeAgentError(new BcDevError(
      "DEBUG_SESSION_IDENTITY_UNAVAILABLE",
      "identity unavailable",
      "state",
    )).code).toBe("DEBUG_SESSION_IDENTITY_UNAVAILABLE");
  });

  test("specific timeout and not-found fallbacks win over broad validation words", () => {
    expect(normalizeAgentError(new Error("invalid transport timed out"))).toMatchObject({
      code: "TIMEOUT",
      category: "network",
      retryable: true,
    });
    expect(normalizeAgentError(new Error("invalid package was not found"))).toMatchObject({
      code: "NOT_FOUND",
      category: "server",
    });
  });

  test("classifies the SDK disabled-tool message as an expected state error", () => {
    const error = normalizeAgentError(new Error("Tool bcdev_status disabled"));
    expect(error).toMatchObject({ code: "TOOL_DISABLED", category: "state", retryable: false });
    expect(agentErrorBody("bcdev_status", error).nextSteps.join(" ")).toContain("enabled tool");
  });

  test("serializes a redacted machine-readable error with recovery steps", () => {
    const body = agentErrorBody(
      "bcdev_debug_wait",
      new BcDevError("NO_DEBUG_SESSION", "failed?Authentication=Bearer%20secret-token&tenant=default", "state"),
    );
    expect(body.error).toMatchObject({ code: "NO_DEBUG_SESSION", category: "state", tool: "bcdev_debug_wait", retryable: false });
    expect(body.error.message).toContain("[REDACTED]");
    expect(body.error.message).not.toContain("secret-token");
    expect(body.nextSteps.join(" ")).toContain("bcdev_debug_attach");
  });

  test("redacts authenticated URLs, URL userinfo, and sensitive keys in details", () => {
    const jwt = [
      "eyJ" + "0eXAiOiJKV1QifQ",
      "eyJ" + "zdWIiOiJzZWNyZXQifQ",
      "signature_part",
    ].join(".");
    const body = agentErrorBody(
      "bcdev_status",
      new BcDevError("CONFIGURATION_ERROR", "bad endpoint https://user:password@bc.example/dev", "configuration", false, {
        url: "https://user:password@bc.example/dev?tenant=default&Authentication=Bearer%20detail-token",
        diagnostic: `gateway echoed Bearer ${jwt}`,
        authorization: "Bearer detail-token",
        accessToken: "detail-token",
        password: "password-value",
        attempt: 2,
      }),
    );
    expect(body.error.details).toEqual({
      url: "https://[REDACTED]@bc.example/dev?tenant=default&Authentication=[REDACTED]",
      diagnostic: "gateway echoed Bearer [REDACTED_JWT]",
      authorization: "[REDACTED]",
      accessToken: "[REDACTED]",
      password: "[REDACTED]",
      attempt: 2,
    });
    expect(JSON.stringify(body)).not.toContain("detail-token");
    expect(JSON.stringify(body)).not.toContain("password-value");
    expect(JSON.stringify(body)).not.toContain(jwt);
    expect(JSON.stringify(body)).not.toContain("user:");
    expect(body.error.message).toBe("bad endpoint https://[REDACTED]@bc.example/dev");
  });
});
