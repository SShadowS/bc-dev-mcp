import { z } from "zod";
import { BcDevError } from "../../core/agent-errors";
import type {
  NativeMcpContext,
  NativeMcpTarget,
} from "../../core/native-mcp";
import type { CloudConnectionConfig } from "../../core/types";
import type { ServerState } from "../state";
import {
  claimTestRun,
  connectionShape,
  requireSession,
  resolve,
  type ToolDefinition,
  type ToolDeps,
} from "./shared";

const nativeConnectionShape = {
  project: connectionShape.project,
  environmentType: z
    .enum(["Sandbox", "Production"])
    .optional()
    .describe("Business Central cloud target kind (default: from launch.json)"),
  environmentName: connectionShape.environmentName,
  tenant: connectionShape.tenant,
} as const;

const contextSchema = z
  .enum(["business", "runtime", "debugging"])
  .describe(
    "Native BC28 catalog: business actions, AL runtime test tools, or troubleshooting tools for the active paused debugger",
  );

const companySchema = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .regex(/^[^\r\n]+$/, "company must not contain newline characters")
  .describe("Exact Business Central company name required by the native MCP gateway");

const configurationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .regex(/^[^\r\n]+$/, "configurationName must not contain newline characters")
  .optional()
  .describe("Named Business Central MCP configuration; valid only for context='business' (default: dynamic configuration)");

const timeoutSchema = z
  .number()
  .int()
  .min(1_000)
  .max(300_000)
  .optional()
  .describe("Whole connect-and-request timeout in milliseconds (default 180000; max 300000)");

const serverIdentitySchema = z.object({
  name: z.string().describe("Native MCP server name reported during initialization"),
  version: z.string().describe("Native MCP server version reported during initialization"),
}).describe("Upstream native MCP server identity");

const nativeToolSchema = z.looseObject({
  name: z.string().describe("Exact upstream tool name for bcdev_native_call"),
  title: z.string().optional().describe("Optional upstream display title"),
  description: z.string().optional().describe("Upstream tool instructions"),
  inputSchema: z.looseObject({}).describe("Upstream JSON Schema for arguments"),
  outputSchema: z.looseObject({}).optional().describe("Upstream JSON Schema for structured output, when published"),
  annotations: z.looseObject({}).optional().describe("Upstream read/write and safety hints"),
}).describe("One native Business Central tool definition");

const catalogSchema = z.looseObject({
  tools: z.array(nativeToolSchema).describe("Native tools available in the selected BC context"),
  nextCursor: z.string().optional().describe("Opaque cursor for the next catalog page"),
}).describe("Unchanged upstream ListToolsResult, including unknown metadata fields");

const callResultSchema = z.looseObject({
  content: z.array(z.looseObject({
    type: z.string().describe("MCP content-block type"),
  })).optional().describe("Unchanged upstream MCP content blocks"),
  structuredContent: z.looseObject({}).optional().describe("Unchanged upstream structured result, when present"),
  isError: z.boolean().optional().describe("true when the upstream Business Central tool reported an error"),
}).describe("Unchanged upstream CallToolResult, including unknown fields and metadata");

function targetFrom(
  state: ServerState,
  deps: ToolDeps,
  params: Record<string, unknown>,
): NativeMcpTarget {
  const { config, authorization } = resolve(params, deps);
  if (config.environmentType === "OnPrem") {
    throw new BcDevError(
      "UNSUPPORTED_SERVER",
      "Business Central native MCP passthrough currently supports cloud Sandbox and Production environments only",
      "server",
    );
  }
  const context = params["context"] as NativeMcpContext;
  const configurationName = params["configurationName"] as string | undefined;
  if (configurationName !== undefined && context !== "business") {
    throw new BcDevError(
      "INVALID_ARGUMENT",
      "configurationName is only valid for context='business'",
      "validation",
    );
  }
  return {
    config: config as CloudConnectionConfig,
    authorization,
    company: params["company"] as string,
    context,
    ...(configurationName === undefined ? {} : { configurationName }),
    ...(context === "debugging"
      ? { debugIdentity: requireSession(state).nativeDebugIdentity }
      : {}),
    timeoutMs: params["timeoutMs"] as number | undefined,
  };
}

export function createNativeMcpTools(
  state: ServerState,
  deps: ToolDeps,
): ToolDefinition[] {
  return [
    {
      name: "bcdev_native_list",
      title: "List BC native MCP tools",
      description:
        "Discover the dynamic Business Central 28 native MCP tool catalog for business actions, AL runtime, or the active paused debugger. Use the returned input schemas with bcdev_native_call.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      schema: {
        ...nativeConnectionShape,
        company: companySchema,
        context: contextSchema,
        configurationName: configurationNameSchema,
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe("Opaque nextCursor from a previous bcdev_native_list result"),
        timeoutMs: timeoutSchema,
      },
      outputSchema: z.object({
        context: contextSchema,
        server: serverIdentitySchema,
        catalog: catalogSchema,
      }),
      handler: async (params) => {
        const target = targetFrom(state, deps, params);
        const response = await deps.nativeMcpGateway.listTools(
          target,
          params["cursor"] as string | undefined,
        );
        return { context: target.context, ...response };
      },
    },
    {
      name: "bcdev_native_call",
      title: "Call BC native MCP tool",
      description:
        "Invoke one exact tool from bcdev_native_list. Arguments and the complete native result pass through unchanged. This generic bridge is conservatively marked destructive because business actions can write data.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      schema: {
        ...nativeConnectionShape,
        company: companySchema,
        context: contextSchema,
        configurationName: configurationNameSchema,
        toolName: z
          .string()
          .trim()
          .min(1)
          .describe("Exact native tool name returned by bcdev_native_list"),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments matching the selected native tool's published inputSchema (default {})"),
        timeoutMs: timeoutSchema,
      },
      outputSchema: z.object({
        context: contextSchema,
        toolName: z.string().describe("Exact invoked native tool name"),
        server: serverIdentitySchema,
        result: callResultSchema,
      }),
      handler: async (params) => {
        const context = params["context"] as NativeMcpContext;
        const runLocked = context === "runtime";
        if (runLocked) claimTestRun(state);
        try {
          const target = targetFrom(state, deps, params);
          const toolName = params["toolName"] as string;
          const response = await deps.nativeMcpGateway.callTool(
            target,
            toolName,
            (params["arguments"] as Record<string, unknown> | undefined) ?? {},
          );
          return { context: target.context, toolName, ...response };
        } finally {
          if (runLocked) state.testRunActive = false;
        }
      },
    },
  ];
}
