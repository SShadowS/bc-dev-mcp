import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ErrorCode,
  McpError,
  type Implementation,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BcDevError } from "./agent-errors";
import type { AuthorizationProvider } from "./authorization";
import { redactAuthorization } from "./redaction";
import type { CloudConnectionConfig } from "./types";

// WIRE: Business Central cloud exposes its Streamable HTTP MCP endpoint at this fixed URL
// (Microsoft configure-mcp-server docs; live SaaS BC28 probe 2026-07-27).
export const NATIVE_MCP_CLOUD_URL = "https://mcp.businesscentral.dynamics.com";
export const DEFAULT_NATIVE_MCP_TIMEOUT_MS = 180_000;
const NATIVE_MCP_CLEANUP_TIMEOUT_MS = 2_000;
const NATIVE_MCP_ERROR_DETAIL_LIMIT = 1_000;

export type NativeMcpContext = "business" | "runtime" | "debugging";

export interface NativeDebugIdentity {
  sessionId: number;
  hostId: string;
}

export interface NativeMcpTarget {
  config: CloudConnectionConfig;
  authorization: AuthorizationProvider;
  company: string;
  context: NativeMcpContext;
  configurationName?: string;
  debugIdentity?: NativeDebugIdentity;
  timeoutMs?: number;
}

export interface NativeMcpServerIdentity {
  name: string;
  version: string;
}

export interface NativeMcpListResponse {
  server: NativeMcpServerIdentity | null;
  catalog: Record<string, unknown>;
}

export interface NativeMcpCallResponse {
  server: NativeMcpServerIdentity | null;
  result: Record<string, unknown>;
}

interface NativeRequestOptions {
  signal: AbortSignal;
  timeout: number;
  maxTotalTimeout: number;
}

type NativeMcpPhase = "authorization" | "connect" | "operation";

export interface NativeMcpConnection {
  connect(options: NativeRequestOptions): Promise<void>;
  serverVersion(): Implementation | undefined;
  listTools(cursor: string | undefined, options: NativeRequestOptions): Promise<Record<string, unknown>>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: NativeRequestOptions,
  ): Promise<Record<string, unknown>>;
  terminateSession(): Promise<void>;
  close(): Promise<void>;
}

export type NativeMcpConnectionFactory = (
  url: URL,
  headers: Headers,
  fetchFn: typeof fetch,
) => NativeMcpConnection;

export interface NativeMcpGateway {
  listTools(target: NativeMcpTarget, cursor?: string): Promise<NativeMcpListResponse>;
  callTool(
    target: NativeMcpTarget,
    name: string,
    args: Record<string, unknown>,
  ): Promise<NativeMcpCallResponse>;
}

// The SDK's convenience list/call methods normalize nested protocol objects. A passthrough must
// retain fields introduced by a newer BC build, so request with deliberately loose result schemas
// while still requiring the BC28 load-bearing fields.
const nativeListResultSchema = z.looseObject({
  tools: z.array(z.looseObject({
    name: z.string(),
    inputSchema: z.looseObject({ type: z.literal("object") }),
  })),
  nextCursor: z.string().optional(),
});

const nativeCallResultSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string() })).default([]),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

function sdkConnectionFactory(
  url: URL,
  headers: Headers,
  fetchFn: typeof fetch,
): NativeMcpConnection {
  const client = new Client({ name: "bc-dev-mcp", version: "0.3.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    fetch: fetchFn,
  });
  return {
    connect: async (options) => {
      await client.connect(transport, options);
    },
    serverVersion: () => client.getServerVersion(),
    listTools: async (cursor, options) =>
      await client.request(
        {
          method: "tools/list",
          params: cursor === undefined ? {} : { cursor },
        },
        nativeListResultSchema,
        options,
      ) as Record<string, unknown>,
    callTool: async (name, args, options) =>
      await client.request(
        {
          method: "tools/call",
          params: { name, arguments: args },
        },
        nativeCallResultSchema,
        options,
      ) as Record<string, unknown>,
    terminateSession: async () => {
      await transport.terminateSession();
    },
    close: async () => {
      await client.close();
    },
  };
}

function nonblankHeader(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new BcDevError("INVALID_ARGUMENT", `${field} must be a nonblank string`, "validation");
  }
  if (/[\r\n]/.test(normalized)) {
    throw new BcDevError("INVALID_ARGUMENT", `${field} must not contain newline characters`, "validation");
  }
  return normalized;
}

