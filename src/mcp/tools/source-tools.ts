import { z } from "zod";
import {
  DEFAULT_PACKAGE_DOWNLOAD_BYTES,
  DEFAULT_PACKAGE_DOWNLOAD_TIMEOUT_MS,
  downloadPackage,
  MAX_PACKAGE_DOWNLOAD_BYTES,
  MAX_PACKAGE_DOWNLOAD_TIMEOUT_MS,
  MAX_PACKAGE_SELECTOR_LENGTH,
} from "../../core/package-download";
import { fetchSourceContent, type SourceContentResult } from "../../core/source-content";
import type { ServerState } from "../state";
import { connectionShape, resolve, type ToolDefinition, type ToolDeps } from "./shared";

const NO_SOURCE_MESSAGE =
  "No deployed source was returned for this object — it may be compiled-only or source exposure may be disabled";

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
    {
      name: "bcdev_package_download",
      title: "Download one AL dependency package",
      description:
        "Download one explicitly identified installed Business Central .app dependency/symbol package into <project>/.alpackages. The version is a minimum; a 404 can also mean the server lacks dev/packages. This does not enumerate or synchronize dependencies.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      schema: {
        ...connectionShape,
        publisher: z.string().trim().min(1).max(MAX_PACKAGE_SELECTOR_LENGTH)
          .regex(/^[^\r\n]+$/, "publisher must not contain newline characters")
          .describe("Installed package publisher"),
        appName: z.string().trim().min(1).max(MAX_PACKAGE_SELECTOR_LENGTH)
          .regex(/^[^\r\n]+$/, "appName must not contain newline characters")
          .describe("Installed package name"),
        version: z.string().trim()
          .regex(/^\d+\.\d+\.\d+\.\d+$/, "version must contain four numeric parts")
          .describe("Minimum installed package version, for example 28.0.0.0"),
        appId: z.string().trim()
          .regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, "appId must be a GUID")
          .optional()
          .describe("Package app ID when known; omitted for publisher/name selection and the special Application package"),
        timeoutMs: z.number().int().min(1).max(MAX_PACKAGE_DOWNLOAD_TIMEOUT_MS).optional().describe(
          `Whole-request timeout in milliseconds (default ${DEFAULT_PACKAGE_DOWNLOAD_TIMEOUT_MS}; maximum ${MAX_PACKAGE_DOWNLOAD_TIMEOUT_MS})`,
        ),
        maxBytes: z.number().int().min(1).max(MAX_PACKAGE_DOWNLOAD_BYTES).optional().describe(
          `Maximum compressed package download size in bytes (default ${DEFAULT_PACKAGE_DOWNLOAD_BYTES}; maximum ${MAX_PACKAGE_DOWNLOAD_BYTES})`,
        ),
      },
      outputSchema: z.object({
        status: z.enum(["downloaded", "replaced", "unchanged"])
          .describe("Whether the local package was newly written, replaced, or already byte-identical"),
        packagePath: z.string().describe("Absolute path of the validated .app under <project>/.alpackages"),
        publisher: z.string().describe("Publisher read from the downloaded SymbolReference.json"),
        appName: z.string().describe("Package name read from the downloaded SymbolReference.json"),
        appId: z.string()
          .regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
          .describe("Package app ID read from the downloaded SymbolReference.json"),
        requestedVersion: z.string()
          .regex(/^\d+\.\d+\.\d+\.\d+$/)
          .describe("Normalized minimum version requested from Business Central"),
        resolvedVersion: z.string()
          .regex(/^\d+\.\d+\.\d+\.\d+$/)
          .describe("Installed package version returned by Business Central"),
        bytes: z.number().int().nonnegative().describe("Downloaded package size in bytes"),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).describe("SHA-256 digest of the installed package"),
      }),
      handler: async (params) => {
        const { config, authorization, project } = resolve(params, deps);
        return downloadPackage(
          config,
          authorization,
          project,
          {
            publisher: params["publisher"] as string,
            appName: params["appName"] as string,
            version: params["version"] as string,
            appId: params["appId"] as string | undefined,
          },
          deps.fetchFn,
          {
            timeoutMs: params["timeoutMs"] as number | undefined,
            maxBytes: params["maxBytes"] as number | undefined,
          },
        );
      },
    },
  ];
}
