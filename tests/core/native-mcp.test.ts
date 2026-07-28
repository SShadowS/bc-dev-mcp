import { describe, expect, test } from "bun:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type Implementation } from "@modelcontextprotocol/sdk/types.js";
import { BcDevError } from "../../src/core/agent-errors";
import {
  DEFAULT_NATIVE_MCP_TIMEOUT_MS,
  NATIVE_MCP_CLOUD_URL,
  SdkNativeMcpGateway,
  type NativeMcpConnection,
  type NativeMcpConnectionFactory,
  type NativeMcpTarget,
} from "../../src/core/native-mcp";

class FakeConnection implements NativeMcpConnection {
  connected = false;
  terminated = false;
  closed = false;
  connectOptions: { timeout: number; maxTotalTimeout: number; signal: AbortSignal } | null = null;
  listCursor: string | undefined;
  called: { name: string; args: Record<string, unknown> } | null = null;
  version: Implementation | undefined = { name: "Business Central", version: "28.0" };
  listResult: Record<string, unknown> = { tools: [{ name: "one", inputSchema: { type: "object" } }] };
  callResult: Record<string, unknown> = { content: [{ type: "text", text: "ok" }] };
  connectError: unknown;
  listError: unknown;
  callError: unknown;

  async connect(options: { timeout: number; maxTotalTimeout: number; signal: AbortSignal }): Promise<void> {
    this.connectOptions = options;
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }

  serverVersion(): Implementation | undefined {
    return this.version;
  }

  async listTools(
    cursor: string | undefined,
    _options: { timeout: number; maxTotalTimeout: number; signal: AbortSignal },
  ): Promise<Record<string, unknown>> {
    this.listCursor = cursor;
    if (this.listError) throw this.listError;
    return this.listResult;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    _options: { timeout: number; maxTotalTimeout: number; signal: AbortSignal },
  ): Promise<Record<string, unknown>> {
    this.called = { name, args };
    if (this.callError) throw this.callError;
    return this.callResult;
  }

