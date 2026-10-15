# Skills over MCP

The server ships its own operational manual as [Agent Skills](https://agentskills.io) over MCP
resources per the [Skills extension](https://modelcontextprotocol.io/extensions/skills/overview)
(SEP-2640, `io.modelcontextprotocol/skills`): `skill://bc-al-testing/SKILL.md`,
`skill://bc-al-debugging/SKILL.md`, `skill://bc-al-profiling/SKILL.md`,
`skill://bc-al-source-symbols/SKILL.md` and `skill://bc-native-mcp/SKILL.md`.
Clients that understand the extension discover them with `skills/list` (frontmatter plus a manifest
with SHA-256 digest and size per file) or fetch one with `skills/get`, then read the file with
`resources/read`; everything else sees them as plain readable resources.
Sources live in `skills/`; `bun run embed-skills` regenerates `src/mcp/skills.generated.ts`.
The npm package also ships the plain `skills/*/SKILL.md` files, so clients that never call
`resources/read` can install them straight from `node_modules/bc-dev-mcp/skills/`.

[Back to README](../README.md)
