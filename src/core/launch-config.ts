import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionConfig, ConnectionOverrides } from "./types";

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
  environmentType?: "OnPrem" | "Sandbox" | "Production";
  environmentName?: string;
  authentication?: "UserPassword" | "AAD" | "Windows";
  server?: string;
  serverInstance?: string;
  port?: number;
  tenant?: string;
}

export function discoverLaunchConfig(projectDir: string): ConnectionOverrides | null {
  const path = join(projectDir, ".vscode", "launch.json");
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(stripJsonc(readFileSync(path, "utf8"))) as { configurations?: AlLaunchConfiguration[] };
  const config = (parsed.configurations ?? []).find((c) => {
    if (c.type !== "al" || c.request !== "launch") return false;
    return c.environmentType === "Sandbox" || c.environmentType === "Production" || typeof c.server === "string";
  });
  if (!config) return null;
  return {
    environmentType: config.environmentType,
    environmentName: config.environmentName,
    authentication: config.authentication,
    server: config.server,
    serverInstance: config.serverInstance,
    port: config.port,
    tenant: config.tenant,
  };
}

export function resolveConnection(
  overrides: ConnectionOverrides,
  projectDir?: string,
  env: Record<string, string | undefined> = process.env,
): ConnectionConfig {
  const fromLaunch = projectDir ? (discoverLaunchConfig(projectDir) ?? {}) : {};
  const merged: ConnectionOverrides = {
    username: env["BC_DEV_USER"],
    password: env["BC_DEV_PASSWORD"],
    ...fromLaunch,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };
  const environmentType = merged.environmentType ?? (merged.server ? "OnPrem" : undefined);
  if (environmentType === "Sandbox" || environmentType === "Production") {
    if (merged.authentication && merged.authentication !== "AAD" && merged.authentication !== "EntraId") {
      throw new Error(`Authentication ${merged.authentication} is not supported for Business Central cloud; use Entra ID`);
    }
    const environmentName = merged.environmentName;
    const tenant = merged.tenant ?? env["BC_DEV_ENTRA_TENANT"];
    const missing: string[] = [];
    if (!environmentName) missing.push("environmentName (.vscode/launch.json or tool param)");
    if (!tenant) missing.push("tenant (.vscode/launch.json, tool param, or BC_DEV_ENTRA_TENANT)");
    if (missing.length > 0) throw new Error(`Missing Entra connection settings: ${missing.join(", ")}`);
    return { environmentType, authentication: "EntraId", environmentName: environmentName!, tenant: tenant! };
  }

  if (environmentType !== undefined && environmentType !== "OnPrem") {
    throw new Error(`Unsupported Business Central environmentType: ${String(environmentType)}`);
  }
  if (merged.authentication && merged.authentication !== "UserPassword") {
    throw new Error(`On-premises authentication ${merged.authentication} is not supported; select UserPassword explicitly`);
  }
  const missing: string[] = [];
  if (!merged.server) missing.push("server (tool param or .vscode/launch.json)");
  if (!merged.serverInstance) missing.push("serverInstance (tool param or .vscode/launch.json)");
  if (!merged.username) missing.push("username (BC_DEV_USER env var or tool param)");
  if (!merged.password) missing.push("password (BC_DEV_PASSWORD env var or tool param)");
  if (missing.length > 0) throw new Error(`Missing connection settings: ${missing.join(", ")}`);
  return {
    environmentType: "OnPrem",
    authentication: "UserPassword",
    server: merged.server!,
    serverInstance: merged.serverInstance!,
    port: merged.port,
    tenant: merged.tenant,
    username: merged.username!,
    password: merged.password!,
  };
}
