import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectSkills, renderModule } from "../../scripts/embed-skills";

const repoRoot = join(import.meta.dir, "..", "..");

describe("skills embedding", () => {
  test("generated module matches skills/ sources (run: bun run embed-skills)", async () => {
    const skills = await collectSkills(join(repoRoot, "skills"));
    const expected = renderModule(skills);
    const actual = await readFile(join(repoRoot, "src", "mcp", "skills.generated.ts"), "utf8");
    expect(actual).toBe(expected);
  });

  test("collects every skill with frontmatter-derived metadata", async () => {
    const skills = await collectSkills(join(repoRoot, "skills"));
    expect(skills.map((s) => s.name)).toEqual([
      "bc-al-debugging",
      "bc-al-profiling",
      "bc-al-source-symbols",
      "bc-al-testing",
      "bc-native-mcp",
    ]);
    for (const s of skills) {
      expect(s.uri).toBe(`skill://${s.name}/SKILL.md`);
      expect(s.mimeType).toBe("text/markdown");
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.text.startsWith("---")).toBe(true);
    }
  });

  test("precomputes full frontmatter, sha256 digest and byte size of the served text", async () => {
    const skills = await collectSkills(join(repoRoot, "skills"));
    for (const s of skills) {
      expect(s.frontmatter["name"]).toBe(s.name);
      expect(s.frontmatter["description"]).toBe(s.description);
      expect(s.digest).toBe(`sha256:${createHash("sha256").update(Buffer.from(s.text, "utf8")).digest("hex")}`);
      expect(s.size).toBe(Buffer.byteLength(s.text, "utf8"));
    }
  });

  test("keeps extra frontmatter fields and rejects multi-line values", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "bcmcp-skills-"));
    await mkdir(join(dir, "ok-skill"));
    await writeFile(join(dir, "ok-skill", "SKILL.md"), '---\nname: ok-skill\ndescription: "quoted"\nlicense: MIT\n---\nbody\n');
    const [skill] = await collectSkills(dir);
    expect(skill!.frontmatter).toEqual({ name: "ok-skill", description: "quoted", license: "MIT" });

    await mkdir(join(dir, "bad-skill"));
    await writeFile(join(dir, "bad-skill", "SKILL.md"), "---\nname: bad-skill\ndescription: x\n  continued\n---\nbody\n");
    await expect(collectSkills(dir)).rejects.toThrow(/single-line/);
  });

  test("rejects a skill whose frontmatter name mismatches its directory", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "bcmcp-skills-"));
    await mkdir(join(dir, "good-name"));
    await writeFile(join(dir, "good-name", "SKILL.md"), "---\nname: wrong-name\ndescription: x\n---\nbody\n");
    await expect(collectSkills(dir)).rejects.toThrow(/must equal directory name/);
  });
});