  async terminateSession(): Promise<void> {
    this.terminated = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function target(overrides: Partial<NativeMcpTarget> = {}): NativeMcpTarget {
  return {
    config: {
      environmentType: "Sandbox",
      authentication: "EntraId",
      environmentName: "Sandbox",
      tenant: "tenant.example",
    },
    authorization: { getAuthorizationHeader: async () => "Bearer secret-token" },
    company: "CRONUS",
    context: "business",
    ...overrides,
  };
}

function setup(connection = new FakeConnection()) {
  let captured: { url: URL; headers: Headers; fetchFn: typeof fetch } | null = null;
  const factory: NativeMcpConnectionFactory = (url, headers, fetchFn) => {
    captured = { url, headers, fetchFn };
    return connection;
  };
  const fetchFn = (async () => new Response()) as unknown as typeof fetch;
  const gateway = new SdkNativeMcpGateway(fetchFn, factory);
  return {
    connection,
    gateway,
    captured: () => {
      if (!captured) throw new Error("connection factory was not called");
      return captured;
    },
    fetchFn,
  };
}

describe("BC native MCP gateway", () => {
  test("uses the installed Streamable HTTP SDK end to end and terminates its session", async () => {
    const requests: Array<{
      method: string;
      headers: Headers;
      body?: Record<string, unknown>;
    }> = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined;
      requests.push({ method, headers, ...(body === undefined ? {} : { body }) });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "GET") return new Response(null, { status: 405 });
      if (body?.["method"] === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const id = body?.["id"];
      if (body?.["method"] === "initialize") {
        const params = body["params"] as Record<string, unknown>;
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params["protocolVersion"],
            capabilities: { tools: {} },
            serverInfo: { name: "BC native", version: "28.0" },
          },
        }, { headers: { "Mcp-Session-Id": "native-session" } });
      }
      if (body?.["method"] === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [{
              name: "bc_actions_search",
              description: "Search actions",
              inputSchema: { type: "object", properties: {} },
              futureField: { retained: true },
            }],
          },
        });
      }
      if (body?.["method"] === "tools/call") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: "native failure", futureBlockField: 9 }],
            structuredContent: { reason: "rejected" },
            isError: true,
            _meta: { native: 7 },
            futureField: ["kept"],
          },
        });
      }
      throw new Error(`Unexpected native MCP request: ${String(body?.["method"])}`);
    }) as typeof fetch;

    const gateway = new SdkNativeMcpGateway(fetchFn);
    const result = await gateway.listTools(target());
    expect(result).toMatchObject({
      server: { name: "BC native", version: "28.0" },
      catalog: {
        tools: [{
          name: "bc_actions_search",
          futureField: { retained: true },
        }],
      },
    });
    const call = await gateway.callTool(target(), "bc_actions_invoke", {
      request: { id: 7 },
    });
    expect(call).toMatchObject({
      server: { name: "BC native", version: "28.0" },
      result: {
        content: [{
          type: "text",
          text: "native failure",
          futureBlockField: 9,
        }],
        structuredContent: { reason: "rejected" },
        isError: true,
        _meta: { native: 7 },
        futureField: ["kept"],
      },
    });
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "GET",
      "POST",
      "DELETE",
      "POST",
      "POST",
      "GET",
      "POST",
      "DELETE",
    ]);
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer secret-token");
    expect(requests[3]?.headers.get("Mcp-Session-Id")).toBe("native-session");
    expect(requests[4]?.headers.get("Mcp-Session-Id")).toBe("native-session");
    expect(requests[8]?.headers.get("Mcp-Session-Id")).toBe("native-session");
    expect(requests[8]?.body).toMatchObject({
      method: "tools/call",
      params: {
        name: "bc_actions_invoke",
        arguments: { request: { id: 7 } },
      },
    });
    expect(requests[9]?.headers.get("Mcp-Session-Id")).toBe("native-session");
  });

  test("routes the business catalog with trusted headers, pagination, timeout, and cleanup", async () => {
    const { gateway, connection, captured, fetchFn } = setup();
    const result = await gateway.listTools(target({ configurationName: "Read only" }), "next");

    expect(result).toEqual({
      server: { name: "Business Central", version: "28.0" },
      catalog: connection.listResult,
    });
    expect(captured().url.toString()).toBe(`${NATIVE_MCP_CLOUD_URL}/`);
    expect(captured().fetchFn).toBe(fetchFn);
    expect(captured().headers.get("Authorization")).toBe("Bearer secret-token");
    expect(captured().headers.get("TenantId")).toBe("tenant.example");
    expect(captured().headers.get("EnvironmentName")).toBe("Sandbox");
    expect(captured().headers.get("Company")).toBe("CRONUS");
    expect(captured().headers.get("ConfigurationName")).toBe("Read only");
    expect(captured().headers.has("Dev")).toBe(false);
    expect(captured().headers.has("mcp-troubleshooting-options")).toBe(false);
    expect(captured().headers.has("mcp-profiling-options")).toBe(false);
    expect(connection.listCursor).toBe("next");
    expect(connection.connectOptions?.timeout).toBe(DEFAULT_NATIVE_MCP_TIMEOUT_MS);
    expect(connection.connectOptions?.maxTotalTimeout).toBe(DEFAULT_NATIVE_MCP_TIMEOUT_MS);
    expect(connection.terminated).toBe(true);
    expect(connection.closed).toBe(true);
  });

  test("maps runtime and debugging contexts to the BC28 headers without profiling", async () => {
    const runtime = setup();
    await runtime.gateway.listTools(target({ context: "runtime" }));
    expect(runtime.captured().headers.get("Dev")).toBe("ALRuntime");
    expect(runtime.captured().headers.has("mcp-troubleshooting-options")).toBe(false);
    expect(runtime.captured().headers.has("mcp-profiling-options")).toBe(false);

    const debugging = setup();
    await debugging.gateway.listTools(target({
      context: "debugging",
      debugIdentity: { sessionId: 321, hostId: "host-1" },
    }));
    expect(debugging.captured().headers.get("Dev")).toBe("Debugging");
    expect(JSON.parse(debugging.captured().headers.get("mcp-troubleshooting-options")!)).toEqual({
      versionNumber: "1.0",
      sessionId: 321,
      hostId: "host-1",
    });
    expect(debugging.captured().headers.has("mcp-profiling-options")).toBe(false);
  });

  test("preserves the complete upstream tool result including isError and unknown evidence", async () => {
    const connection = new FakeConnection();
    connection.callResult = {
      content: [{ type: "text", text: "native failure" }],
      structuredContent: { reason: "rejected" },
      isError: true,
      _meta: { native: 7 },
      futureField: ["kept"],
    };
    const { gateway } = setup(connection);
    const result = await gateway.callTool(target(), "bc_actions_invoke", {
      request: { id: 7 },
    });

    expect(result.result).toEqual(connection.callResult);
    expect(connection.called).toEqual({
      name: "bc_actions_invoke",
      args: { request: { id: 7 } },
    });
    expect(connection.terminated).toBe(true);
    expect(connection.closed).toBe(true);
  });

  test("rejects invalid context/header combinations before opening a connection", async () => {
    const { gateway, connection } = setup();
    const error = await gateway.listTools(target({
      context: "runtime",
      configurationName: "not valid here",
    })).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "INVALID_ARGUMENT",
      category: "validation",
    });
    expect(connection.connected).toBe(false);
  });

  test("normalizes SDK timeouts and HTTP authentication failures", async () => {
    const timeoutConnection = new FakeConnection();
    timeoutConnection.connectError = new McpError(ErrorCode.RequestTimeout, "Request timed out");
    const timeout = await setup(timeoutConnection).gateway.listTools(target()).catch((caught) => caught);
    expect(timeout).toMatchObject({
      code: "TIMEOUT",
      category: "network",
      retryable: true,
    });
    expect(timeoutConnection.closed).toBe(true);

    const authConnection = new FakeConnection();
    authConnection.connectError = new StreamableHTTPError(401, "Unauthorized");
    const auth = await setup(authConnection).gateway.listTools(target()).catch((caught) => caught);
    expect(auth).toMatchObject({
      code: "AUTHENTICATION_FAILED",
      category: "auth",
      retryable: false,
      details: { status: 401 },
    });
    expect((auth as Error).message).not.toContain("secret-token");
  });

  test("applies the operation deadline while authorization is still pending", async () => {
    let resolveAuthorization!: (value: string) => void;
    const authorization = new Promise<string>((resolve) => {
      resolveAuthorization = resolve;
    });
    const { gateway, connection } = setup();
    const error = await gateway.listTools(target({
      authorization: { getAuthorizationHeader: () => authorization },
      timeoutMs: 1_000,
    })).catch((caught) => caught);

    expect(error).toMatchObject({
      code: "TIMEOUT",
      category: "network",
      retryable: true,
    });
    expect(connection.connected).toBe(false);
    resolveAuthorization("Bearer late-token");
    await Promise.resolve();
  });

  test("times out a hanging request through the installed SDK path", async () => {
    const fetchFn = (async () =>
      await new Promise<Response>(() => {})) as unknown as typeof fetch;
    const gateway = new SdkNativeMcpGateway(fetchFn);
    const error = await gateway.listTools(target({ timeoutMs: 1_000 })).catch((caught) => caught);

    expect(error).toMatchObject({
      code: "TIMEOUT",
      category: "network",
      retryable: true,
    });
  });

  test("retains a bounded redacted upstream explanation for server rejections", async () => {
    const httpConnection = new FakeConnection();
    httpConnection.connectError = new StreamableHTTPError(
      400,
      "Authorization: Bearer secret-token Company does not exist",
    );
    const httpError = await setup(httpConnection).gateway.listTools(target()).catch((caught) => caught);

    expect(httpError).toMatchObject({
      code: "SERVER_REJECTED",
      category: "server",
      details: {
        status: 400,
      },
    });
    expect(httpError.details.upstreamMessage).toContain("Company does not exist");
    expect(httpError.details.upstreamMessage).not.toContain("secret-token");

    const protocolConnection = new FakeConnection();
    protocolConnection.callError = new McpError(
      ErrorCode.InvalidParams,
      "The required codeunitId argument was missing",
    );
    const protocolError = await setup(protocolConnection).gateway.callTool(
      target(),
      "run_tests",
      {},
    ).catch((caught) => caught);
    expect(protocolError).toMatchObject({
      code: "SERVER_REJECTED",
      category: "server",
      details: {
        upstreamMessage: "MCP error -32602: The required codeunitId argument was missing",
      },
    });
  });

  test("normalizes malformed initialization and still closes the upstream session", async () => {
    const connection = new FakeConnection();
    connection.version = undefined;
    const { gateway } = setup(connection);
    const error = await gateway.listTools(target()).catch((caught) => caught);
    expect(error).toBeInstanceOf(BcDevError);
    expect(error).toMatchObject({
      code: "PROTOCOL_ERROR",
      category: "protocol",
    });
    expect(connection.terminated).toBe(true);
    expect(connection.closed).toBe(true);
  });
});
