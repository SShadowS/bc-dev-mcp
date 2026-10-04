import { z } from "zod";
import { BcDevError } from "../../core/agent-errors";
import {
  listApps,
  MAX_APP_LIFECYCLE_TIMEOUT_MS,
  DEFAULT_APP_LIFECYCLE_TIMEOUT_MS,
  publishApp,
  uninstallApp,
  unpublishApp,
  type AppLifecycleContext,
} from "../../core/app-lifecycle";
import type { DependencyPublishingOption, SchemaUpdateMode } from "../../core/urls";
import type { ServerState } from "../state";
import { connectionShape, resolve, type ToolDefinition, type ToolDeps } from "./shared";

const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const lifecycleShape = {
  ...connectionShape,
  companyId: z.string().regex(GUID, "companyId must be a GUID").optional()
    .describe("Automation API company ID (default: the first company Business Central returns; extensions are tenant-wide)"),
  apiPort: z.number().int().min(1).max(65535).optional()
    .describe("On-prem Automation API port (default: BC_DEV_API_PORT env var, else 7048); ignored for SaaS"),
};

const timeoutShape = {
  timeoutMs: z.number().int().min(1).max(MAX_APP_LIFECYCLE_TIMEOUT_MS).optional()
    .describe(`Per-request timeout in milliseconds (default ${DEFAULT_APP_LIFECYCLE_TIMEOUT_MS}; maximum ${MAX_APP_LIFECYCLE_TIMEOUT_MS})`),
};

const appIdShape = z.string().regex(GUID, "appId must be a GUID").describe("App ID (the id in app.json), as bcdev_app_list reports it");

const appRecordSchema = z.object({
  appId: z.string().describe("App ID, lower-case GUID"),
  packageId: z.string().describe("Package ID of this published version, lower-case GUID"),
  name: z.string().describe("App display name"),
  publisher: z.string().describe("App publisher"),
  version: z.string().describe("Four-part version a.b.c.d"),
  isInstalled: z.boolean().describe("Whether this published version is installed"),
  publishedAs: z.string().describe("Publish scope reported by Business Central, e.g. Dev, Global, PTE"),
});

function apiPort(params: Record<string, unknown>, deps: ToolDeps): number | undefined {
  const explicit = params["apiPort"] as number | undefined;
  if (explicit !== undefined) return explicit;
  const fromEnv = deps.env["BC_DEV_API_PORT"]?.trim();
  if (!fromEnv) return undefined;
  const port = Number(fromEnv);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BcDevError("CONFIGURATION_ERROR", "BC_DEV_API_PORT must be an integer port between 1 and 65535", "configuration");
  }
  return port;
}

function lifecycleContext(params: Record<string, unknown>, deps: ToolDeps): AppLifecycleContext {
  const { config, authorization } = resolve(params, deps);
  return {
    config,
    authorization,
    fetchFn: deps.fetchFn,
    apiPort: apiPort(params, deps),
    companyId: params["companyId"] as string | undefined,
    timeoutMs: params["timeoutMs"] as number | undefined,
  };
}

