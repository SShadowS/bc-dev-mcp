import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerState } from "./state";
import { createTools, type ToolDeps } from "./tools";
import { skills, skillsIndexJson } from "./skills.generated";
import { agentErrorBody, BcDevError } from "../core/agent-errors";

function toAgentToolError(tool: string, error: unknown) {
  const body = agentErrorBody(tool, error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    isError: true as const,
  };
}

function installSdkErrorFormatter(server: McpServer): void {
  // The high-level SDK validates inputs before invoking registered handlers and otherwise formats
  // those failures as unstructured prose. Replace that narrow formatting seam so schema failures
  // obey the same public error contract as handler failures. The SDK still owns validation itself.
  const formatter = server as unknown as {
    createToolError: (message: string) => ReturnType<typeof toAgentToolError>;
  };
  formatter.createToolError = (message) => {
    const tool = /(?:arguments for tool|Tool)\s+([^:\s]+)/i.exec(message)?.[1] ?? "unknown";
    if (/Input validation error:/i.test(message)) {
      return toAgentToolError(tool, new BcDevError("INVALID_ARGUMENT", message, "validation"));
    }
    if (/Output validation error:/i.test(message)) {
      return toAgentToolError(tool, new BcDevError("PROTOCOL_ERROR", message, "protocol"));
    }
    if (/Tool\s+\S+\s+not found/i.test(message)) {
      return toAgentToolError(tool, new BcDevError("NOT_FOUND", message, "server"));
    }
    return toAgentToolError(tool, new BcDevError("INTERNAL_ERROR", message, "internal"));
  };
}

// Runtime guard (v0.1 final review): the SDK publishes outputSchema for every tool, so a
// non-object handler result assigned to structuredContent would be a protocol violation.
export function toToolResponse(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
} {
  const structured = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : undefined;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) ?? String(result) }],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}

export function buildServer(state: ServerState, deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: "bc-dev-mcp", version: "0.3.0" },
    // Skills served as resources under skill:// — tracks draft SEP-2640 (io.modelcontextprotocol/skills).
    { capabilities: { extensions: { "io.modelcontextprotocol/skills": {} } } },
  );
  installSdkErrorFormatter(server);

  for (const tool of createTools(state, deps)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (params: Record<string, unknown>) => {
        try {
          return toToolResponse(await tool.handler(params));
        } catch (err) {
          return toAgentToolError(tool.name, err);
        }
      },
    );
  }

  for (const skill of skills) {
    server.registerResource(
      skill.name,
      skill.uri,
      { title: skill.name, description: skill.description, mimeType: skill.mimeType },
      async () => ({ contents: [{ uri: skill.uri, mimeType: skill.mimeType, text: skill.text }] }),
    );
  }
  server.registerResource(
    "skills-index",
    "skill://index.json",
    { title: "Skills index", description: "Discovery index of the Agent Skills this server ships (draft SEP-2640)", mimeType: "application/json" },
    async () => ({ contents: [{ uri: "skill://index.json", mimeType: "application/json", text: skillsIndexJson }] }),
  );

  return server;
}
