import { describe, expect, test } from "bun:test";
import { agentErrorBody, BcDevError, normalizeAgentError } from "../../src/core/agent-errors";
import { DevEndpointError } from "../../src/core/server-info";

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

  test("redacts authenticated URLs and sensitive keys in details", () => {
    const body = agentErrorBody(
      "bcdev_status",
      new BcDevError("CONFIGURATION_ERROR", "bad configuration", "configuration", false, {
        url: "https://bc.example/dev?tenant=default&Authentication=Bearer%20detail-token",
        authorization: "Bearer detail-token",
        accessToken: "detail-token",
        password: "password-value",
        attempt: 2,
      }),
    );
    expect(body.error.details).toEqual({
      url: "https://bc.example/dev?tenant=default&Authentication=[REDACTED]",
      authorization: "[REDACTED]",
      accessToken: "[REDACTED]",
      password: "[REDACTED]",
      attempt: 2,
    });
    expect(JSON.stringify(body)).not.toContain("detail-token");
    expect(JSON.stringify(body)).not.toContain("password-value");
  });
});
