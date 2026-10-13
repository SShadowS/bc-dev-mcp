import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// signalr's hidden runtime requires must all be embedded by scripts/compile-entry.ts,
// or the compiled exe fails every hub tool with "Cannot find module ...".
test("compile entry embeds every module signalr loads through requireFunc", () => {
  const dir = "node_modules/@microsoft/signalr/dist/esm";
  const required = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    for (const m of readFileSync(join(dir, file), "utf8").matchAll(/requireFunc\("([^"]+)"\)/g)) required.add(m[1]!);
  }
  const entry = readFileSync("scripts/compile-entry.ts", "utf8");
  // node-fetch and abort-controller are only loaded when fetch/AbortController are missing (never on Node >=22 or Bun).
  const missing = [...required].filter((m) => !["node-fetch", "abort-controller"].includes(m) && !entry.includes(`from "${m}"`));
  expect(required.size).toBeGreaterThan(0);
  expect(missing).toEqual([]);
});
