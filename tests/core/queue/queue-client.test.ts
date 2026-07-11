import { describe, expect, test } from "bun:test";
import { createQueueClient, type CaptureRequestRow, type CliRunner } from "../../../src/core/queue/queue-client";

const CFG = { cliPrefix: ["bun", "run", "src/cli/index.ts"] };
const CFG_DB = { cliPrefix: ["bun", "run", "src/cli/index.ts"], dbPath: "/tmp/lifecycle.db" };

const ROW: CaptureRequestRow = {
  id: 17,
  tenant: "contoso",
  fingerprint: "telemetry:9f2c1a7b0e4d5f61",
  findingId: 203,
  appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  appName: "Sales Extensions",
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
};

describe("listPending", () => {
  test("builds the documented args and parses valid rows", async () => {
    let sawArgs: string[] = [];
    const run: CliRunner = async (args) => {
      sawArgs = args;
      return { code: 0, stdout: JSON.stringify([ROW]), stderr: "" };
    };
    const rows = await createQueueClient(CFG, run).listPending();
    expect(sawArgs).toEqual([
      "bun", "run", "src/cli/index.ts", "lifecycle",
      "captures", "list", "-f", "json", "--status", "pending",
    ]);
    expect(rows).toEqual([ROW]);
  });

  test("adds --db and --tenant when configured", async () => {
    let sawArgs: string[] = [];
    const run: CliRunner = async (args) => {
      sawArgs = args;
      return { code: 0, stdout: "[]", stderr: "" };
    };
    await createQueueClient(CFG_DB, run).listPending("contoso");
    expect(sawArgs).toEqual([
      "bun", "run", "src/cli/index.ts", "lifecycle", "--db", "/tmp/lifecycle.db",
      "captures", "list", "-f", "json", "--status", "pending", "--tenant", "contoso",
    ]);
  });

  test("empty queue returns [] without throwing", async () => {
    const run: CliRunner = async () => ({ code: 0, stdout: "[]", stderr: "" });
    await expect(createQueueClient(CFG, run).listPending()).resolves.toEqual([]);
  });

  test("non-zero exit throws with the CLI's stderr", async () => {
    const run: CliRunner = async () => ({ code: 1, stdout: "", stderr: "database is locked" });
    await expect(createQueueClient(CFG, run).listPending()).rejects.toThrow(/database is locked/);
  });

  test("malformed JSON throws", async () => {
    const run: CliRunner = async () => ({ code: 0, stdout: "not json", stderr: "" });
    await expect(createQueueClient(CFG, run).listPending()).rejects.toThrow(/JSON/);
  });

  test("malformed element throws naming the index", async () => {
    const bad = { ...ROW, id: "not-a-number" };
    const run: CliRunner = async () => ({ code: 0, stdout: JSON.stringify([ROW, bad]), stderr: "" });
    await expect(createQueueClient(CFG, run).listPending()).rejects.toThrow(/index 1/);
  });
});

describe("claim", () => {
  test("exit 0 maps to ok", async () => {
    const run: CliRunner = async () => ({ code: 0, stdout: "Claimed capture request #17 for worker1", stderr: "" });
    await expect(createQueueClient(CFG, run).claim(17, "worker1")).resolves.toEqual({ ok: true });
  });

  test("builds the documented args", async () => {
    let sawArgs: string[] = [];
    const run: CliRunner = async (args) => {
      sawArgs = args;
      return { code: 0, stdout: "", stderr: "" };
    };
    await createQueueClient(CFG_DB, run).claim(17, "worker1");
    expect(sawArgs).toEqual([
      "bun", "run", "src/cli/index.ts", "lifecycle", "--db", "/tmp/lifecycle.db",
      "captures", "claim", "17", "--by", "worker1",
    ]);
  });

  test('"status is " message maps to raced', async () => {
    const message = "Capture request #17 cannot be claimed — status is claimed.";
    const run: CliRunner = async () => ({ code: 1, stdout: "", stderr: message });
    await expect(createQueueClient(CFG, run).claim(17, "worker1")).resolves.toEqual({
      ok: false, reason: "raced", message,
    });
  });

  test('"No capture request with id" message maps to gone', async () => {
    const message = "No capture request with id 999.";
    const run: CliRunner = async () => ({ code: 1, stdout: "", stderr: message });
    await expect(createQueueClient(CFG, run).claim(999, "worker1")).resolves.toEqual({
      ok: false, reason: "gone", message,
    });
  });

  test("unrecognized message maps to error", async () => {
    const run: CliRunner = async () => ({ code: 1, stdout: "", stderr: "boom" });
    await expect(createQueueClient(CFG, run).claim(1, "worker1")).resolves.toEqual({
      ok: false, reason: "error", message: "boom",
    });
  });
});

describe("cancel", () => {
  test("exit 0 maps to ok true with the message", async () => {
    const run: CliRunner = async () => ({ code: 0, stdout: "Cancelled capture request #17", stderr: "" });
    await expect(createQueueClient(CFG, run).cancel(17)).resolves.toEqual({
      ok: true, message: "Cancelled capture request #17",
    });
  });

  test("builds the documented args", async () => {
    let sawArgs: string[] = [];
    const run: CliRunner = async (args) => {
      sawArgs = args;
      return { code: 0, stdout: "", stderr: "" };
    };
    await createQueueClient(CFG, run).cancel(17);
    expect(sawArgs).toEqual(["bun", "run", "src/cli/index.ts", "lifecycle", "captures", "cancel", "17"]);
  });

  test("exit 1 maps to ok false with the message", async () => {
    const run: CliRunner = async () => ({ code: 1, stdout: "", stderr: "status is expired." });
    await expect(createQueueClient(CFG, run).cancel(17)).resolves.toEqual({
      ok: false, message: "status is expired.",
    });
  });
});
