// Integration-ish smoke: runs the REAL scripts/work-capture-queue.ts as a child process
// (via Bun.spawn) against tests/fakes/fake-al-perf-cli.ts standing in for al-perf's CLI.
// The BC target is deliberately unreachable (an unused local port), so runCaptureShipCycle
// fails fast at the preflight stage — real network code runs, but nothing external or slow
// is required. This exercises the actual wiring end to end: entry-args parsing, the queue
// client shelling the (fake) CLI, the worker's claim/cancel policy, the per-request
// tenant/description override, and the exit-code rules — none of which the unit tests for
// entry-args/queue-client/worker exercise together as one process graph.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");
const SCRIPT = join(REPO_ROOT, "scripts", "work-capture-queue.ts");
const FAKE_CLI = join(REPO_ROOT, "tests", "fakes", "fake-al-perf-cli.ts");

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tenant: "contoso",
    fingerprint: "telemetry:abc123",
    findingId: 9,
    appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    appName: "Sales Ext",
    objectType: "Codeunit",
    objectId: 50100,
    methodName: "processline",
    reason: "RT0018: 5 runs, severity critical",
    status: "pending",
    requestedAt: "2026-07-01T09:00:00.000Z",
    expiresAt: "2026-07-15T09:00:00.000Z",
    claimedAt: null,
    claimedBy: null,
    fulfilledAt: null,
    fulfilledByProfileId: null,
    ...over,
  };
}

const BASE_ENV = { BC_DEV_USER: "admin", BC_DEV_PASSWORD: "pw", BC_MDC_CONVERTER: "nonexistent-converter" };

async function runEntry(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: ["bun", SCRIPT, "--al-perf-cli", `bun run ${FAKE_CLI}`, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, ...BASE_ENV, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

const UNREACHABLE = ["--server", "http://127.0.0.1", "--instance", "BC", "--snapshot-port", "65533", "--duration", "1", "--poll-interval", "1"];

describe("work-capture-queue.ts: real entry, spawned, against a fake al-perf CLI", () => {
  test("claims the row, the cycle fails fast at preflight (unreachable target), the claim is released, exit 1", async () => {
    const { stderr, exitCode } = await runEntry(
      [...UNREACHABLE, "--al-perf-tenant", "should-be-overridden", "--description", "user description", "--dry-run", "--allow-dry-run-claims"],
      { FAKE_CLI_ROWS: JSON.stringify([row()]) },
    );
    expect(stderr).toContain('overriding --al-perf-tenant "should-be-overridden" with the request\'s own tenant "contoso"');
    expect(stderr).toContain('description set to "capture-request #1: RT0018: 5 runs, severity critical"');
    expect(stderr).toContain("polled 1, worked 1, failures 1, claimErrors 0");
    expect(stderr).toContain("#1: error (released)");
    expect(stderr).toContain("FAILED: 1 cycle failure(s)");
    expect(exitCode).toBe(1);
  }, 15000);

  test("empty queue: no claim attempted, exit 0", async () => {
    const { stderr, exitCode } = await runEntry([...UNREACHABLE, "--dry-run", "--allow-dry-run-claims"], { FAKE_CLI_ROWS: "[]" });
    expect(stderr).toContain("polled 0, worked 0, failures 0, claimErrors 0");
    expect(exitCode).toBe(0);
  }, 15000);

  test("a broken CLI (claim always errors) never runs a cycle and exits 1 naming the CLI as the suspect", async () => {
    const { stderr, exitCode } = await runEntry([...UNREACHABLE, "--dry-run", "--allow-dry-run-claims"], {
      FAKE_CLI_ROWS: JSON.stringify([row()]),
      FAKE_CLI_CLAIM_ERROR: "1",
    });
    expect(stderr).toContain("claimErrors 1");
    expect(stderr).toContain("the al-perf CLI itself appears broken");
    expect(exitCode).toBe(1);
  }, 15000);

  test("a raced claim (busy pool) is normal — moves on, no cycle for that row, still exit 0 on an otherwise-empty result", async () => {
    const { stderr, exitCode } = await runEntry([...UNREACHABLE, "--dry-run", "--allow-dry-run-claims"], {
      FAKE_CLI_ROWS: JSON.stringify([row()]),
      FAKE_CLI_CLAIM_FAIL: "1",
    });
    expect(stderr).toContain("#1: claim-raced");
    expect(stderr).toContain("claimErrors 0");
    expect(exitCode).toBe(0);
  }, 15000);

  test("--dry-run forwarded without --allow-dry-run-claims is a usage error, exit 2, never invokes the CLI", async () => {
    const { stderr, exitCode } = await runEntry([...UNREACHABLE, "--dry-run"], { FAKE_CLI_ROWS: JSON.stringify([row()]) });
    expect(stderr).toContain("--allow-dry-run-claims");
    expect(exitCode).toBe(2);
  }, 15000);
});
