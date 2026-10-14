import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnapshotJsonWith } from "../../../src/core/snapshot/run-converter";

const script = join(import.meta.dir, "../../fixtures/snapshot-debug/fake-converter.ts");
const run = (opts: Partial<{ timeoutMs: number; jsonBytes: number; stderrBytes: number }> = {}) =>
  runSnapshotJsonWith({ timeoutMs: 10_000, jsonBytes: 1024, stderrBytes: 4096, ...opts, argsPrefix: [script] });
const zip = () => join(mkdtempSync(join(tmpdir(), "bcconv-")), "in.zip");
const tempJsonOf = (zipPath: string) => readFileSync(`${zipPath}.out`, "utf8");

describe("runSnapshotJson", () => {
  afterEach(() => { delete process.env["FAKE_MODE"]; });

  test("success parses the JSON and deletes the temp file", async () => {
    process.env["FAKE_MODE"] = "ok";
    const z = zip();
    const r = await run()(process.execPath, z);
    expect(r).toEqual({ ok: true, json: { format: "bc-mdc-snapshot", schemaVersion: 1, methods: [], sources: [] } });
    expect(tempJsonOf(z)).toContain("bc-dev-mcp-snapshot-");
    expect(existsSync(tempJsonOf(z))).toBe(false);
  });

  test("non-zero exit: one line, at most 300 chars, never the raw stderr", async () => {
    process.env["FAKE_MODE"] = "fail";
    const r = await run()(process.execPath, zip());
    expect(r.ok).toBe(false);
    const error = (r as { error: string }).error;
    expect(error).toStartWith("bc-mdc-converter failed (exit 3): error: entry 7.mdc is corrupt");
    expect(error).not.toContain("\n");
    expect(error).not.toContain("SSSS");
    expect(error.length).toBeLessThanOrEqual(360);
  });

  test("a converter past the timeout is killed", async () => {
    process.env["FAKE_MODE"] = "sleep";
    const z = zip();
    const t0 = Date.now();
    const r = await run({ timeoutMs: 200 })(process.execPath, z);
    expect(r).toEqual({ ok: false, error: "bc-mdc-converter did not finish within 0.2 s" });
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  test("JSON output above the limit fails and the temp file is still deleted", async () => {
    process.env["FAKE_MODE"] = "big";
    const z = zip();
    const r = await run({ jsonBytes: 1024 })(process.execPath, z);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("over the 1024-byte limit");
    expect(existsSync(tempJsonOf(z))).toBe(false);
  });
});
