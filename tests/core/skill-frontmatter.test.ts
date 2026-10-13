import { describe, expect, test } from "bun:test";
import { SkillFrontmatterSchema, skillFrontmatterJsonSchema } from "../../src/core/skill-frontmatter";

describe("SkillFrontmatterSchema", () => {
  test("accepts a kebab-case name with a description", () => {
    expect(SkillFrontmatterSchema.safeParse({ name: "bc-al-testing", description: "x" }).success).toBe(true);
  });

  test("rejects non kebab-case names", () => {
    for (const name of ["Bc-Al", "bc_al", "-bc", "bc-", "bc--al", ""]) {
      expect(SkillFrontmatterSchema.safeParse({ name, description: "x" }).success).toBe(false);
    }
  });

  test("requires a nonempty description", () => {
    expect(SkillFrontmatterSchema.safeParse({ name: "bc" }).success).toBe(false);
    expect(SkillFrontmatterSchema.safeParse({ name: "bc", description: "" }).success).toBe(false);
  });

  test("exports a JSON Schema with both required fields", () => {
    const js = skillFrontmatterJsonSchema() as { required: string[]; properties: Record<string, { pattern?: string }> };
    expect(js.required.sort()).toEqual(["description", "name"]);
    expect(js.properties.name!.pattern).toBe("^[a-z0-9]+(-[a-z0-9]+)*$");
  });
});
