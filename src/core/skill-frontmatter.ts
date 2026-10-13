import { z } from "zod";

// SKILL.md frontmatter rules, consumed by scripts/embed-skills.ts and tests.
// Per-repo copy: the toolbox-wide shared package (epic #16 dependency c04) does not exist
// yet; sibling generators copy this file (or consume skillFrontmatterJsonSchema()) until it does.
export const SkillFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "skill names use lowercase letters, digits, hyphens"),
  description: z.string().min(1, "frontmatter description is required"),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/** JSON Schema (draft 2020-12) of SkillFrontmatter, for consumers outside TypeScript. */
export function skillFrontmatterJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(SkillFrontmatterSchema) as Record<string, unknown>;
}
