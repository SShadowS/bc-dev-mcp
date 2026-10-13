// c18 dist-parity gate: the Node bundle must expose exactly the tools src does.
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/mcp/server";
import { ServerState } from "../src/mcp/state";
import type { ToolDeps } from "../src/mcp/tools";

test("bundled index.js (same bun build as `bun run build`) lists the same tools as src", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "bcmcp-dist-")), "index.js");
  const root = join(import.meta.dir, "..");
  const build = Bun.spawnSync(["bun", "build", "src/mcp/index.ts", "--target=node", "--outfile", out], { cwd: root });
  expect(build.exitCode).toBe(0);

  const dist = new Client({ name: "dist-parity", version: "0.0.0" });
  await dist.connect(new StdioClientTransport({ command: "node", args: [out], cwd: root, stderr: "ignore" }));
  const src = new Client({ name: "src-parity", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([buildServer(new ServerState(), {} as ToolDeps).connect(s), src.connect(c)]);
  try {
    const [fromDist, fromSrc] = await Promise.all([dist.listTools(), src.listTools()]);
    expect(fromSrc.tools.length).toBeGreaterThan(0);
    expect(fromDist.tools.map((t) => t.name).sort()).toEqual(fromSrc.tools.map((t) => t.name).sort());
    expect(fromDist.tools).toEqual(fromSrc.tools);
  } finally {
    await Promise.all([dist.close(), src.close()]);
  }
}, 60_000);
