import type { ClientTypeName } from "../snapshot/snapshot-types";

// al-perf activity types (src/types/batch.ts): "WebClient" | "Background" | "WebServiceAPI".
// ClientService sessions surface in BC as web-client sessions, so they map to WebClient.
export function activityTypeFor(clientType: ClientTypeName): "WebClient" | "Background" | "WebServiceAPI" {
  if (clientType === "Background") return "Background";
  if (clientType === "WebServiceClient") return "WebServiceAPI";
  return "WebClient";
}

export interface ManifestParams {
  activityId: string;
  clientType: ClientTypeName;
  description: string;
  scheduleId?: string;
  /** ISO-8601 — when the capture was armed. */
  startTime: string;
  /** Measured wall clock, arm -> finish, in ms. */
  activityDurationMs: number;
}

// Field set verified against al-perf web/handlers/ingest.ts extractMetrics (2026-07-10).
// captureKind is validated server-side ("sampling" | "instrumentation").
export function buildIngestManifest(p: ManifestParams): Record<string, unknown> {
  const m: Record<string, unknown> = {
    activityId: p.activityId,
    activityType: activityTypeFor(p.clientType),
    activityDescription: p.description,
    captureKind: "instrumentation",
    startTime: p.startTime,
    activityDuration: p.activityDurationMs,
  };
  if (p.scheduleId) m["scheduleId"] = p.scheduleId;
  return m;
}
