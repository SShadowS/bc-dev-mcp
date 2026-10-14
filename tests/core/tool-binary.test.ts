import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERTER_TOOL, createToolResolver, type ToolDescriptor, type ToolResolverDeps } from "../../src/core/tool-binary";

const BYTES = new TextEncoder().encode("fake converter");
const desc: ToolDescriptor = {
  ...CONVERTER_TOOL,
  pin: { version: "0.2.0", assets: { "linux-x64": { name: "bc-mdc-converter-linux-x64", sha256: createHash("sha256").update(BYTES).digest("hex"), size: BYTES.byteLength } } },
};
function deps(over: Partial<ToolResolverDeps> & { onPath?: string; status?: number } = {}): ToolResolverDeps & { fetches: string[] } {
  const fetches: string[] = [];
  return {
    env: { BC_DEV_CACHE_DIR: mkdtempSync(join(tmpdir(), "bcmcp-conv-")) },
    platform: "linux", arch: "x64", now: () => 0, log: () => {},
    versionOf: async () => over.onPath,
    fetchFn: (async (url: string) => { fetches.push(url); return new Response(BYTES.slice(), { status: over.status ?? 200 }); }) as unknown as typeof fetch,
    fetches,
    ...over,
  };
}

describe("converter resolution", () => {
  test("downloads the pinned asset from the converter repo into its own cache folder", async () => {
    const d = deps();
    const r = await createToolResolver(desc, d).resolve();
    expect(r).toMatchObject({ source: "download", version: "0.2.0" });
    expect(r.path).toContain(join("bc-mdc-converter", "0.2.0", "bc-mdc-converter"));
    expect(d.fetches).toEqual(["https://github.com/SShadowS/bc-mdc-converter/releases/download/v0.2.0/bc-mdc-converter-linux-x64"]);
  });
  test("unavailable means no binary at all (no bare-command fallback), unlike al-sem", async () => {
    const r = await createToolResolver(desc, deps({ status: 404 })).resolve();
    expect(r).toMatchObject({ source: "unavailable", path: null });
    expect(r.reason).toContain("HTTP 404");
  });
  test("BC_MDC_CONVERTER is used as-is; BC_MDC_CONVERTER_DOWNLOAD=0 never downloads", async () => {
    const d = deps();
    expect((await createToolResolver(desc, { ...d, env: { ...d.env, BC_MDC_CONVERTER: "C:/x/conv.exe" } }).resolve()).path).toBe("C:/x/conv.exe");
    const off = deps({ onPath: "0.1.0" });
    const r = await createToolResolver(desc, { ...off, env: { ...off.env, BC_MDC_CONVERTER_DOWNLOAD: "0" } }).resolve();
    expect(r).toMatchObject({ source: "unavailable", path: null });
    expect(off.fetches).toEqual([]);
  });
  test("PATH copy at or above the pin is used; 0.1.0 on PATH falls through to the download", async () => {
    expect((await createToolResolver(desc, deps({ onPath: "0.2.3" })).resolve()).source).toBe("path");
    expect((await createToolResolver(desc, deps({ onPath: "0.1.0" })).resolve()).source).toBe("download");
  });
});
