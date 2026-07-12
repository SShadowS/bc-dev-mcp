import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrchestratorConfig, parseOrchestratorConfig } from "../../../src/core/orchestrate/config";

function validJob(over: Record<string, unknown> = {}) {
  return {
    name: "nightly-capture",
    schedule: "30 2 * * *",
    command: "bun",
    args: ["scripts/capture-and-ship.ts", "--server", "http://bc-prod"],
    env: { BC_DEV_USER: "svc" },
    jitterMinutes: 10,
    timeoutMinutes: 30,
    retry: { attempts: 2, delayMinutes: 5 },
    ...over,
  };
}

describe("parseOrchestratorConfig: valid config", () => {
  test("the D1 example config loads with every field intact", () => {
    const cfg = parseOrchestratorConfig({ jobs: [validJob()] });
    expect(cfg.jobs).toHaveLength(1);
    expect(cfg.jobs[0]).toEqual({
      name: "nightly-capture",
      schedule: "30 2 * * *",
      command: "bun",
      args: ["scripts/capture-and-ship.ts", "--server", "http://bc-prod"],
      env: { BC_DEV_USER: "svc" },
      jitterMinutes: 10,
      timeoutMinutes: 30,
      retry: { attempts: 2, delayMinutes: 5 },
    });
  });

  test("an empty jobs list is valid", () => {
    expect(parseOrchestratorConfig({ jobs: [] })).toEqual({ jobs: [] });
  });

  test("multiple distinct jobs all load", () => {
    const cfg = parseOrchestratorConfig({
      jobs: [validJob({ name: "a" }), validJob({ name: "b" })],
    });
    expect(cfg.jobs.map((j) => j.name)).toEqual(["a", "b"]);
  });
});

describe("parseOrchestratorConfig: defaults", () => {
  test("jitterMinutes defaults to 0 when absent", () => {
    const cfg = parseOrchestratorConfig({
      jobs: [validJob({ jitterMinutes: undefined })],
    });
    expect(cfg.jobs[0]?.jitterMinutes).toBe(0);
  });

  test("timeoutMinutes defaults to 60 when absent", () => {
    const cfg = parseOrchestratorConfig({
      jobs: [validJob({ timeoutMinutes: undefined })],
    });
    expect(cfg.jobs[0]?.timeoutMinutes).toBe(60);
  });

  test("retry defaults to undefined (no retry) when absent", () => {
    const cfg = parseOrchestratorConfig({
      jobs: [validJob({ retry: undefined })],
    });
    expect(cfg.jobs[0]?.retry).toBeUndefined();
  });

  test("args defaults to an empty array when absent", () => {
    const cfg = parseOrchestratorConfig({
      jobs: [validJob({ args: undefined })],
    });
    expect(cfg.jobs[0]?.args).toEqual([]);
  });

  test("env defaults to an empty object when absent", () => {
    const cfg = parseOrchestratorConfig({
      jobs: [validJob({ env: undefined })],
    });
    expect(cfg.jobs[0]?.env).toEqual({});
  });
});

describe("parseOrchestratorConfig: unknown keys are ignored", () => {
  test("unrecognized top-level and job keys do not throw and are dropped", () => {
    const cfg = parseOrchestratorConfig({
      jobs: [validJob({ totallyUnknown: "value", nested: { a: 1 } })],
      alsoUnknown: true,
    });
    expect(cfg.jobs).toHaveLength(1);
    expect("totallyUnknown" in (cfg.jobs[0] as object)).toBe(false);
  });
});

describe("parseOrchestratorConfig: duplicate names", () => {
  test("two jobs with the same name throw, naming the duplicate", () => {
    expect(() =>
      parseOrchestratorConfig({ jobs: [validJob({ name: "dup" }), validJob({ name: "dup" })] }),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseOrchestratorConfig({ jobs: [validJob({ name: "dup" }), validJob({ name: "dup" })] }),
    ).toThrow(/dup/);
  });
});

describe("parseOrchestratorConfig: structural failures", () => {
  test("a non-object top level throws", () => {
    expect(() => parseOrchestratorConfig("nope")).toThrow();
    expect(() => parseOrchestratorConfig(null)).toThrow();
    expect(() => parseOrchestratorConfig([])).toThrow();
  });

  test("missing 'jobs' throws", () => {
    expect(() => parseOrchestratorConfig({})).toThrow(/jobs/i);
  });

  test("'jobs' not an array throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: {} })).toThrow(/jobs/i);
  });

  test("a job entry that is not an object throws, naming its index", () => {
    expect(() => parseOrchestratorConfig({ jobs: ["nope"] })).toThrow(/job\[0\]/);
  });
});

describe("parseOrchestratorConfig: name validation", () => {
  test("missing name throws, naming the job by index", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ name: undefined })] })).toThrow(/job\[0\]/);
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ name: undefined })] })).toThrow(/name/i);
  });

  test("an empty-string name throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ name: "" })] })).toThrow(/name/i);
  });

  test("a non-string name throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ name: 42 })] })).toThrow(/name/i);
  });
});

describe("parseOrchestratorConfig: schedule validation", () => {
  test("missing schedule throws, naming the job and the field", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ schedule: undefined })] })).toThrow(/nightly-capture/);
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ schedule: undefined })] })).toThrow(/schedule/i);
  });

  test("an invalid cron expression throws, wrapping the cron parser's own error", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ schedule: "0 0 * * * *" })] })).toThrow(/schedule/i);
  });
});

