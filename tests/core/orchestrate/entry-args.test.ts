import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildDryRunRows,
  ENTRY_USAGE,
  formatDryRunTable,
  resolveEntryArgs,
} from "../../../src/core/orchestrate/entry-args";
import type { OrchestratorConfig } from "../../../src/core/orchestrate/config";

describe("resolveEntryArgs: --config", () => {
  test("is required — missing entirely is a usage error naming --config", () => {
    const res = resolveEntryArgs([]);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("expected error");
    expect(res.errors.join("\n")).toContain("--config");
  });

  test("needs a value — trailing flag with nothing after it errors naming --config", () => {
    const res = resolveEntryArgs(["--config"]);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("expected error");
    expect(res.errors.join("\n")).toContain("--config needs a value");
  });

  test("a bare --config <path> resolves with defaults for everything else", () => {
    const res = resolveEntryArgs(["--config", join("C:", "orch", "orchestrator.config.json")]);
    expect(res.kind).toBe("config");
    if (res.kind !== "config") throw new Error("expected config");
    expect(res.config.configPath).toBe(join("C:", "orch", "orchestrator.config.json"));
    expect(res.config.statePath).toBe(join("C:", "orch", "orchestrator.state.json"));
    expect(res.config.shutdownGraceMs).toBe(30_000);
    expect(res.config.dryRun).toBe(false);
  });
});

describe("resolveEntryArgs: --state", () => {
  test("defaults beside the config file (same dir, orchestrator.state.json)", () => {
    const res = resolveEntryArgs(["--config", join("srv", "cfg", "orchestrator.config.json")]);
    expect(res.kind).toBe("config");
    if (res.kind !== "config") throw new Error("expected config");
    expect(res.config.statePath).toBe(join("srv", "cfg", "orchestrator.state.json"));
  });

  test("an explicit --state overrides the default", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--state", join("var", "orch.state.json")]);
    expect(res.kind).toBe("config");
    if (res.kind !== "config") throw new Error("expected config");
    expect(res.config.statePath).toBe(join("var", "orch.state.json"));
  });

  test("needs a value — trailing flag errors naming --state", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--state"]);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("expected error");
    expect(res.errors.join("\n")).toContain("--state needs a value");
  });
});

describe("resolveEntryArgs: --shutdown-grace", () => {
  test("defaults to 30s (30000ms) when absent", () => {
    const res = resolveEntryArgs(["--config", "cfg.json"]);
    expect(res.kind).toBe("config");
    if (res.kind !== "config") throw new Error("expected config");
    expect(res.config.shutdownGraceMs).toBe(30_000);
  });

  test("an explicit value is converted from seconds to milliseconds", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--shutdown-grace", "45"]);
    expect(res.kind).toBe("config");
    if (res.kind !== "config") throw new Error("expected config");
    expect(res.config.shutdownGraceMs).toBe(45_000);
  });

  test("zero is a valid (immediate-shutdown) value", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--shutdown-grace", "0"]);
    expect(res.kind).toBe("config");
    if (res.kind !== "config") throw new Error("expected config");
    expect(res.config.shutdownGraceMs).toBe(0);
  });

  test("a negative value is a usage error naming --shutdown-grace", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--shutdown-grace", "-5"]);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("expected error");
    expect(res.errors.join("\n")).toContain("--shutdown-grace");
  });

  test("a non-numeric value is a usage error naming --shutdown-grace", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--shutdown-grace", "soon"]);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("expected error");
    expect(res.errors.join("\n")).toContain("--shutdown-grace");
  });

  test("a non-integer value is a usage error naming --shutdown-grace", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--shutdown-grace", "1.5"]);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("expected error");
    expect(res.errors.join("\n")).toContain("--shutdown-grace");
  });

  test("2147483 seconds is the accepted boundary (32-bit signed setTimeout ms limit)", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--shutdown-grace", "2147483"]);
    expect(res.kind).toBe("config");
    if (res.kind !== "config") throw new Error("expected config");
    expect(res.config.shutdownGraceMs).toBe(2_147_483_000);
  });

  test("a value past the boundary (2147484 seconds) is a usage error naming --shutdown-grace, not silently accepted and later clamped by the platform", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--shutdown-grace", "2147484"]);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("expected error");
    expect(res.errors.join("\n")).toContain("--shutdown-grace");
  });

  test("shutdownGraceExplicit is false when the flag is absent (default applied)", () => {
    const res = resolveEntryArgs(["--config", "cfg.json"]);
    expect(res.kind).toBe("config");
    if (res.kind !== "config") throw new Error("expected config");
    expect(res.config.shutdownGraceExplicit).toBe(false);
  });

  test("shutdownGraceExplicit is true when the flag is passed, even with the default's own value", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--shutdown-grace", "30"]);
    expect(res.kind).toBe("config");
    if (res.kind !== "config") throw new Error("expected config");
    expect(res.config.shutdownGraceExplicit).toBe(true);
    expect(res.config.shutdownGraceMs).toBe(30_000);
  });
});