export function createAppTools(_state: ServerState, deps: ToolDeps): ToolDefinition[] {
  return [
    {
      name: "bcdev_app_list",
      title: "List published apps",
      description:
        "List the apps published on the Business Central tenant (Automation API extensions): app ID, package ID, name, publisher, version, installed state, and publish scope (Dev, Global, PTE). Use it to find the appId and order for bcdev_app_uninstall and bcdev_app_unpublish.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      schema: {
        ...lifecycleShape,
        ...timeoutShape,
        publisher: z.string().trim().min(1).optional().describe("Only apps from this exact publisher"),
        appId: z.string().regex(GUID, "appId must be a GUID").optional().describe("Only published versions of this app ID"),
      },
      outputSchema: z.object({
        companyId: z.string().describe("Company the Automation API was addressed through"),
        apps: z.array(appRecordSchema).describe("Published apps, one row per published version"),
      }),
      handler: async (params) =>
        listApps(lifecycleContext(params, deps), {
          publisher: params["publisher"] as string | undefined,
          appId: params["appId"] as string | undefined,
        }),
    },
    {
      name: "bcdev_app_publish",
      title: "Publish an app through the dev endpoint",
      description:
        "Publish and install a compiled .app at Dev scope through the developer endpoint. schemaUpdateMode recreate drops the app's table data. Cannot publish at Global scope. If Business Central refuses to replace a copy published at Global scope, uninstall and unpublish that copy first.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      schema: {
        ...connectionShape,
        ...timeoutShape,
        appPath: z.string().min(1).describe("Absolute path to the compiled .app file"),
        schemaUpdateMode: z.enum(["synchronize", "recreate", "forcesync"]).optional()
          .describe("Schema update mode (default synchronize; recreate drops table data; forcesync forces destructive schema changes)"),
        dependencyPublishingOption: z.enum(["default", "ignore", "strict"]).optional()
          .describe("Dependency publishing option (default 'default')"),
      },
      outputSchema: z.object({
        status: z.literal("published").describe("The app was published and installed"),
        appId: z.string().describe("App ID read from the package"),
        name: z.string().describe("App name read from the package"),
        publisher: z.string().describe("Publisher read from the package"),
        version: z.string().describe("Version read from the package"),
        bytes: z.number().int().nonnegative().describe("Uploaded package size in bytes"),
        schemaUpdateMode: z.string().describe("Schema update mode sent"),
        dependencyPublishingOption: z.string().describe("Dependency publishing option sent"),
      }),
      handler: async (params) => {
        const { config, authorization } = resolve(params, deps);
        return publishApp(
          { config, authorization, fetchFn: deps.fetchFn, timeoutMs: params["timeoutMs"] as number | undefined },
          {
            appPath: params["appPath"] as string,
            schemaUpdateMode: params["schemaUpdateMode"] as SchemaUpdateMode | undefined,
            dependencyPublishingOption: params["dependencyPublishingOption"] as DependencyPublishingOption | undefined,
          },
        );
      },
    },
    {
      name: "bcdev_app_uninstall",
      title: "Uninstall an app",
      description:
        "Uninstall the installed version of an app through the Automation API. Business Central also uninstalls every installed dependent app, without warning; those are reported in alsoUninstalled. deleteData: true also deletes the app's data. Returns alreadyUninstalled when the app is published but not installed.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      schema: {
        ...lifecycleShape,
        ...timeoutShape,
        appId: appIdShape,
        deleteData: z.boolean().optional().describe("Also delete the app's data (uninstallAndDeleteExtensionData; default false)"),
      },
      outputSchema: z.object({
        status: z.enum(["uninstalled", "alreadyUninstalled"]).describe("Whether this call uninstalled the app"),
        app: appRecordSchema.describe("The target app after the call"),
        dataDeleted: z.boolean().describe("Whether the app's data was deleted"),
        alsoUninstalled: z.array(appRecordSchema).nullable()
          .describe("Dependent apps Business Central uninstalled along with the target; null when the state after uninstall could not be read"),
        warning: z.string().optional().describe("Present when the uninstall succeeded but the state afterwards is unknown"),
      }),
      handler: async (params) =>
        uninstallApp(lifecycleContext(params, deps), {
          appId: params["appId"] as string,
          deleteData: params["deleteData"] as boolean | undefined,
        }),
    },
    {
      name: "bcdev_app_unpublish",
      title: "Unpublish an app",
      description:
        "Unpublish one published version of an app through the Automation API (BC 25.4 and later). The app must be uninstalled first, and no app that depends on it may still be published; Business Central refuses otherwise. Pass version when several versions are published.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      schema: {
        ...lifecycleShape,
        ...timeoutShape,
        appId: appIdShape,
        version: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/, "version must contain four numeric parts").optional()
          .describe("Published version to remove, required when several versions are published"),
      },
      outputSchema: z.object({
        status: z.literal("unpublished").describe("The version was unpublished"),
        app: appRecordSchema.describe("The version that was unpublished, as it was listed before the call"),
      }),
      handler: async (params) =>
        unpublishApp(lifecycleContext(params, deps), {
          appId: params["appId"] as string,
          version: params["version"] as string | undefined,
        }),
    },
  ];
}
