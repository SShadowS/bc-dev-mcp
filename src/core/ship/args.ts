import type { ConnectionConfig } from "../types";
import { resolveConnection } from "../launch-config";
import type { ClientTypeName } from "../snapshot/snapshot-types";
import { DEFAULT_SNAPSHOT_PORT } from "../urls";

export interface ShipConfig {
  snapshotPort: number;
  clientType: ClientTypeName;
  userId?: string;
  captureSeconds: number;
  pollSeconds: number;
  converterPath: string;
  alPerfUrl: string; // empty only in --dry-run
  alPerfTenant: string;
  alPerfToken: string;
  scheduleId?: string;
  description: string;
  outDir: string;
  dryRun: boolean;
  keepArtifacts: boolean;
}

export type ResolveResult =
  | { kind: "config"; config: ShipConfig; connection: ConnectionConfig }
  | { kind: "help" }
  | { kind: "error"; errors: string[] };

// Mirrors al-perf web/storage.ts ACTIVITY_ID_RE / TENANT_CODE_RE — reject client-side
// what the server would 400 anyway.
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

const CLIENT_TYPES: ClientTypeName[] = ["WebServiceClient", "WebClient", "Background", "ClientService"];

export const SHIP_USAGE = `usage: bun scripts/capture-and-ship.ts [options]

One scheduled cycle: arm BC instrumentation capture -> wait -> finish ->
bc-mdc-converter --format ir-json -> gzip -> POST to al-perf /api/ingest.
"0 sessions captured" exits 0 without shipping (a normal outcome).

BC connection (or --project <dir> with .vscode/launch.json; credentials via BC_DEV_USER / BC_DEV_PASSWORD):
  --server <url>             BC server URL, e.g. http://localhost
  --instance <name>          server instance, e.g. BC
  --bc-tenant <id>           BC tenant (default "default")
  --snapshot-port <n>        snapshot-debugger port (default ${DEFAULT_SNAPSHOT_PORT}; separate from the dev port)
  --project <dir>            AL project dir; reads .vscode/launch.json for server/instance

capture:
  --client-type <t>          WebServiceClient|WebClient|Background|ClientService (default WebClient)
  --user-id <user>           bind the next session for this user only
  --duration <seconds>       capture window (default 60)
  --poll-interval <seconds>  status poll cadence (default 5)

convert:
  --converter <path>         bc-mdc-converter binary (or BC_MDC_CONVERTER env)

ship (env: AL_PERF_URL, AL_PERF_TENANT, AL_PERF_TOKEN):
  --al-perf-url <url>        al-perf server base URL
  --al-perf-tenant <code>    tenant code registered on the al-perf server
  --al-perf-token <token>    per-tenant ingest token (prefer the env var; NOT the shared secret)
  --schedule-id <guid>       manifest scheduleId, groups recurring runs
  --description <text>       manifest activityDescription

misc:
  --out-dir <dir>            artifact directory (default ".")
  --dry-run                  capture + convert, print the manifest, skip the POST
  --keep-artifacts           keep .snapshot.zip / .ir.json even on success
  -h, --help                 show this help

exit codes: 0 shipped/duplicate/no-capture/dry-run, 1 cycle failed, 2 bad usage`;

const VALUE_FLAGS = new Set([
  "--server", "--instance", "--bc-tenant", "--snapshot-port", "--project",
  "--client-type", "--user-id", "--duration", "--poll-interval",
  "--converter", "--al-perf-url", "--al-perf-tenant", "--al-perf-token",
  "--schedule-id", "--description", "--out-dir",
]);

export function resolveShipConfig(argv: string[], env: Record<string, string | undefined>): ResolveResult {
  const errors: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") return { kind: "help" };
    if (a === "--dry-run" || a === "--keep-artifacts") {
      flags.set(a, true);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) {
        errors.push(`${a} needs a value`);
        continue;
      }
      flags.set(a, v);
      i++;
      continue;
    }
    errors.push(`unknown argument: ${a}`);
  }

  const str = (k: string) => flags.get(k) as string | undefined;
  const num = (k: string, dflt: number): number => {
    const raw = str(k);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      errors.push(`${k} must be a positive integer, got ${raw}`);
      return dflt;
    }
    return n;
  };

  const clientTypeRaw = str("--client-type") ?? "WebClient";
  if (!(CLIENT_TYPES as string[]).includes(clientTypeRaw)) {
    errors.push(`--client-type must be one of ${CLIENT_TYPES.join("|")}, got ${clientTypeRaw}`);
  }

  const scheduleId = str("--schedule-id");
  if (scheduleId !== undefined && !GUID_RE.test(scheduleId)) {
    errors.push(`--schedule-id must be a GUID, got ${scheduleId}`);
  }

  const dryRun = flags.get("--dry-run") === true;
  const alPerfUrl = str("--al-perf-url") ?? env["AL_PERF_URL"] ?? "";
  const alPerfTenant = str("--al-perf-tenant") ?? env["AL_PERF_TENANT"] ?? "";
  const alPerfToken = str("--al-perf-token") ?? env["AL_PERF_TOKEN"] ?? "";
  if (!dryRun) {
    if (!alPerfUrl) errors.push("AL_PERF_URL (or --al-perf-url) is required unless --dry-run");
    if (!alPerfTenant) errors.push("AL_PERF_TENANT (or --al-perf-tenant) is required unless --dry-run");
    if (!alPerfToken) errors.push("AL_PERF_TOKEN (or --al-perf-token) is required unless --dry-run");
  }
  if (alPerfTenant && !TENANT_RE.test(alPerfTenant)) {
    errors.push(`AL_PERF_TENANT must match ${TENANT_RE} (al-perf tenant code), got ${alPerfTenant}`);
  }

  const converterPath = str("--converter") ?? env["BC_MDC_CONVERTER"] ?? "";
  if (!converterPath) {
    errors.push("--converter (or BC_MDC_CONVERTER) is required — path to the bc-mdc-converter binary");
  }

  let connection: ConnectionConfig | null = null;
  try {
    connection = resolveConnection(
      { server: str("--server"), serverInstance: str("--instance"), tenant: str("--bc-tenant") },
      str("--project"),
      env,
    );
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  // Numeric reads MUST happen before the error-return below — num() records
  // validation failures into `errors` as a side effect (the --duration -5 test).
  const snapshotPort = num("--snapshot-port", DEFAULT_SNAPSHOT_PORT);
  const captureSeconds = num("--duration", 60);
  const pollSeconds = num("--poll-interval", 5);

  if (errors.length > 0 || connection === null) return { kind: "error", errors };

  return {
    kind: "config",
    connection,
    config: {
      snapshotPort,
      clientType: clientTypeRaw as ClientTypeName,
      userId: str("--user-id"),
      captureSeconds,
      pollSeconds,
      converterPath,
      alPerfUrl,
      alPerfTenant,
      alPerfToken,
      scheduleId,
      description: str("--description") ?? "Scheduled instrumentation capture",
      outDir: str("--out-dir") ?? ".",
      dryRun,
      keepArtifacts: flags.get("--keep-artifacts") === true,
    },
  };
}
