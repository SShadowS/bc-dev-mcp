import { describe, expect, test } from "bun:test";
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

  test("index.json follows the agentskills discovery format", async () => {
    const skills = await collectSkills(join(repoRoot, "skills"));
    const module = renderModule(skills);
    const match = /export const skillsIndexJson: string = (".*");/s.exec(module);
    const index = JSON.parse(JSON.parse(match![1]!)) as {
      $schema: string;
      skills: Array<{ name: string; type: string; description: string; url: string }>;
    };
    expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(index.skills).toHaveLength(4);
    for (const entry of index.skills) {
      expect(entry.type).toBe("skill-md");
      expect(entry.url).toBe(`skill://${entry.name}/SKILL.md`);
    }
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
