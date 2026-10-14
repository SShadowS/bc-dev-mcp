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
import { downloadSymbols } from "../../core/symbols-download";
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
        warning: z.string().optional().describe("Nonfatal local cleanup warning; the validated package is installed"),
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
    {
      name: "bcdev_symbols_download",
      title: "Download all symbols app.json needs",
      description:
        "Fill <project>/.alpackages with every symbol package the project's app.json needs: platform System, the Application concept, declared dependencies, and all their dependencies. Downloads only what is missing at a satisfying version (sequential, one request each) and reports each package as downloaded/replaced/unchanged/skipped/failed. dryRun lists the app.json references and their local-cache status without a connection.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      schema: {
        ...connectionShape,
        force: z.boolean().optional().describe(
          "Re-request every package even when .alpackages already satisfies it (default false); byte-identical results report unchanged",
        ),
        dryRun: z.boolean().optional().describe(
          "No network and no credentials: list the app.json references (not their dependencies) as skipped (cached at a satisfying version) or missing (default false)",
        ),
        timeoutMs: z.number().int().min(1).max(MAX_PACKAGE_DOWNLOAD_TIMEOUT_MS).optional().describe(
          `Per-package request timeout in milliseconds (default ${DEFAULT_PACKAGE_DOWNLOAD_TIMEOUT_MS}; maximum ${MAX_PACKAGE_DOWNLOAD_TIMEOUT_MS})`,
        ),
        maxBytes: z.number().int().min(1).max(MAX_PACKAGE_DOWNLOAD_BYTES).optional().describe(
          `Per-package maximum compressed download size in bytes (default ${DEFAULT_PACKAGE_DOWNLOAD_BYTES}; maximum ${MAX_PACKAGE_DOWNLOAD_BYTES})`,
        ),
      },
      outputSchema: z.object({
        packageDir: z.string().describe("Absolute <project>/.alpackages path"),
        summary: z.object({
          downloaded: z.number().int().describe("Packages newly written"),
          replaced: z.number().int().describe("Packages that overwrote a different file of the same canonical name"),
          unchanged: z.number().int().describe("Forced re-downloads that were byte-identical to the local file"),
          skipped: z.number().int().describe("References already satisfied by .alpackages; not requested"),
          missing: z.number().int().describe("dryRun only: references .alpackages does not satisfy"),
          failed: z.number().int().describe("Packages the server could not supply; see packages[].error"),
        }).describe("Count of packages per status"),
        packages: z.array(z.object({
          publisher: z.string().describe("Requested publisher"),
          appName: z.string().describe("Requested package name"),
          appId: z.string().optional().describe("Requested app ID; absent for the Application concept"),
          minVersion: z.string().describe("Requested minimum version"),
          source: z.enum(["platform", "application", "dependency", "transitive"])
            .describe("app.json platform/application/dependencies entry, or a dependency of another package"),
          requiredBy: z.string().describe("\"app.json\" or the <publisher>/<appName> of the package that depends on it"),
          status: z.enum(["downloaded", "replaced", "unchanged", "skipped", "missing", "failed"]).describe("Outcome for this package"),
          resolvedVersion: z.string().optional().describe("Version downloaded or found in .alpackages"),
          packagePath: z.string().optional().describe("Absolute path of the downloaded or cached .app"),
          error: z.object({
            code: z.string().describe("Error code (NOT_FOUND, TIMEOUT, SERVER_REJECTED, PROTOCOL_ERROR)"),
            message: z.string().describe("Error message"),
          }).optional().describe("failed only: why the package was not downloaded; its dependencies were not explored"),
          warning: z.string().optional().describe("Nonfatal local cleanup warning; the package is installed"),
        })).describe("One entry per package, in request order (app.json references first)"),
      }),
      handler: async (params) => {
        const options = { force: params["force"] as boolean | undefined, dryRun: params["dryRun"] as boolean | undefined };
        if (options.dryRun) {
          return downloadSymbols((params["project"] as string | undefined) ?? deps.cwd, options, null);
        }
        const { config, authorization, project } = resolve(params, deps);
        return downloadSymbols(project, options, (selector) =>
          downloadPackage(config, authorization, project, selector, deps.fetchFn, {
            timeoutMs: params["timeoutMs"] as number | undefined,
            maxBytes: params["maxBytes"] as number | undefined,
          }));
      },
    },
  ];
}
