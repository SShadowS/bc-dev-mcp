// Typed client for al-perf's deep-capture request queue (docs/capture-request-contract.md
// in al-perf). Shells the al-perf CLI (`lifecycle captures ...`) — never opens the SQLite
// store directly, since that's a private implementation detail of al-perf, not the contract.

export interface CaptureRequestRow {
  id: number;
  tenant: string;
  fingerprint: string;
  findingId: number;
  appId: string;
  appName: string | null;
  objectType: string;
  objectId: number;
  methodName: string;
  reason: string;
  status: "pending" | "claimed" | "fulfilled" | "expired" | "cancelled";
  requestedAt: string;
  expiresAt: string;
  claimedAt: string | null;
  claimedBy: string | null;
  fulfilledAt: string | null;
  fulfilledByProfileId: string | null;
}

export interface CliRunner {
  (args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface QueueClientConfig {
  cliPrefix: string[]; // e.g. ["bun", "run", ".../index.ts"] — pre-split
  dbPath?: string; // appended as ["lifecycle", "--db", dbPath, ...] parent option
}

export type ClaimResult = { ok: true } | { ok: false; reason: "raced" | "gone" | "error"; message: string };

function dbArgs(cfg: QueueClientConfig): string[] {
  return cfg.dbPath ? ["--db", cfg.dbPath] : [];
}

// Branches on the exact wording captureRequestFailureMessage() emits (al-perf
// src/cli/commands/lifecycle.ts) — "status is <x>." for a row someone else already
// advanced, "No capture request with id <n>." for one that never existed or expired
// past retention.
function classifyFailure(message: string): "raced" | "gone" | "error" {
  if (message.includes("No capture request with id")) return "gone";
  if (message.includes("status is ")) return "raced";
  return "error";
}

function assertRow(row: unknown, index: number): CaptureRequestRow {
  const r = row as Partial<CaptureRequestRow> | null;
  if (
    typeof r !== "object" || r === null ||
    typeof r.id !== "number" ||
    typeof r.tenant !== "string" ||
    typeof r.appId !== "string" ||
    typeof r.objectType !== "string" ||
    typeof r.methodName !== "string" ||
    typeof r.objectId !== "number"
  ) {
    throw new Error(`captures list: malformed row at index ${index}: ${JSON.stringify(row)}`);
  }
  return r as CaptureRequestRow;
}

export function createQueueClient(cfg: QueueClientConfig, run: CliRunner) {
  const base = [...cfg.cliPrefix, "lifecycle", ...dbArgs(cfg), "captures"];

  return {
    async listPending(tenant?: string): Promise<CaptureRequestRow[]> {
      const args = [...base, "list", "-f", "json", "--status", "pending", ...(tenant ? ["--tenant", tenant] : [])];
      const { code, stdout, stderr } = await run(args);
      if (code !== 0) {
        throw new Error(`captures list failed (exit ${code}): ${stderr.trim()}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        throw new Error(`captures list: could not parse stdout as JSON: ${(err as Error).message}`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`captures list: expected a JSON array, got ${typeof parsed}`);
      }
      return parsed.map((row, i) => assertRow(row, i));
    },

    async claim(id: number, by: string): Promise<ClaimResult> {
      const args = [...base, "claim", String(id), "--by", by];
      const { code, stderr } = await run(args);
      if (code === 0) return { ok: true };
      const message = stderr.trim();
      return { ok: false, reason: classifyFailure(message), message };
    },

    async cancel(id: number): Promise<{ ok: boolean; message: string }> {
      const args = [...base, "cancel", String(id)];
      const { code, stdout, stderr } = await run(args);
      const ok = code === 0;
      return { ok, message: (ok ? stdout : stderr).trim() };
    },
  };
}
