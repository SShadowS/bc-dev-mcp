import { z } from "zod";
import { fetchSourceContent, type SourceContentResult } from "../../core/source-content";
import { DevEndpointError } from "../../core/server-info";
import type { ServerState } from "../state";
import { connectionShape, resolve, type ToolDefinition, type ToolDeps } from "./shared";

const NO_SOURCE_MESSAGE = "No deployed source for this object — base-application objects ship without source";

function shapeResult(r: SourceContentResult, objectType: number, objectId: number, source: "rest" | "hub") {
  return {
    content: r.content,
    isAlContent: r.isAlContent,
    objectType,
    objectId,
    source,
    ...(r.content === "" ? { message: NO_SOURCE_MESSAGE } : {}),
  };
}

export function createSourceTools(state: ServerState, deps: ToolDeps): ToolDefinition[] {
  return [
    {
      name: "bcdev_source",
      title: "Read deployed object source",
      description:
        "Fetch the server's authoritative AL source for a deployed object — use when a break frame or coverage entry has no local file (third-party extension, generated object). Object types use the same integers break events report (e.g. 5 = Codeunit).",
      annotations: { readOnlyHint: true, openWorldHint: true },
      schema: {
        ...connectionShape,
        objectType: z.number().int().describe("Object type integer as reported by break events and coverage (e.g. 5 = Codeunit)"),
        objectId: z.number().int().describe("Object ID"),
      },
      outputSchema: z.object({
        content: z.string(),
        isAlContent: z.boolean().describe("false = the server has no deployed AL source for this object"),
        objectType: z.number(),
        objectId: z.number(),
        source: z.enum(["rest", "hub"]).describe("rest = dev/sourcecontent endpoint; hub = live debug session fallback"),
        message: z.string().optional(),
      }),
      handler: async (params) => {
        const objectType = params["objectType"] as number;
        const objectId = params["objectId"] as number;
        const { config, authorization } = resolve(params, deps);
        try {
          const result = await fetchSourceContent(config, authorization, objectType, objectId, deps.fetchFn);
          return shapeResult(result, objectType, objectId, "rest");
        } catch (err) {
          const unsupported = err instanceof DevEndpointError && err.message.includes("needs dev API");
          if (!unsupported) throw err;
          if (!state.debug) {
            throw new Error("Server does not expose dev/sourcecontent (needs dev API >= 2.0) and no debug session is bound for the hub fallback");
          }
          const result = await state.debug.client.getSourceContent(objectType, objectId);
          return shapeResult(result, objectType, objectId, "hub");
        }
      },
    },
  ];
}