describe("resolveEntryArgs: --dry-run", () => {
  test("off by default", () => {
    const res = resolveEntryArgs(["--config", "cfg.json"]);
    expect(res.kind).toBe("config");
    if (res.kind !== "config") throw new Error("expected config");
    expect(res.config.dryRun).toBe(false);
  });

  test("sets dryRun true", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--dry-run"]);
    expect(res.kind).toBe("config");
    if (res.kind !== "config") throw new Error("expected config");
    expect(res.config.dryRun).toBe(true);
  });
});

describe("resolveEntryArgs: --help", () => {
  test("-h short form returns kind help, no --config required", () => {
    expect(resolveEntryArgs(["-h"])).toEqual({ kind: "help" });
  });

  test("--help long form returns kind help even with other args present", () => {
    expect(resolveEntryArgs(["--config", "cfg.json", "--help"])).toEqual({ kind: "help" });
  });

  test("ENTRY_USAGE documents every flag", () => {
    expect(ENTRY_USAGE).toContain("--config");
    expect(ENTRY_USAGE).toContain("--state");
    expect(ENTRY_USAGE).toContain("--shutdown-grace");
    expect(ENTRY_USAGE).toContain("--dry-run");
  });
});

describe("resolveEntryArgs: unknown / malformed input", () => {
  test("an unrecognized flag is a usage error naming it", () => {
    const res = resolveEntryArgs(["--config", "cfg.json", "--bogus", "x"]);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("expected error");
    expect(res.errors.join("\n")).toContain("--bogus");
  });

  test("multiple problems are all reported, not just the first", () => {
    const res = resolveEntryArgs(["--shutdown-grace", "not-a-number", "--bogus"]);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("expected error");
    const joined = res.errors.join("\n");
    expect(joined).toContain("--config");
    expect(joined).toContain("--shutdown-grace");
    expect(joined).toContain("--bogus");
  });
});

// ---- dry-run schedule table ----

function cfgWithJobs(...schedules: Array<{ name: string; schedule: string }>): OrchestratorConfig {
  return {
    jobs: schedules.map((s) => ({
      name: s.name,
      schedule: s.schedule,
      command: "bun",
      args: ["toy.ts"],
      env: {},
      jitterMinutes: 0,
      timeoutMinutes: 30,
    })),
  };
}

// 2026-01-01 00:00:00 local — arbitrary fixed anchor, minute-aligned (mirrors scheduler.test.ts's T0).
const T0 = new Date(2026, 0, 1, 0, 0, 0, 0);

describe("buildDryRunRows", () => {
  test("computes exactly the next 3 fire times per job via nextRun (no jitter applied)", () => {
    const cfg = cfgWithJobs({ name: "a", schedule: "*/5 * * * *" });
    const rows = buildDryRunRows(cfg, T0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("a");
    expect(rows[0]?.schedule).toBe("*/5 * * * *");
    expect(rows[0]?.nextRuns).toHaveLength(3);
    expect(rows[0]?.nextRuns.map((d) => d.getTime())).toEqual([
      T0.getTime() + 5 * 60_000,
      T0.getTime() + 10 * 60_000,
      T0.getTime() + 15 * 60_000,
    ]);
    expect(rows[0]?.error).toBeUndefined();
  });

  test("one row per job, in config order", () => {
    const cfg = cfgWithJobs({ name: "a", schedule: "0 2 * * *" }, { name: "b", schedule: "0 3 * * *" });
    const rows = buildDryRunRows(cfg, T0);
    expect(rows.map((r) => r.name)).toEqual(["a", "b"]);
  });

  test("an unsatisfiable schedule (Feb 31st) reports an error instead of throwing", () => {
    const cfg = cfgWithJobs({ name: "impossible", schedule: "0 0 31 2 *" });
    const rows = buildDryRunRows(cfg, T0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nextRuns).toHaveLength(0);
    expect(rows[0]?.error).toBeDefined();
    expect(rows[0]?.error).toContain("unsatisfiable");
  });

  test("empty jobs list produces an empty row list", () => {
    expect(buildDryRunRows({ jobs: [] }, T0)).toEqual([]);
  });
});

describe("formatDryRunTable", () => {
  test("includes each job's name, schedule, and all 3 fire times", () => {
    const cfg = cfgWithJobs({ name: "nightly", schedule: "30 2 * * *" });
    const table = formatDryRunTable(buildDryRunRows(cfg, T0));
    expect(table).toContain("nightly");
    expect(table).toContain("30 2 * * *");
  });

  test("reports a no-jobs config distinctly rather than an empty table", () => {
    const table = formatDryRunTable(buildDryRunRows({ jobs: [] }, T0));
    expect(table.toLowerCase()).toContain("no jobs");
  });

  test("surfaces a per-job error inline instead of omitting the row", () => {
    const cfg = cfgWithJobs({ name: "impossible", schedule: "0 0 31 2 *" });
    const table = formatDryRunTable(buildDryRunRows(cfg, T0));
    expect(table).toContain("impossible");
    expect(table.toLowerCase()).toContain("error");
  });
});
