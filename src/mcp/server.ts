import { McpServer, ProtocolError, ProtocolErrorCode, type CacheHint } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServerState } from "./state";
import { createTools, type ToolDeps } from "./tools";
import { skills, type EmbeddedSkill } from "./skills.generated";
import { BcDevError } from "../core/agent-errors";
import { agentErrorBody } from "./agent-errors";

function toAgentToolError(tool: string, error: unknown) {
  const body = agentErrorBody(tool, error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    isError: true as const,
  };
}

export function installSdkErrorFormatter(
  server: McpServer,
  warn: (message: string) => void = (message) => console.error(message),
): boolean {
  // The high-level SDK validates inputs before invoking registered handlers and otherwise formats
  // those failures as unstructured prose. Replace that narrow formatting seam so schema failures
  // obey the same public error contract as handler failures. The SDK still owns validation itself.
  const formatter = server as unknown as {
    createToolError?: (message: string) => ReturnType<typeof toAgentToolError>;
  };
  if (typeof formatter.createToolError !== "function") {
    warn("bc-dev-mcp warning: SDK validation errors will use default formatting because McpServer.createToolError is unavailable");
    return false;
  }
  const original = formatter.createToolError;
  const replacement = (message: string) => {
    const tool = /(?:arguments for tool|Tool)\s+([^:\s]+)/i.exec(message)?.[1] ?? "unknown";
    if (/Input validation error:/i.test(message)) {
      return toAgentToolError(tool, new BcDevError("INVALID_ARGUMENT", message, "validation"));
    }
    if (/Output validation error:/i.test(message)) {
      return toAgentToolError(tool, new BcDevError("PROTOCOL_ERROR", message, "protocol"));
    }
    // An unknown tool never reaches this formatter: SDK v2 answers it with a -32602 protocol error.
    return toAgentToolError(tool, new Error(message));
  };
  try {
    formatter.createToolError = replacement;
  } catch {
    warn("bc-dev-mcp warning: SDK validation errors will use default formatting because McpServer.createToolError is not replaceable");
    return false;
  }
  if (formatter.createToolError !== replacement) {
    try {
      formatter.createToolError = original;
    } catch {
      // Best effort: an unusual accessor ignored the first assignment and may reject restoration.
    }
    warn("bc-dev-mcp warning: SDK validation errors will use default formatting because the formatter replacement did not take effect");
    return false;
  }
  // The assignment check proves replacement only; the MCP validation integration test proves the
  // installed SDK actually dispatches schema failures through this method.
  return true;
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

// The tool list and the skill resources are embedded at build time and never change while the
// process runs, so 2026-07-28 clients may cache them for a day (the client-side ceiling) and share
// the cache across principals. Cache entries are keyed by serverInfo name@version, so a release
// with a new version invalidates them.
const STATIC_CACHE_HINT: CacheHint = { ttlMs: 86_400_000, cacheScope: "public" };

// SEP-2640 skill entry: all frontmatter plus the complete file manifest (single-file skills).
function skillEntry(skill: EmbeddedSkill) {
  return {
    uri: skill.uri,
    frontmatter: skill.frontmatter,
    resources: [{ uri: skill.uri, digest: skill.digest, size: skill.size }],
  };
}

export function buildServer(state: ServerState, deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: "bc-dev-mcp", version: "0.4.0" },
    {
      capabilities: {
        // Fixed lists: never send list_changed, so don't advertise it (the SDK defaults it to true).
        tools: { listChanged: false },
        resources: { listChanged: false },
        // Skills (final SEP-2640): skills/list + skills/get below, files via resources/read.
        // Empty object = no directoryRead (single-file skills, resources/directory/read not served).
        extensions: { "io.modelcontextprotocol/skills": {} },
      },
      cacheHints: {
        "tools/list": STATIC_CACHE_HINT,
        "resources/list": STATIC_CACHE_HINT,
        "resources/read": STATIC_CACHE_HINT,
        "server/discover": STATIC_CACHE_HINT,
      },
    },
  );
  installSdkErrorFormatter(server);

  for (const tool of createTools(state, deps)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: z.object(tool.schema),
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (params: Record<string, unknown>, ctx) => {
        const progressToken = ctx.mcpReq._meta?.progressToken;
        try {
          return toToolResponse(await tool.handler(params, {
            signal: ctx.mcpReq.signal,
            progress: progressToken === undefined ? undefined : (progress, total, message) => {
              void ctx.mcpReq.notify({
                method: "notifications/progress",
                params: { progressToken, progress, ...(total !== undefined && { total }), ...(message !== undefined && { message }) },
              }).catch(() => {});
            },
          }));
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
  server.server.setRequestHandler("skills/list", { params: z.object({ cursor: z.string().optional() }) }, () => ({
    resultType: "complete",
    skills: skills.map(skillEntry),
    ...STATIC_CACHE_HINT,
  }));
  server.server.setRequestHandler("skills/get", { params: z.object({ uri: z.string() }) }, ({ uri }) => {
    const skill = skills.find((s) => s.uri === uri);
    if (!skill) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill: ${uri}`);
    return { resultType: "complete", skill: skillEntry(skill), ...STATIC_CACHE_HINT };
  });

  return server;
}
