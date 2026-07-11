// Argument resolution for scripts/work-capture-queue.ts. Owns queue-worker-specific
// flags and splits everything else into `rest`, forwarded verbatim to
// resolveShipConfig (src/core/ship/args.ts) — the entry script owns no BC/al-perf
// connection flags of its own; those are all capture-and-ship's.
import os from "node:os";
import type { WorkerReport } from "./worker";

export interface EntryConfig {
  cliPrefix: string[]; // whitespace-split --al-perf-cli / AL_PERF_CLI
  queueDbPath?: string;
  executor: string;
  max: number;
  queueTenant?: string;
  keepClaimOnFailure: boolean;
  workloadCmd?: string;
  rest: string[]; // forwarded verbatim to resolveShipConfig(rest, env)
}

export type EntryResolveResult =
  | { kind: "config"; config: EntryConfig }
  | { kind: "help" }
  | { kind: "error"; errors: string[] };

export const ENTRY_USAGE = `usage: bun scripts/work-capture-queue.ts [queue options] [capture-and-ship options]

Polls al-perf's capture-request queue, claims one pending request (D3), runs
capture-and-ship against it, and lets al-perf's automatic fulfillment close
the loop. See docs/capture-queue-worker.md for the full contract.

queue (env AL_PERF_CLI):
  --al-perf-cli <cmd>        al-perf CLI command prefix, whitespace-split
                              (e.g. "bun run U:/Git/al-perf/src/cli/index.ts");
                              required (or AL_PERF_CLI)
  --queue-db <path>          lifecycle DB path, passed to the CLI as --db
  --executor <name>          stable claim identity (default: this host's name)
  --max <n>                  requests to attempt this invocation (default 1)
  --queue-tenant <t>         only poll this tenant's pending requests
  --keep-claim-on-failure    don't cancel the claim on no-capture/error —
                              build your own retry above the queue
  --workload-cmd <cmd>       spawned once capture is armed, whitespace-split;
                              gets BCQ_* env vars naming the request (see docs)
  --allow-dry-run-claims     required alongside a forwarded --dry-run — a dry
                              run still claims a real queue row (it just
                              doesn't ship); without this, --dry-run errors
  -h, --help                 show this help, then capture-and-ship's flags

everything else forwards verbatim to capture-and-ship: BC connection, capture
window, converter, al-perf URL/token, --out-dir, etc. (see below).
--al-perf-tenant is accepted but OVERRIDDEN per request with the request's
own tenant (ship destination must match the requester, per the executor
contract's same-tenant rule); --description is likewise overridden with
"capture-request #<id>: <reason>" — both overrides are logged.

exit codes: 0 worked a request to a terminal outcome (shipped/duplicate/
no-capture/dry-run) or the queue was empty; 1 a cycle failed, or claim
errors left nothing worked (the al-perf CLI itself looks broken); 2 bad usage`;

const OWN_VALUE_FLAGS = new Set(["--al-perf-cli", "--queue-db", "--executor", "--max", "--queue-tenant", "--workload-cmd"]);

export function resolveEntryArgs(
  argv: string[],
  env: Record<string, string | undefined>,
  hostnameFn: () => string = os.hostname,
): EntryResolveResult {
  const errors: string[] = [];
  const flags = new Map<string, string>();
  let keepClaimOnFailure = false;
  let allowDryRunClaims = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") return { kind: "help" };
    if (a === "--keep-claim-on-failure") {
      keepClaimOnFailure = true;
      continue;
    }
    if (a === "--allow-dry-run-claims") {
      allowDryRunClaims = true;
      continue;
    }
    if (OWN_VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) {
        errors.push(`${a} needs a value`);
        continue;
      }
      flags.set(a, v);
      i++;
      continue;
    }
    // Not one of our own flags — forwarded verbatim; resolveShipConfig owns
    // validating it (unknown flag, needs-a-value, etc.).
    rest.push(a);
  }

  const cliRaw = flags.get("--al-perf-cli") ?? env["AL_PERF_CLI"];
  if (!cliRaw) {
    errors.push('--al-perf-cli (or AL_PERF_CLI) is required — the al-perf CLI command prefix, e.g. "bun run U:/Git/al-perf/src/cli/index.ts"');
  }
  // Whitespace-split only — a prefix containing a quoted path with spaces is NOT
  // supported (documented limitation; use an 8.3 short path or a junction on
  // Windows rather than teaching this a shell-quoting grammar).
  const cliPrefix = cliRaw ? cliRaw.trim().split(/\s+/) : [];

  let max = 1;
  const maxRaw = flags.get("--max");
  if (maxRaw !== undefined) {
    const n = Number(maxRaw);
    if (!Number.isInteger(n) || n <= 0) {
      errors.push(`--max must be a positive integer, got ${maxRaw}`);
    } else {
      max = n;
    }
  }

  // A dry run still claims a real queue row — it just never ships, so the claim
  // sits until the next scheduled run cancels it (no-capture/error path) or it
  // self-expires via TTL. Require an explicit acknowledgment before letting a
  // dry-run invocation touch the live queue at all.
  if (rest.includes("--dry-run") && !allowDryRunClaims) {
    errors.push(
      "--dry-run was forwarded to capture-and-ship, but a dry run still claims a real queue row (it does not ship, so nothing is fulfilled — the claim just sits until the next run cancels it or it self-expires via TTL); pass --allow-dry-run-claims to acknowledge this and proceed",
    );
  }

  if (errors.length > 0) return { kind: "error", errors };

  return {
    kind: "config",
    config: {
      cliPrefix,
      queueDbPath: flags.get("--queue-db"),
      executor: flags.get("--executor") ?? hostnameFn(),
      max,
      queueTenant: flags.get("--queue-tenant"),
      keepClaimOnFailure,
      workloadCmd: flags.get("--workload-cmd"),
      rest,
    },
  };
}

export interface ExitDecision {
  code: 0 | 1;
  messages: string[]; // logged (in order) before exiting; empty on a quiet success
}

// D5 exit codes, plus the claim-error carry-over: claimErrors alone (a busy pool racing
// claims, or a request that vanished between poll and claim) is normal and doesn't fail
// the run; claimErrors WITHOUT any request reaching an actual cycle outcome means the
// al-perf CLI itself is broken (bad --al-perf-cli, unreachable queue db, ...) — a
// distinct, louder signal for cron/monitoring than "just busy." Pure function of the
// worker's report so the full branch truth table is unit-testable without spawning
// anything (see tests/core/queue/entry-args.test.ts).
export function decideExit(report: WorkerReport): ExitDecision {
  const ranACycle = report.worked.some((w) => w.outcome !== "claim-raced" && w.outcome !== "claim-error");
  const messages: string[] = [];

  if (report.claimErrors > 0 && !ranACycle) {
    messages.push(
      `FAILED: ${report.claimErrors} claim error(s) and no request reached a cycle outcome — the al-perf CLI itself appears broken (check --al-perf-cli / AL_PERF_CLI and --queue-db)`,
    );
    return { code: 1, messages };
  }
  if (report.claimErrors > 0) {
    messages.push(`WARNING: ${report.claimErrors} claim error(s) occurred alongside other work that succeeded — investigate the al-perf CLI / queue db`);
  }
  if (report.failures > 0) {
    messages.push(`FAILED: ${report.failures} cycle failure(s)`);
    return { code: 1, messages };
  }
  return { code: 0, messages };
}