describe("parseOrchestratorConfig: command / args validation", () => {
  test("missing command throws, naming job and field", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ command: undefined })] })).toThrow(/nightly-capture/);
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ command: undefined })] })).toThrow(/command/i);
  });

  test("an empty-string command throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ command: "" })] })).toThrow(/command/i);
  });

  test("args not an array throws, naming job and field", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ args: "not-an-array" })] })).toThrow(/nightly-capture/);
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ args: "not-an-array" })] })).toThrow(/args/i);
  });

  test("args containing a non-string element throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ args: ["ok", 5] })] })).toThrow(/args/i);
  });
});

describe("parseOrchestratorConfig: env validation", () => {
  test("env not an object (a string map expected) throws, naming job and field", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ env: "nope" })] })).toThrow(/nightly-capture/);
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ env: "nope" })] })).toThrow(/env/i);
  });

  test("env not an object (an array) throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ env: ["a", "b"] })] })).toThrow(/env/i);
  });

  test("a non-string env value throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ env: { BC_DEV_USER: 5 } })] })).toThrow(/env/i);
  });

  test("an env key that fails ^[A-Za-z_][A-Za-z0-9_]*$ throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ env: { "bad-key": "x" } })] })).toThrow(/env/i);
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ env: { "1LEADING": "x" } })] })).toThrow(/env/i);
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ env: { "has space": "x" } })] })).toThrow(/env/i);
  });

  test("valid env keys (letters, digits, underscore, not leading digit) are accepted", () => {
    const cfg = parseOrchestratorConfig({
      jobs: [validJob({ env: { _OK: "1", OK_2: "2", ALLCAPS: "3" } })],
    });
    expect(cfg.jobs[0]?.env).toEqual({ _OK: "1", OK_2: "2", ALLCAPS: "3" });
  });
});

describe("parseOrchestratorConfig: numeric validation (negative numerics, quoted-number traps)", () => {
  test("a negative jitterMinutes throws, naming job and field", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ jitterMinutes: -1 })] })).toThrow(/nightly-capture/);
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ jitterMinutes: -1 })] })).toThrow(/jitterMinutes/);
  });

  test("a negative timeoutMinutes throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ timeoutMinutes: -5 })] })).toThrow(/timeoutMinutes/);
  });

  test("jitterMinutes given as a quoted number (string) throws rather than silently coercing", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ jitterMinutes: "10" })] })).toThrow(/jitterMinutes/);
  });

  test("timeoutMinutes given as a quoted number (string) throws rather than silently coercing", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ timeoutMinutes: "30" })] })).toThrow(/timeoutMinutes/);
  });

  test("zero is a valid jitterMinutes/timeoutMinutes (boundary, not negative)", () => {
    const cfg = parseOrchestratorConfig({ jobs: [validJob({ jitterMinutes: 0, timeoutMinutes: 0 })] });
    expect(cfg.jobs[0]?.jitterMinutes).toBe(0);
    expect(cfg.jobs[0]?.timeoutMinutes).toBe(0);
  });
});

describe("parseOrchestratorConfig: retry validation", () => {
  test("retry not an object throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ retry: "nope" })] })).toThrow(/retry/i);
  });

  test("retry.attempts negative throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ retry: { attempts: -1, delayMinutes: 5 } })] })).toThrow(
      /retry\.attempts/,
    );
  });

  test("retry.attempts given as a quoted number throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ retry: { attempts: "2", delayMinutes: 5 } })] })).toThrow(
      /retry\.attempts/,
    );
  });

  test("retry.delayMinutes negative throws", () => {
    expect(() =>
      parseOrchestratorConfig({ jobs: [validJob({ retry: { attempts: 2, delayMinutes: -5 } })] }),
    ).toThrow(/retry\.delayMinutes/);
  });

  test("retry.attempts non-integer throws", () => {
    expect(() => parseOrchestratorConfig({ jobs: [validJob({ retry: { attempts: 1.5, delayMinutes: 5 } })] })).toThrow(
      /retry\.attempts/,
    );
  });

  test("retry with attempts=0 is valid (present but no extra tries)", () => {
    const cfg = parseOrchestratorConfig({ jobs: [validJob({ retry: { attempts: 0, delayMinutes: 5 } })] });
    expect(cfg.jobs[0]?.retry).toEqual({ attempts: 0, delayMinutes: 5 });
  });
});

describe("loadOrchestratorConfig: file loading (fail-closed)", () => {
  function tmpConfigFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "bcmcp-orch-"));
    const file = join(dir, "orchestrator.config.json");
    writeFileSync(file, content);
    return file;
  }

  test("a valid config file on disk loads correctly", () => {
    const file = tmpConfigFile(JSON.stringify({ jobs: [validJob()] }));
    const cfg = loadOrchestratorConfig(file);
    expect(cfg.jobs).toHaveLength(1);
    expect(cfg.jobs[0]?.name).toBe("nightly-capture");
  });

  test("a nonexistent path throws, naming the path", () => {
    expect(() => loadOrchestratorConfig(join(tmpdir(), "does-not-exist-12345.json"))).toThrow(
      /does-not-exist-12345\.json/,
    );
  });

  test("invalid JSON throws, naming the path", () => {
    const file = tmpConfigFile("{ not valid json");
    expect(() => loadOrchestratorConfig(file)).toThrow(/orchestrator\.config\.json/);
  });

  test("a structurally invalid config on disk still throws with the same field-naming errors", () => {
    const file = tmpConfigFile(JSON.stringify({ jobs: [validJob({ command: undefined })] }));
    expect(() => loadOrchestratorConfig(file)).toThrow(/command/i);
  });
});
