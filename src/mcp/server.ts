import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerState } from "./state";
import { createTools, type ToolDeps } from "./tools";
import { skills, skillsIndexJson } from "./skills.generated";

export function buildServer(state: ServerState, deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: "bc-dev-mcp", version: "0.1.0" },
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
          const result = (await tool.handler(params)) as Record<string, unknown>;
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
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