function nativeErrorDetail(error: unknown): string {
  const message = redactAuthorization(error instanceof Error ? error.message : String(error));
  return message.length <= NATIVE_MCP_ERROR_DETAIL_LIMIT
    ? message
    : `${message.slice(0, NATIVE_MCP_ERROR_DETAIL_LIMIT - 1)}…`;
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new McpError(ErrorCode.RequestTimeout, "Native MCP operation timed out"),
    ));
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

function requestHeaders(
  target: NativeMcpTarget,
  authorization: string,
): Headers {
  const company = nonblankHeader(target.company, "company");
  const headers = new Headers({
    Authorization: authorization,
    // WIRE: The BC cloud MCP gateway routes an MCP session through TenantId,
    // EnvironmentName, and Company headers (Microsoft configure-mcp-server docs;
    // live SaaS BC28 probe 2026-07-27).
    TenantId: nonblankHeader(target.config.tenant, "tenant"),
    EnvironmentName: nonblankHeader(target.config.environmentName, "environmentName"),
    Company: company,
  });

  if (target.configurationName !== undefined) {
    if (target.context !== "business") {
      throw new BcDevError(
        "INVALID_ARGUMENT",
        "configurationName is only valid for the business native MCP context",
        "validation",
      );
    }
    // WIRE: ConfigurationName selects a named Business Central MCP configuration;
    // omitting it uses the environment's default dynamic configuration
    // (Microsoft configure-mcp-server docs; live SaaS BC28 probe 2026-07-27).
    headers.set("ConfigurationName", nonblankHeader(target.configurationName, "configurationName"));
  }

  // WIRE: Omitting `Dev` selects the native business-action catalog; development catalogs
  // require their enum-name value instead (Microsoft configure-mcp-server docs; live SaaS
  // BC28 business/runtime/debugging matrix 2026-07-27).
  if (target.context === "runtime") {
    // WIRE: The native AL runtime catalog is selected by the enum-name header
    // `Dev: ALRuntime` (decompiled BC28 McpDevTools enum; live SaaS 2026-07-27).
    headers.set("Dev", "ALRuntime");
  } else if (target.context === "debugging") {
    if (!target.debugIdentity) {
      throw new BcDevError(
        "DEBUG_SESSION_IDENTITY_UNAVAILABLE",
        "The paused debug session has no confirmed NST session and host identity",
        "state",
      );
    }
    // WIRE: Troubleshooting uses `Dev: Debugging` plus JSON header versionNumber,
    // sessionId, and hostId (decompiled BC28 MCP troubleshooting options; live
    // SaaS paused-session probe 2026-07-27).
    headers.set("Dev", "Debugging");
    headers.set("mcp-troubleshooting-options", JSON.stringify({
      versionNumber: "1.0",
      sessionId: target.debugIdentity.sessionId,
      hostId: target.debugIdentity.hostId,
    }));
  }

  return headers;
}

function normalizeNativeError(error: unknown): BcDevError {
  if (error instanceof BcDevError) return error;
  if (error instanceof StreamableHTTPError) {
    const status = error.code;
    if (status === 401 || status === 403) {
      return new BcDevError(
        "AUTHENTICATION_FAILED",
        "Business Central native MCP rejected the current Azure CLI identity",
        "auth",
        false,
        { status },
        { cause: error },
      );
    }
    if (status === 404) {
      return new BcDevError(
        "UNSUPPORTED_SERVER",
        "Business Central native MCP is unavailable for the configured cloud environment",
        "server",
        false,
        { status, upstreamMessage: nativeErrorDetail(error) },
        { cause: error },
      );
    }
    return new BcDevError(
      "SERVER_REJECTED",
      `Business Central native MCP rejected the request${status === undefined ? "" : ` (HTTP ${status})`}`,
      "server",
      status !== undefined && status >= 500,
      {
        status: status ?? null,
        upstreamMessage: nativeErrorDetail(error),
      },
      { cause: error },
    );
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) {
      return new BcDevError(
        "TIMEOUT",
        "Business Central native MCP did not respond before the operation timeout",
        "network",
        true,
        { upstreamMessage: nativeErrorDetail(error) },
        { cause: error },
      );
    }
    if (error.code === ErrorCode.ConnectionClosed) {
      return new BcDevError(
        "ENDPOINT_UNREACHABLE",
        "The Business Central native MCP connection closed before the request completed",
        "network",
        true,
        { upstreamMessage: nativeErrorDetail(error) },
        { cause: error },
      );
    }
    if (error.code === ErrorCode.MethodNotFound) {
      return new BcDevError(
        "NOT_FOUND",
        "Business Central native MCP did not expose the requested tool or method",
        "server",
        false,
        { upstreamMessage: nativeErrorDetail(error) },
        { cause: error },
      );
    }
    if (error.code === ErrorCode.InvalidParams) {
      return new BcDevError(
        "SERVER_REJECTED",
        "Business Central native MCP rejected the upstream tool arguments",
        "server",
        false,
        { upstreamMessage: nativeErrorDetail(error) },
        { cause: error },
      );
    }
    return new BcDevError(
      "SERVER_REJECTED",
      "Business Central native MCP returned a protocol error",
      "server",
      error.code === ErrorCode.InternalError,
      {
        protocolCode: error.code,
        upstreamMessage: nativeErrorDetail(error),
      },
      { cause: error },
    );
  }
  if (error instanceof TypeError) {
    return new BcDevError(
      "ENDPOINT_UNREACHABLE",
      "Business Central native MCP could not be reached",
      "network",
      true,
      { upstreamMessage: nativeErrorDetail(error) },
      { cause: error },
    );
  }
  return new BcDevError(
    "PROTOCOL_ERROR",
    "Business Central native MCP returned an invalid response",
    "protocol",
    false,
    { upstreamMessage: nativeErrorDetail(error) },
    { cause: error },
  );
}

