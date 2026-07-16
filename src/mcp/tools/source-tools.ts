import { z } from "zod";
import { fetchSourceContent, type SourceContentResult } from "../../core/source-content";
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
        const result = await fetchSourceContent(config, authorization, objectType, objectId, deps.fetchFn);
        // REST 404 means "no deployed source" OR "route missing" (pre-2.0 server) — both arrive as
        // empty content. A live debug session can give the authoritative hub answer for either.
        if (result.content === "" && state.debug) {
          const viaHub = await state.debug.client.getSourceContent(objectType, objectId).catch(() => null);
          if (viaHub && viaHub.content !== "") return shapeResult(viaHub, objectType, objectId, "hub");
        }
        return shapeResult(result, objectType, objectId, "rest");
      },
    },
  ];
}
