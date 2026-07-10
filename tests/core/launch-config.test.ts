import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLaunchConfig, resolveConnection } from "../../src/core/launch-config";

function projectWith(launchJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bcmcp-"));
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(join(dir, ".vscode", "launch.json"), launchJson);
  return dir;
}

describe("discoverLaunchConfig", () => {
  test("reads first on-prem al config, tolerates comments and trailing commas", () => {
    const dir = projectWith(`{
      // AL launch configurations
      "version": "0.2.0",
      "configurations": [
        {
          "name": "cloud", "type": "al", "request": "launch",
          "environmentName": "sandbox", /* cloud config: no server */
        },
        {
          "name": "docker", "type": "al", "request": "launch",
          "server": "http://bcserver",
          "serverInstance": "BC",
          "port": 7049,
          "tenant": "default",
          "authentication": "UserPassword",
        },
      ],
    }`);
    expect(discoverLaunchConfig(dir)).toEqual({
      server: "http://bcserver",
      serverInstance: "BC",
      port: 7049,
      tenant: "default",
    });
  });

  test("returns null when no launch.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "bcmcp-empty-"));
    expect(discoverLaunchConfig(dir)).toBeNull();
  });

  test("does not corrupt string values containing ', }' while stripping trailing commas", () => {
    const dir = projectWith(
      `{"configurations":[{"type":"al","request":"launch","server":"http://a","serverInstance":"BC","tenant":"weird, }value",},]}`,
    );
    expect(discoverLaunchConfig(dir)).toEqual({
      server: "http://a",
      serverInstance: "BC",
      port: undefined,
      tenant: "weird, }value",
    });
  });
});

describe("resolveConnection", () => {
  test("merges overrides > launch.json > env credentials", () => {
    const dir = projectWith(`{"configurations":[{"type":"al","request":"launch","server":"http://a","serverInstance":"BC"}]}`);
    const c = resolveConnection({ serverInstance: "BC2" }, dir, { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" });
    expect(c).toEqual({ server: "http://a", serverInstance: "BC2", port: undefined, tenant: undefined, username: "u", password: "p" });
  });

  test("throws listing every missing field", () => {
    expect(() => resolveConnection({}, undefined, {})).toThrow(/server.*serverInstance.*username.*password/s);
  });
});
