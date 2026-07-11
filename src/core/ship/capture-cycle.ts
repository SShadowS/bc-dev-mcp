import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionConfig } from "../types";
import type { AuthorizationProviderFactory } from "../authorization";
import { SnapshotClient, type FinishResult } from "../snapshot/snapshot-client";
import type { SnapshotStatus } from "../snapshot/snapshot-types";
import { listEntryNames } from "../snapshot/zip";
import type { SpawnRunner } from "../snapshot/converter";
import type { ShipConfig } from "./args";
import { buildIngestManifest } from "./manifest";
import { checkBudgets, shipIngest } from "./ingest-client";

export interface CycleDeps {
  fetchFn: typeof fetch;
  authorizationFactory: AuthorizationProviderFactory;
  runConverter: SpawnRunner;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  uuid: () => string;
  /**
   * Per-request timeout (ms) for each attach/status/finish call to the snapshot endpoint.
   * A single hung BC request would otherwise block the cycle forever, defeating the capture
   * deadline. Implemented as a race against `sleep(requestTimeoutMs)` (see `withRequestTimeout`
   * below) rather than a real timer, so tests stay deterministic. Default 30000ms.
   */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// Races a network call against a timer built from the injected sleep. In production sleep is
// a real (macrotask-based) timer, so a normal response — however many microtask ticks it takes
// internally — always drains before the timeout macrotask fires; only a genuinely hung request
// loses the race.
async function withRequestTimeout<T>(op: Promise<T>, ms: number, sleep: (ms: number) => Promise<void>): Promise<T> {
  const timeout = sleep(ms).then((): never => {
    throw new Error(`request timed out after ${ms}ms`);
  });
  return Promise.race([op, timeout]);
}

// Shared by the budget-gate and ship-failure paths: writes the manifest next to the retained
// zip/ir-json so the capture can be re-shipped manually (curl recipe in the doc).
function writeManifestArtifact(outDir: string, activityId: string, manifest: Record<string, unknown>): string {
  const manifestPath = join(outDir, `${activityId}.manifest.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

export type CycleOutcome =
  | { kind: "shipped"; activityId: string; gzippedBytes: number }
  | { kind: "duplicate"; activityId: string }
  | { kind: "no-capture" } // first-class non-error: exit 0, nothing shipped
  | { kind: "dry-run"; activityId: string; manifest: Record<string, unknown>; gzippedBytes: number; zipPath: string; irPath: string }
  | {
      kind: "error";
      stage: "preflight" | "attach" | "capture" | "finish" | "convert" | "budget" | "ship";
      message: string;
      artifacts?: { zipPath?: string; irPath?: string; manifestPath?: string };
    };

export async function runCaptureShipCycle(cfg: ShipConfig, conn: ConnectionConfig, deps: CycleDeps): Promise<CycleOutcome> {
  const client = new SnapshotClient(deps.fetchFn, conn, cfg.snapshotPort, deps.authorizationFactory(conn));
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // 1. Preflight the snapshot endpoint (separate port from the dev endpoint). Timeout-guarded
  // like attach/status/finish: a hung metadata() call has no deadline to fall back on yet, and
  // under cron/Task Scheduler's "don't start new instance while running" mode it would wedge
  // every future run permanently.
  try {
    const md = await withRequestTimeout(client.metadata(), requestTimeoutMs, deps.sleep);
    deps.log(`snapshot endpoint ok (webApiVersion ${md.webApiVersion})`);
  } catch (err) {
    return {
      kind: "error",
      stage: "preflight",
      message: `snapshot endpoint unreachable: ${err instanceof Error ? err.message : String(err)} — is port ${cfg.snapshotPort} exposed and the dev endpoint enabled?`,
    };
  }

  // 2. Arm. One GUID per cycle = BC debuggingContext AND al-perf activityId/idempotency key.
  const activityId = deps.uuid();
  const armedAt = deps.now();
  const armedAtIso = new Date(armedAt).toISOString();
  let affinityCookie: string | null = null;
  try {
    const attach = await withRequestTimeout(
      client.attachInstrumentation({
        debuggingContext: activityId,
        clientType: cfg.clientType,
        userId: cfg.userId,
        sessionId: -1,
      }),
      requestTimeoutMs,
      deps.sleep,
    );
    affinityCookie = attach.affinityCookie;
    deps.log(`armed instrumentation capture ${activityId} (attachKind ${attach.attachKind})`);
  } catch (err) {
    return { kind: "error", stage: "attach", message: err instanceof Error ? err.message : String(err) };
  }

  // 3. Capture window: recording runs server-side; we poll for logging + failure detection.
  const deadline = armedAt + cfg.captureSeconds * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(Math.min(cfg.pollSeconds * 1000, deadline - deps.now()));
    let status: SnapshotStatus;
    try {
      status = await withRequestTimeout(client.status(activityId, affinityCookie), requestTimeoutMs, deps.sleep);
    } catch (err) {
      // Covers both network errors and a hung request (withRequestTimeout) — either way, this
      // poll is transient; the deadline check above still governs how long we keep trying.
      deps.log(`status poll failed (${err instanceof Error ? err.message : String(err)}) — continuing to deadline`);
      continue;
    }
    deps.log(`status: ${status}`);
    if (status === "Failed") {
      await withRequestTimeout(client.finish(activityId, affinityCookie), requestTimeoutMs, deps.sleep).catch(() => undefined); // best-effort drain
      return { kind: "error", stage: "capture", message: "server reported the snapshot session as Failed" };
    }
    if (status === "Finished") break; // session ended on its own — collect what was recorded
  }

  // 4. Finish. An empty body = "0 sessions captured" — a normal, non-error outcome.
  let fin: FinishResult;
  try {
    fin = await withRequestTimeout(client.finish(activityId, affinityCookie), requestTimeoutMs, deps.sleep);
  } catch (err) {
    return { kind: "error", stage: "finish", message: err instanceof Error ? err.message : String(err) };
  }
  const capturedMs = deps.now() - armedAt;
  if (fin.empty) return { kind: "no-capture" };
  if (!listEntryNames(fin.body).some((n) => n.endsWith(".mdc"))) {
    return { kind: "error", stage: "finish", message: "finish returned an archive without .mdc members — not an instrumentation recording" };
  }

  // 5. Persist the raw recording FIRST — retained on every later failure (no data loss).
  mkdirSync(cfg.outDir, { recursive: true });
  const zipPath = join(cfg.outDir, `${activityId}.snapshot.zip`);
  writeFileSync(zipPath, Buffer.from(fin.body));

  // 6. Convert: bc-mdc-converter <in.mdc.zip> <out> --format ir-json (exit 0 = wrote <out>).
  const irPath = join(cfg.outDir, `${activityId}.ir.json`);
  const conv = await deps.runConverter(cfg.converterPath, [zipPath, irPath, "--format", "ir-json"]);
  if (conv.code !== 0) {
    return { kind: "error", stage: "convert", message: conv.stderr.trim() || `converter exited ${conv.code}`, artifacts: { zipPath } };
  }
  const irBytes = readFileSync(irPath);
  let invocationCount = 0;
  try {
    const doc = JSON.parse(irBytes.toString("utf8")) as { invocations?: unknown[] };
    invocationCount = Array.isArray(doc.invocations) ? doc.invocations.length : 0;
  } catch {
    return { kind: "error", stage: "convert", message: "converter output is not valid JSON", artifacts: { zipPath, irPath } };
  }
  deps.log(`converted: ${invocationCount} invocations, ${irBytes.length} bytes ir-json`);

  // 7. gzip at the PART level (server detects the 1f 8b magic; Content-Encoding does NOT work).
  const gzipped = gzipSync(irBytes);

  // Manifest is pure/cheap to build — do it before the budget gate so a budget rejection can
  // still write it next to the retained artifacts (same manual re-ship pattern as a ship failure).
  const manifest = buildIngestManifest({
    activityId,
    clientType: cfg.clientType,
    description: cfg.description,
    scheduleId: cfg.scheduleId,
    startTime: armedAtIso,
    activityDurationMs: capturedMs,
  });

  // 8. Client-side budget preflight — fail fast, artifacts (+ manifest) kept.
  const budget = checkBudgets({ compressedBytes: gzipped.length, decompressedBytes: irBytes.length, invocationCount });
  if (!budget.ok) {
    const manifestPath = writeManifestArtifact(cfg.outDir, activityId, manifest);
    return {
      kind: "error",
      stage: "budget",
      message: `${budget.reason} — shorten --duration or capture off-peak`,
      artifacts: { zipPath, irPath, manifestPath },
    };
  }

  if (cfg.dryRun) {
    return { kind: "dry-run", activityId, manifest, gzippedBytes: gzipped.length, zipPath, irPath };
  }

  // 9. Ship. Idempotency key makes retries safe; 202 "duplicate" is success/no-op.
  const outcome = await shipIngest(
    deps.fetchFn,
    { baseUrl: cfg.alPerfUrl, tenant: cfg.alPerfTenant, token: cfg.alPerfToken, activityId, manifest, gzippedProfile: gzipped, filename: `${activityId}.ir.json.gz` },
    { sleep: deps.sleep },
  );
  if (outcome.kind === "rejected" || outcome.kind === "unreachable") {
    // Write the manifest next to the artifacts so the capture can be re-shipped manually (curl recipe in the doc).
    const manifestPath = writeManifestArtifact(cfg.outDir, activityId, manifest);
    const message =
      outcome.kind === "rejected"
        ? `${outcome.status} ${outcome.errorCode}: ${outcome.actionable}`
        : `al-perf unreachable after retries: ${outcome.error}`;
    return { kind: "error", stage: "ship", message, artifacts: { zipPath, irPath, manifestPath } };
  }
  if (cfg.keepArtifacts) {
    // Same manual re-ship pattern as the error paths: the manifest belongs next to the
    // retained zip/ir-json, not just in the (already-shipped) request body.
    writeManifestArtifact(cfg.outDir, activityId, manifest);
  } else {
    try { unlinkSync(zipPath); } catch {}
    try { unlinkSync(irPath); } catch {}
  }
  return outcome.kind === "duplicate"
    ? { kind: "duplicate", activityId }
    : { kind: "shipped", activityId, gzippedBytes: gzipped.length };
}