function serverIdentity(connection: NativeMcpConnection): NativeMcpServerIdentity | null {
  const value = connection.serverVersion();
  if (!value || typeof value.name !== "string" || value.name.trim() === ""
    || typeof value.version !== "string" || value.version.trim() === "") {
    return null;
  }
  return { name: value.name, version: value.version };
}

async function boundedCleanup(task: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, NATIVE_MCP_CLEANUP_TIMEOUT_MS);
  });
  try {
    await Promise.race([task.catch(() => {}), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class SdkNativeMcpGateway implements NativeMcpGateway {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly connectionFactory: NativeMcpConnectionFactory = sdkConnectionFactory,
  ) {}

  async listTools(target: NativeMcpTarget, cursor?: string): Promise<NativeMcpListResponse> {
    return await this.use(target, async (connection, options) => {
      const catalog = await connection.listTools(cursor, options);
      return { server: serverIdentity(connection), catalog };
    });
  }

  async callTool(
    target: NativeMcpTarget,
    name: string,
    args: Record<string, unknown>,
  ): Promise<NativeMcpCallResponse> {
    const toolName = name.trim();
    if (toolName === "") {
      throw new BcDevError("INVALID_ARGUMENT", "toolName must be a nonblank string", "validation");
    }
    return await this.use(target, async (connection, options) => {
      const result = await connection.callTool(toolName, args, options);
      return { server: serverIdentity(connection), result };
    });
  }

  private async use<T>(
    target: NativeMcpTarget,
    operation: (connection: NativeMcpConnection, options: NativeRequestOptions) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = target.timeoutMs ?? DEFAULT_NATIVE_MCP_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      throw new BcDevError(
        "INVALID_ARGUMENT",
        "timeoutMs must be an integer from 1000 through 300000",
        "validation",
      );
    }

    let connection: NativeMcpConnection | null = null;
    let phase: NativeMcpPhase = "authorization";
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new McpError(ErrorCode.RequestTimeout, "Native MCP operation timed out"));
    }, timeoutMs);
    const options: NativeRequestOptions = {
      signal: controller.signal,
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    };

    try {
      const authorization = await abortable(
        target.authorization.getAuthorizationHeader(),
        controller.signal,
      );
      const headers = requestHeaders(target, authorization);
      connection = this.connectionFactory(new URL(NATIVE_MCP_CLOUD_URL), headers, this.fetchFn);
      phase = "connect";
      await connection.connect(options);
      phase = "operation";
      return await operation(connection, options);
    } catch (error) {
      const normalized = normalizeNativeError(error);
      if (normalized.code === "TIMEOUT") {
        throw new BcDevError(
          normalized.code,
          normalized.message,
          normalized.category,
          normalized.retryable,
          { ...normalized.details, timeoutPhase: phase },
          { cause: normalized },
        );
      }
      throw normalized;
    } finally {
      clearTimeout(timer);
      if (connection) {
        await boundedCleanup(Promise.resolve().then(() => connection!.terminateSession()));
        await boundedCleanup(Promise.resolve().then(() => connection!.close()));
      }
    }
  }
}
