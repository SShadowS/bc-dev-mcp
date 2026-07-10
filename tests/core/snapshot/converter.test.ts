// tests/core/snapshot/converter.test.ts
import { describe, expect, test } from "bun:test";
import { resolveConverter, convertMdcZip } from "../../../src/core/snapshot/converter";

const fakeExists = (present: Set<string>) => (p: string) => present.has(p.replace(/\\/g, "/"));

describe("resolveConverter", () => {
  test("BC_MDC_CONVERTER env var wins when the file exists", () => {
    const present = new Set(["/opt/bc-mdc-converter"]);
    const result = resolveConverter({
      env: { BC_MDC_CONVERTER: "/opt/bc-mdc-converter", PATH: "/usr/bin" },
      existsFn: fakeExists(present),
      platform: "linux",
    });
    expect(result).toEqual({ converterPath: "/opt/bc-mdc-converter" });
  });

  test("BC_MDC_CONVERTER pointing at a missing file resolves null (no silent PATH fallback)", () => {
    const present = new Set(["/usr/bin/bc-mdc-converter"]);
    const result = resolveConverter({
      env: { BC_MDC_CONVERTER: "/gone/bc-mdc-converter", PATH: "/usr/bin" },
      existsFn: fakeExists(present),
      platform: "linux",
    });
    expect(result).toBeNull();
  });

  test("PATH scan finds bc-mdc-converter.exe on win32 (';' delimiter)", () => {
    const present = new Set(["C:/tools/bc-mdc-converter.exe"]);
    const result = resolveConverter({
      env: { PATH: "C:\\nothing;C:\\tools" },
      existsFn: fakeExists(present),
      platform: "win32",
    });
    expect(result?.converterPath.replace(/\\/g, "/")).toBe("C:/tools/bc-mdc-converter.exe");
  });

  test("PATH scan finds bc-mdc-converter (no .exe) on linux (':' delimiter)", () => {
    const present = new Set(["/usr/local/bin/bc-mdc-converter"]);
    const result = resolveConverter({
      env: { PATH: "/usr/bin:/usr/local/bin" },
      existsFn: fakeExists(present),
      platform: "linux",
    });
    expect(result?.converterPath.replace(/\\/g, "/")).toBe("/usr/local/bin/bc-mdc-converter");
  });

  test("returns null when neither env var nor PATH yields a binary", () => {
    expect(resolveConverter({ env: { PATH: "/usr/bin" }, existsFn: () => false, platform: "linux" })).toBeNull();
    expect(resolveConverter({ env: {}, existsFn: () => false, platform: "win32" })).toBeNull();
  });
});

describe("convertMdcZip", () => {
  test("invokes <converter> <zip> <out> --format v8 and maps success", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const ok = await convertMdcZip({ converterPath: "/conv" }, "/in.zip", "/out.alcpuprofile", async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stderr: "" };
    });
    expect(ok).toEqual({ ok: true, profilePath: "/out.alcpuprofile" });
    expect(calls).toEqual([{ cmd: "/conv", args: ["/in.zip", "/out.alcpuprofile", "--format", "v8"] }]);
  });

  test("maps runner failure to the stderr message, falling back to the exit code", async () => {
    const bad = await convertMdcZip({ converterPath: "/conv" }, "/in.zip", "/out", async () => ({ code: 1, stderr: "boom" }));
    expect(bad).toEqual({ ok: false, error: "boom" });
    const silent = await convertMdcZip({ converterPath: "/conv" }, "/in.zip", "/out", async () => ({ code: 2, stderr: "" }));
    expect(silent).toEqual({ ok: false, error: "converter exited 2" });
  });
});
