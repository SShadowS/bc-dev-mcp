import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlSemResolver, satisfiesPin, type AlSemResolverDeps } from "../../src/core/alsem-binary";
import type { AlSemPin } from "../../src/core/alsem-pin";

const BYTES = new TextEncoder().encode("fake alsem binary");
const pin: AlSemPin = {
  version: "1.7.1",
  assets: { "linux-x64": { name: "alsem-linux-x64", sha256: createHash("sha256").update(BYTES).digest("hex"), size: BYTES.byteLength } },
};
const binPath = (cache: string) => join(cache, "alsem", "1.7.1", "alsem");

function setup(over: Partial<AlSemResolverDeps> & { onPath?: string; body?: Uint8Array; status?: number } = {}) {
  const cache = mkdtempSync(join(tmpdir(), "bcmcp-alsem-"));
  const fetches: string[] = [];
  const logs: string[] = [];
  let clock = 0;
  const deps: AlSemResolverDeps = {
    env: { BC_DEV_CACHE_DIR: cache },
    platform: "linux",
    arch: "x64",
    fetchFn: (async (url: string) => {
      fetches.push(url);
      return new Response((over.body ?? BYTES).slice(), { status: over.status ?? 200 });
    }) as unknown as typeof fetch,
    versionOf: async () => over.onPath,
    log: (m) => logs.push(m),
    now: () => clock,
    pin,
    ...over,
  };
  return { cache, fetches, logs, deps, tick: (ms: number) => (clock += ms) };
}

describe("al-sem resolution", () => {
  test("BC_DEV_ALSEM wins and is used as-is (no probe, no download)", async () => {
    const s = setup({ onPath: "1.7.1" });
    const r = await createAlSemResolver({ ...s.deps, env: { ...s.deps.env, BC_DEV_ALSEM: "C:/tools/alsem.exe" } }).resolve();
    expect(r).toEqual({ source: "env", path: "C:/tools/alsem.exe" });
    expect(s.fetches).toEqual([]);
  });

  test("PATH alsem at or above the pin is used; below the pin or another major is skipped", async () => {
    for (const v of ["1.7.1", "1.8.0"]) expect((await createAlSemResolver(setup({ onPath: v }).deps).resolve()).source).toBe("path");
    for (const v of ["1.6.0", "1.7.0", "2.0.0"]) {
      const s = setup({ onPath: v });
      const r = await createAlSemResolver(s.deps).resolve();
      expect(r).toMatchObject({ source: "download", path: binPath(s.cache), version: "1.7.1" });
      expect(r.reason).toContain(`alsem ${v} on PATH`);
    }
  });

  test("downloads the pinned asset once, verified, then serves the cache without network", async () => {
    const s = setup();
    const resolver = createAlSemResolver(s.deps);
    const [a, b] = await Promise.all([resolver.binary(), resolver.binary()]);
    expect(a).toBe(binPath(s.cache));
    expect(b).toBe(a);
    expect(s.fetches).toEqual(["https://github.com/SShadowS/al-sem/releases/download/v1.7.1/alsem-linux-x64"]);
    expect(readFileSync(a)).toEqual(Buffer.from(BYTES));

    const fresh = setup({ env: { BC_DEV_CACHE_DIR: s.cache } });
    expect(await createAlSemResolver(fresh.deps).resolve()).toMatchObject({ source: "cache", path: a });
    expect(fresh.fetches).toEqual([]);
  });

  test("a hash or size mismatch is never cached or run, and leaves no file behind", async () => {
    for (const body of [new TextEncoder().encode("fake alsem binarY"), new TextEncoder().encode("short")]) {
      const s = setup({ body });
      const r = await createAlSemResolver(s.deps).resolve();
      expect(r).toMatchObject({ source: "unavailable", path: "alsem" });
      expect(r.reason).toMatch(/SHA-256|bytes, expected/);
      const dir = join(s.cache, "alsem", "1.7.1");
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    }
  });

  test("a tampered cache is re-downloaded", async () => {
    const s = setup();
    mkdirSync(join(s.cache, "alsem", "1.7.1"), { recursive: true });
    writeFileSync(binPath(s.cache), "tampered");
    expect((await createAlSemResolver(s.deps).resolve()).source).toBe("download");
    expect(readFileSync(binPath(s.cache))).toEqual(Buffer.from(BYTES));
  });

  test("download failure is remembered for 10 minutes, then retried", async () => {
    const s = setup({ status: 404 });
    const resolver = createAlSemResolver(s.deps);
    expect((await resolver.resolve()).reason).toContain("HTTP 404");
    s.tick(9 * 60_000);
    await resolver.resolve();
    expect(s.fetches.length).toBe(1);
    s.tick(60_000);
    await resolver.resolve();
    expect(s.fetches.length).toBe(2);
  });

  test("opt-out and unsupported platforms fall back to bare alsem with a reason", async () => {
    const off = setup({ onPath: "1.6.0" });
    const r = await createAlSemResolver({ ...off.deps, env: { ...off.deps.env, BC_DEV_ALSEM_DOWNLOAD: "0" } }).resolve();
    expect(r).toMatchObject({ source: "unavailable", path: "alsem", version: "1.6.0" });
    expect(r.reason).toContain("BC_DEV_ALSEM_DOWNLOAD=0");
    expect(r.reason).toContain("using alsem 1.6.0 on PATH");
    expect(off.fetches).toEqual([]);

    const mac = setup({ platform: "darwin", arch: "arm64" });
    expect((await createAlSemResolver(mac.deps).resolve()).reason).toContain("no release binary for darwin-arm64");
  });

  test("satisfiesPin compares numerically within one major", () => {
    expect(satisfiesPin("1.10.0", "1.7.1")).toBe(true);
    expect(satisfiesPin("1.7.0", "1.7.1")).toBe(false);
    expect(satisfiesPin("2.0.0", "1.7.1")).toBe(false);
  });
});
