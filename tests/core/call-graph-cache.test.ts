import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alProjectFingerprint, cachedCallGraphProvider, type CallGraph } from "../../src/core/call-graph";

const graph = (n: number): CallGraph => ({ engine: "al-sem", nodes: [{ id: `n${n}`, kind: "Method", objectType: "", objectId: 0, objectName: "" }], edges: [] });

describe("cachedCallGraphProvider", () => {
  test("reuses the graph while the fingerprint is unchanged, rebuilds when it changes", async () => {
    let builds = 0;
    let fp = "a";
    const provider = cachedCallGraphProvider(async () => graph(++builds), async () => fp);
    expect((await provider("p")).nodes[0]!.id).toBe("n1");
    expect((await provider("p")).nodes[0]!.id).toBe("n1");
    fp = "b";
    expect((await provider("p")).nodes[0]!.id).toBe("n2");
    expect(builds).toBe(2);
  });

  test("concurrent calls share one build; a failure is not cached", async () => {
    let builds = 0;
    let fail = true;
    const provider = cachedCallGraphProvider(async () => {
      builds++;
      if (fail) throw new Error("engine failed");
      return graph(builds);
    }, async () => "same");
    const [a, b] = await Promise.allSettled([provider("p"), provider("p")]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(builds).toBe(1);
    fail = false;
    expect((await provider("p")).nodes[0]!.id).toBe("n2");
  });

  test("keeps at most maxEntries graphs (least recently used goes first)", async () => {
    let builds = 0;
    let fp = "";
    const provider = cachedCallGraphProvider(async () => graph(++builds), async () => fp, 2);
    for (const key of ["a", "b", "a", "c"]) { fp = key; await provider("p"); } // a, b, (a hit), c evicts b
    expect(builds).toBe(3);
    fp = "a"; await provider("p");
    expect(builds).toBe(3);
    fp = "b"; await provider("p");
    expect(builds).toBe(4);
  });
});

describe("alProjectFingerprint", () => {
  test("covers .al files, app.json and .alpackages/*.app, and nothing else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcmcp-fp-"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, ".alpackages"));
    writeFileSync(join(dir, "app.json"), "{}");
    writeFileSync(join(dir, "src", "A.Codeunit.al"), "codeunit 50100 A {}");
    writeFileSync(join(dir, ".alpackages", "Base.app"), "x");
    writeFileSync(join(dir, "notes.md"), "x");
    const before = await alProjectFingerprint(dir);
    expect(before).toContain("src/A.Codeunit.al|");
    expect(before).toContain(".alpackages/Base.app|");
    expect(before).not.toContain("notes.md");

    writeFileSync(join(dir, "notes.md"), "changed");
    expect(await alProjectFingerprint(dir)).toBe(before);

    writeFileSync(join(dir, "src", "A.Codeunit.al"), "codeunit 50100 A { }");
    utimesSync(join(dir, "src", "A.Codeunit.al"), new Date(), new Date(Date.now() + 5000));
    expect(await alProjectFingerprint(dir)).not.toBe(before);
  });
});
