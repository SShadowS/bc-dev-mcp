import { describe, expect, test } from "bun:test";
import { AGENT_ERROR_CODES, AgentErrorBodySchema, BC_DEV_MCP_ERROR_CODES, TOOLBOX_CORE_ERROR_CODES, BcDevError, agentErrorBodyJsonSchema } from "../../src/core/agent-errors";
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

  test("a hub Attach failure right after a detach is a retryable SERVER_REJECTED, not an internal bug", () => {
    // Live Cronus28 2026-10-13: an immediate re-attach fails after ~10 s with this exact SignalR text; 12 s later it works.
    expect(normalizeAgentError(new Error("An unexpected error occurred invoking 'Attach' on the server."))).toMatchObject({
      code: "SERVER_REJECTED",
      category: "server",
      retryable: true,
      message: expect.stringContaining("wait about 10 seconds"),
    });
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

  test("raw transport failures are retryable ENDPOINT_UNREACHABLE, not INTERNAL_ERROR", () => {
    for (const raw of [
      new TypeError("fetch failed"),
      new Error("WebSocket closed with status code: 1006 (no reason given)."),
      new Error("Failed to complete negotiation with the server: TypeError: fetch failed"),
      new Error("connect ECONNREFUSED 127.0.0.1:7049"),
      new Error("read ECONNRESET"),
    ]) {
      expect(normalizeAgentError(raw), raw.message).toMatchObject({ code: "ENDPOINT_UNREACHABLE", category: "network", retryable: true });
    }
  });

  test("a missing local path (ENOENT) is NOT_FOUND", () => {
    expect(normalizeAgentError(new Error("ENOENT: no such file or directory, scandir 'C:\\x'")).code).toBe("NOT_FOUND");
  });

  test("classifies the SDK disabled-tool message as an expected state error", () => {
    const error = normalizeAgentError(new Error("Tool bcdev_status disabled"));
    expect(error).toMatchObject({ code: "TOOL_DISABLED", category: "state", retryable: false });
    expect(agentErrorBody("bcdev_status", error).nextSteps.join(" ")).toContain("enabled tool");
  });

  test("PROFILE_ACTIVE held by another client points at releasing it by debuggingContext", () => {
    const elsewhere = new BcDevError("PROFILE_ACTIVE", "held", "state", false, { heldElsewhere: true });
    expect(agentErrorBody("bcdev_profile_start", elsewhere).nextSteps.join(" ")).toContain("debuggingContext");
    const local = new BcDevError("PROFILE_ACTIVE", "local", "state");
    expect(agentErrorBody("bcdev_profile_start", local).nextSteps.join(" ")).not.toContain("debuggingContext");
  });

  test("PROFILE_ACTIVE names the owning finish tool; SNAPSHOT_NOT_ACTIVE points at start", () => {
    const snap = new BcDevError("PROFILE_ACTIVE", "x", "state", false, { capture: "snapshot", ownerFinishTool: "bcdev_snapshot_finish", phase: "armed" });
    expect(agentErrorBody("bcdev_profile_start", snap).nextSteps.join(" ")).toContain("bcdev_snapshot_finish");
    const busy = new BcDevError("PROFILE_ACTIVE", "x", "state", false, { capture: "snapshot", ownerFinishTool: "bcdev_snapshot_finish", phase: "attaching" });
    expect(agentErrorBody("bcdev_profile_start", busy).nextSteps.join(" ")).toContain("Wait");
    const none = new BcDevError("SNAPSHOT_NOT_ACTIVE", "x", "state");
    expect(agentErrorBody("bcdev_snapshot_finish", none).nextSteps.join(" ")).toContain("bcdev_snapshot_start");
  });

  test("snapshot error states get specific recovery steps", () => {
    const attach = new BcDevError("TIMEOUT", "x", "network", false, { debuggingContext: "ctx-1", attachUncertain: true });
    expect(agentErrorBody("bcdev_snapshot_start", attach).nextSteps[0]).toBe("Call bcdev_snapshot_finish { debuggingContext: 'ctx-1' } to recover or release the capture.");
    const fin = new BcDevError("TIMEOUT", "x", "network", true, { snapshotId: "s", phase: "uncertain" });
    expect(agentErrorBody("bcdev_snapshot_finish", fin).nextSteps[0]).toBe("Call bcdev_snapshot_finish again (same snapshotId).");
    const lost = new BcDevError("SERVER_REJECTED", "x", "server", false, { lostContext: true });
    expect(agentErrorBody("bcdev_snapshot_status", lost).nextSteps[0]).toBe("The capture ended on the server; call bcdev_snapshot_start to arm a new one.");
  });

  test("tool-specific TIMEOUT / UNSUPPORTED_SERVER steps replace the generic step; other codes still concatenate", () => {
    const run = new BcDevError("TIMEOUT", "x", "network", false, { upstreamRunCancelled: false });
    const runSteps = agentErrorBody("bcdev_snapshot_run_tests", run).nextSteps;
    expect(runSteps).toHaveLength(1);
    expect(runSteps[0]).toStartWith("BC may still be running these tests");
    expect(agentErrorBody("bcdev_snapshot_finish", new BcDevError("TIMEOUT", "x", "network", true, { phase: "uncertain" })).nextSteps).toHaveLength(1);
    expect(agentErrorBody("bcdev_test_run", run).nextSteps).toEqual([
      "Do not start another test run yet. Confirm the native server-side run has finished, then retry or start a new run.",
    ]);
    const wrongPort = new BcDevError("UNSUPPORTED_SERVER", "x", "server", false, { status: 404, url: "http://h:7049/BC/mcp" });
    expect(agentErrorBody("bcdev_native_call", wrongPort).nextSteps).toEqual([
      "Pass apiPort with the server's OData/API port (default 7048, BC_DEV_API_PORT; not the dev port 7049) and confirm McpServicesEnabled is on for the server instance, then retry.",
    ]);
    const cloud404 = new BcDevError("UNSUPPORTED_SERVER", "x", "server", false, { status: 404 });
    expect(agentErrorBody("bcdev_native_call", cloud404).nextSteps).toEqual([
      "Call bcdev_status and use a Business Central server that supports the required developer API feature.",
    ]);
    expect(agentErrorBody("bcdev_app_publish", new BcDevError("SERVER_REJECTED", "x", "server")).nextSteps).toHaveLength(2);
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

  test("app tools add lifecycle-specific recovery steps", () => {
    const rejected = agentErrorBody("bcdev_app_publish", new BcDevError("SERVER_REJECTED", "Publish probe.app was rejected", "server", false, { httpStatus: 422 }));
    expect(rejected.nextSteps[0]).toContain("Global scope");
    expect(rejected.nextSteps[0]).toContain("bcdev_app_unpublish");
    const missing = agentErrorBody("bcdev_app_unpublish", new BcDevError("NOT_FOUND", "No published app", "server"));
    expect(missing.nextSteps[0]).toContain("bcdev_app_list");
    const listMissing = agentErrorBody("bcdev_app_list", new BcDevError("NOT_FOUND", "x", "server"));
    expect(listMissing.nextSteps[0]).toContain("bcdev_status");
    expect(listMissing.nextSteps.join(" ")).not.toContain("Call bcdev_app_list");
    const unrelated = agentErrorBody("bcdev_source", new BcDevError("SERVER_REJECTED", "x", "server"));
    expect(unrelated.nextSteps.join(" ")).not.toContain("Global scope");
  });

  test("every code yields a body that validates against AgentErrorBodySchema with nextSteps", () => {
    const tools = ["bcdev_status", "bcdev_app_publish", "bcdev_app_unpublish", "bcdev_app_list"];
    const detailVariants: Record<string, string | number | boolean | null>[] = [{},{ upstreamRunCancelled: false }, { password: "secret", note: null }];
    for (const code of AGENT_ERROR_CODES) {
      for (const tool of tools) {
        for (const details of detailVariants) {
          const body = agentErrorBody(tool, new BcDevError(code, `${code} probe`, "internal", false, details));
          const parsed = AgentErrorBodySchema.safeParse(JSON.parse(JSON.stringify(body)));
          expect(parsed.success, `${tool}/${code}: ${parsed.error?.message}`).toBe(true);
          expect(body.nextSteps.length).toBeGreaterThan(0);
        }
      }
    }
    // Plain errors go through message normalization; those bodies must validate too.
    for (const raw of [new Error("boom"), "string failure", new DevEndpointError("denied", "auth"), new DevEndpointError("x", "unreachable")]) {
      expect(AgentErrorBodySchema.safeParse(agentErrorBody("bcdev_status", raw)).success).toBe(true);
    }
  });

  test("schema rejects bodies without nextSteps or with unknown codes", () => {
    const body = agentErrorBody("bcdev_status", new Error("boom"));
    expect(AgentErrorBodySchema.safeParse({ ...body, nextSteps: [] }).success).toBe(false);
    expect(AgentErrorBodySchema.safeParse({ ...body, error: { ...body.error, code: "NOPE" } }).success).toBe(false);
  });

  test("exports the error body as JSON Schema", () => {
    const schema = agentErrorBodyJsonSchema() as {
      $schema: string;
      required: string[];
      properties: { error: { properties: { code: { enum: string[] } } }; nextSteps: { minItems: number } };
    };
    expect(schema.$schema).toContain("json-schema.org");
    expect(schema.required).toEqual(["error", "nextSteps"]);
    expect(schema.properties.error.properties.code.enum).toEqual([...AGENT_ERROR_CODES]);
    expect(schema.properties.nextSteps.minItems).toBe(1);
  });

  test("codes split into a disjoint toolbox core set and a bc-dev-mcp extension set", () => {
    const core = new Set<string>(TOOLBOX_CORE_ERROR_CODES);
    expect(BC_DEV_MCP_ERROR_CODES.filter((code) => core.has(code))).toEqual([]);
    expect([...AGENT_ERROR_CODES].sort()).toEqual([...TOOLBOX_CORE_ERROR_CODES, ...BC_DEV_MCP_ERROR_CODES].sort());
    expect(new Set(AGENT_ERROR_CODES).size).toBe(AGENT_ERROR_CODES.length);
    expect(core.has("INTERNAL_ERROR")).toBe(true);
    expect(core.has("NO_DEBUG_SESSION")).toBe(false);
  });
});
