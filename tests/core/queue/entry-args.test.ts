import { describe, expect, test } from "bun:test";
import { resolveEntryArgs, ENTRY_USAGE } from "../../../src/core/queue/entry-args";

const HOSTNAME = () => "test-host";
const ENV = { AL_PERF_CLI: "" as string | undefined };

describe("resolveEntryArgs: splitting own flags from forwarded rest", () => {
  test("own flags interspersed with ship flags in any order split cleanly", () => {
    const r = resolveEntryArgs(
      ["--server", "http://bc", "--al-perf-cli", "bun run x", "--instance", "BC", "--max", "3"],
      {},
      HOSTNAME,
    );
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.cliPrefix).toEqual(["bun", "run", "x"]);
    expect(r.config.max).toBe(3);
    expect(r.config.rest).toEqual(["--server", "http://bc", "--instance", "BC"]);
  });

  test("unknown/ship-owned flags (and their values) land in rest untouched, in order", () => {
    const r = resolveEntryArgs(
      ["--al-perf-cli", "cli", "--totally-unknown", "value", "--dry-run", "--allow-dry-run-claims"],
      {},
      HOSTNAME,
    );
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.rest).toEqual(["--totally-unknown", "value", "--dry-run"]);
  });

  test("own boolean flags (--keep-claim-on-failure) are consumed, not forwarded", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "cli", "--keep-claim-on-failure", "--server", "x"], {}, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.keepClaimOnFailure).toBe(true);
    expect(r.config.rest).toEqual(["--server", "x"]);
  });
});

describe("resolveEntryArgs: --al-perf-cli / AL_PERF_CLI", () => {
  test("env AL_PERF_CLI is honored when the flag is absent", () => {
    const r = resolveEntryArgs([], { AL_PERF_CLI: "bun run from-env.ts" }, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.cliPrefix).toEqual(["bun", "run", "from-env.ts"]);
  });

  test("the flag overrides the env var when both are present", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "flag-cli"], { AL_PERF_CLI: "env-cli" }, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.cliPrefix).toEqual(["flag-cli"]);
  });

  test("missing both the flag and the env var is a usage error naming --al-perf-cli", () => {
    const r = resolveEntryArgs([], {}, HOSTNAME);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    const text = r.errors.join("\n");
    expect(text).toContain("--al-perf-cli");
    expect(text).toContain("AL_PERF_CLI");
  });
});

describe("resolveEntryArgs: --max validation", () => {
  test("defaults to 1 when absent", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "cli"], {}, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.max).toBe(1);
  });

  for (const bad of ["abc", "0", "-1", "1.5"]) {
    test(`--max ${bad} is a usage error`, () => {
      const r = resolveEntryArgs(["--al-perf-cli", "cli", "--max", bad], {}, HOSTNAME);
      expect(r.kind).toBe("error");
      if (r.kind !== "error") return;
      expect(r.errors.join("\n")).toContain("--max");
    });
  }

  test("a valid positive integer is accepted", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "cli", "--max", "7"], {}, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.max).toBe(7);
  });
});

describe("resolveEntryArgs: --al-perf-cli whitespace-splitting", () => {
  test("splits a multi-word cli prefix on whitespace", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "bun run src/cli/index.ts"], {}, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.cliPrefix).toEqual(["bun", "run", "src/cli/index.ts"]);
  });

  test("collapses repeated internal whitespace and trims", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "  bun   run  x  "], {}, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.cliPrefix).toEqual(["bun", "run", "x"]);
  });

  test("a single-token cli (e.g. an installed binary) is a one-element prefix", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "al-profile"], {}, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.cliPrefix).toEqual(["al-profile"]);
  });
});

describe("resolveEntryArgs: defaults and passthrough own flags", () => {
  test("executor defaults to the injected hostname when --executor is absent", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "cli"], {}, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.executor).toBe("test-host");
  });

  test("--executor overrides the hostname default", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "cli", "--executor", "worker-7"], {}, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.executor).toBe("worker-7");
  });

  test("--queue-db, --queue-tenant, --workload-cmd are undefined unless given, and never forwarded", () => {
    const r1 = resolveEntryArgs(["--al-perf-cli", "cli"], {}, HOSTNAME);
    expect(r1.kind).toBe("config");
    if (r1.kind !== "config") return;
    expect(r1.config.queueDbPath).toBeUndefined();
    expect(r1.config.queueTenant).toBeUndefined();
    expect(r1.config.workloadCmd).toBeUndefined();

    const r2 = resolveEntryArgs(
      ["--al-perf-cli", "cli", "--queue-db", "/tmp/lifecycle.db", "--queue-tenant", "contoso", "--workload-cmd", "run.exe --flag"],
      {},
      HOSTNAME,
    );
    expect(r2.kind).toBe("config");
    if (r2.kind !== "config") return;
    expect(r2.config.queueDbPath).toBe("/tmp/lifecycle.db");
    expect(r2.config.queueTenant).toBe("contoso");
    expect(r2.config.workloadCmd).toBe("run.exe --flag");
    expect(r2.config.rest).toEqual([]);
  });

  test("keepClaimOnFailure defaults to false", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "cli"], {}, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.keepClaimOnFailure).toBe(false);
  });

  test("an own value-flag missing its value is a usage error", () => {
    const r = resolveEntryArgs(["--al-perf-cli"], {}, HOSTNAME);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.errors.join("\n")).toContain("--al-perf-cli needs a value");
  });
});

describe("resolveEntryArgs: --help", () => {
  test("-h / --help win over everything else, including invalid own flags", () => {
    expect(resolveEntryArgs(["--help"], {}, HOSTNAME).kind).toBe("help");
    expect(resolveEntryArgs(["-h", "--max", "bogus"], {}, HOSTNAME).kind).toBe("help");
    expect(resolveEntryArgs(["--al-perf-cli", "cli", "--help"], {}, HOSTNAME).kind).toBe("help");
  });

  test("ENTRY_USAGE documents the own flags", () => {
    expect(ENTRY_USAGE).toContain("--al-perf-cli");
    expect(ENTRY_USAGE).toContain("--max");
    expect(ENTRY_USAGE).toContain("--executor");
    expect(ENTRY_USAGE).toContain("--queue-tenant");
    expect(ENTRY_USAGE).toContain("--keep-claim-on-failure");
    expect(ENTRY_USAGE).toContain("--workload-cmd");
    expect(ENTRY_USAGE).toContain("--allow-dry-run-claims");
  });
});

describe("resolveEntryArgs: --dry-run gating (queue-claiming safety)", () => {
  test("a forwarded --dry-run without --allow-dry-run-claims is a usage error", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "cli", "--dry-run"], {}, HOSTNAME);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    const text = r.errors.join("\n");
    expect(text).toContain("--dry-run");
    expect(text).toContain("--allow-dry-run-claims");
    expect(text.toLowerCase()).toContain("claim");
  });

  test("--dry-run with --allow-dry-run-claims is accepted; the allow flag is consumed, not forwarded", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "cli", "--dry-run", "--allow-dry-run-claims"], {}, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.rest).toEqual(["--dry-run"]);
  });

  test("no --dry-run at all is unaffected by --allow-dry-run-claims being absent", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "cli", "--server", "x"], {}, HOSTNAME);
    expect(r.kind).toBe("config");
  });

  test("--allow-dry-run-claims with no --dry-run is accepted (and is not forwarded either)", () => {
    const r = resolveEntryArgs(["--al-perf-cli", "cli", "--allow-dry-run-claims"], {}, HOSTNAME);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.rest).toEqual([]);
  });
});
