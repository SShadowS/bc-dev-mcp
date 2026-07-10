import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionConfig } from "./types";

// Strips // and /* */ comments plus trailing commas, respecting string literals.
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return stripTrailingCommas(out);
}

// String-aware trailing-comma removal — a `,` inside a string literal must survive.
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

interface AlLaunchConfiguration {
  type?: string;
  request?: string;
  server?: string;
  serverInstance?: string;
  port?: number;
  tenant?: string;
}

export function discoverLaunchConfig(projectDir: string): Partial<ConnectionConfig> | null {
  const path = join(projectDir, ".vscode", "launch.json");
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(stripJsonc(readFileSync(path, "utf8"))) as { configurations?: AlLaunchConfiguration[] };
  const config = (parsed.configurations ?? []).find(
    (c) => c.type === "al" && c.request === "launch" && typeof c.server === "string",
  );
  if (!config) return null;
  return {
    server: config.server,
    serverInstance: config.serverInstance,
    port: config.port,
    tenant: config.tenant,
  };
}

export function resolveConnection(
  overrides: Partial<ConnectionConfig>,
  projectDir?: string,
  env: Record<string, string | undefined> = process.env,
): ConnectionConfig {
  const fromLaunch = projectDir ? (discoverLaunchConfig(projectDir) ?? {}) : {};
  const merged: Partial<ConnectionConfig> = {
    username: env["BC_DEV_USER"],
    password: env["BC_DEV_PASSWORD"],
    ...fromLaunch,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };
  const missing: string[] = [];
  if (!merged.server) missing.push("server (tool param or .vscode/launch.json)");
  if (!merged.serverInstance) missing.push("serverInstance (tool param or .vscode/launch.json)");
  if (!merged.username) missing.push("username (BC_DEV_USER env var or tool param)");
  if (!merged.password) missing.push("password (BC_DEV_PASSWORD env var or tool param)");
  if (missing.length > 0) {
    throw new Error(`Missing connection settings: ${missing.join(", ")}`);
  }
  return {
    server: merged.server!,
    serverInstance: merged.serverInstance!,
    port: merged.port,
    tenant: merged.tenant,
    username: merged.username!,
    password: merged.password!,
  };
}
