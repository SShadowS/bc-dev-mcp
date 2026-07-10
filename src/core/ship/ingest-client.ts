// Client-side mirror of al-perf's ingest budgets, verified 2026-07-10:
//   web/server.ts:45        MAX_BODY_SIZE = 100 * 1024 * 1024 (whole request)
//   web/handlers/ingest.ts  DEFAULT_MAX_PROFILE_BYTES = 134_217_728 (decompressed; AL_PERF_MAX_PROFILE_BYTES)
//   src/config.ts           irJson.maxInvocations = 500_000 (exceeding -> analysis throws -> 500 analyze_failed)
export const MAX_COMPRESSED_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 134_217_728;
export const MAX_INVOCATIONS = 500_000;

export function checkBudgets(i: {
  compressedBytes: number;
  decompressedBytes: number;
  invocationCount: number;
}): { ok: true } | { ok: false; reason: string } {
  if (i.compressedBytes > MAX_COMPRESSED_BYTES) {
    return { ok: false, reason: `gzipped upload is ${i.compressedBytes} bytes — exceeds the 100 MB request cap` };
  }
  if (i.decompressedBytes > DEFAULT_MAX_DECOMPRESSED_BYTES) {
    return { ok: false, reason: `ir-json is ${i.decompressedBytes} bytes — exceeds the server's 128 MiB decompressed default (AL_PERF_MAX_PROFILE_BYTES)` };
  }
  if (i.invocationCount > MAX_INVOCATIONS) {
    return { ok: false, reason: `${i.invocationCount} invocations — exceeds the ${MAX_INVOCATIONS} ir-json invocation budget` };
  }
  return { ok: true };
}

export interface ShipRequest {
  baseUrl: string;
  tenant: string;
  token: string;
  activityId: string;
  manifest: Record<string, unknown>;
  gzippedProfile: Uint8Array;
  filename: string;
}

export type ShipOutcome =
  | { kind: "stored" }
  | { kind: "duplicate" }
  | { kind: "rejected"; status: number; errorCode: string; actionable: string }
  | { kind: "unreachable"; error: string };

// Error-code -> operator guidance. Codes verified against al-perf web/handlers/ingest.ts (2026-07-10).
export function actionableFor(status: number, errorCode: string): string {
  switch (errorCode) {
    case "invalid_gzip":
      return "server could not gunzip the profile part — the part must be the gzipped ir-json bytes themselves; check that no proxy between here and the server rewrites request bodies";
    case "invalid_capture_kind":
      return "manifest.captureKind must be 'sampling' or 'instrumentation' — this script always sends 'instrumentation'; is the al-perf server up to date?";
    case "payload_too_large":
      return "decompressed ir-json exceeds the server budget (AL_PERF_MAX_PROFILE_BYTES, default 128 MiB) — shorten --duration or capture off-peak; local artifacts are retained";
    case "unauthorized":
      return "bearer token rejected — AL_PERF_TOKEN must be the per-tenant token returned once by /api/tenants/register (not the admin shared secret)";
    case "tenant_not_registered":
      return "tenant unknown to the al-perf server — register it first (POST /api/tenants/register; see docs/capture-ship-recipe.md)";
    case "tenant_missing_public_key":
    case "tenant_public_key_invalid":
      return "tenant registration is incomplete/broken on the server — re-register with a valid RSA public key";
    case "invalid_tenant_id":
      return "X-Tenant-Id must match ^[A-Za-z0-9][A-Za-z0-9-]{0,39}$ — check AL_PERF_TENANT";
    case "invalid_idempotency_key":
      return "X-Idempotency-Key must be a GUID — this is an internal bug in capture-and-ship (activityId should always be a GUID)";
    case "analyze_failed":
      return "server-side analysis failed — most often the ir-json invocation budget (500,000 invocations) or a malformed document; shorten --duration; artifacts are retained for inspection";
    default:
      return `unexpected response ${status} (${errorCode})`;
  }
}

const RETRY_DELAYS_MS = [2000, 4000, 8000];

/**
 * POST one capture to {baseUrl}/api/ingest. Retries transient failures only
 * (connect errors and 5xx other than analyze_failed, which is deterministic);
 * the idempotency key (activityId) makes retries safe — a repeat of a stored
 * ingest returns 202 "duplicate".
 */
export async function shipIngest(
  fetchFn: typeof fetch,
  req: ShipRequest,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<ShipOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${req.baseUrl.replace(/\/+$/, "")}/api/ingest`;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      // Rebuild the FormData per attempt — a consumed body cannot be resent.
      const fd = new FormData();
      fd.append("manifest", new Blob([JSON.stringify(req.manifest)], { type: "application/json" }), "manifest.json");
      fd.append("profile", new Blob([req.gzippedProfile as BlobPart], { type: "application/octet-stream" }), req.filename);
      res = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${req.token}`,
          "X-Tenant-Id": req.tenant,
          "X-Idempotency-Key": req.activityId,
        },
        body: fd,
      });
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      return { kind: "unreachable", error: err instanceof Error ? err.message : String(err) };
    }

    if (res.status === 202) {
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      return body.status === "duplicate" ? { kind: "duplicate" } : { kind: "stored" };
    }

    const errorCode = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "unknown";
    const transient = res.status >= 500 && errorCode !== "analyze_failed";
    if (transient && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]!);
      continue;
    }
    return { kind: "rejected", status: res.status, errorCode, actionable: actionableFor(res.status, errorCode) };
  }
}
