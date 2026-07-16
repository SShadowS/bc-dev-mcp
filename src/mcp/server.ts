import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerState } from "./state";
import { createTools, type ToolDeps } from "./tools";
import { skills, skillsIndexJson } from "./skills.generated";

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
          return {
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
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
