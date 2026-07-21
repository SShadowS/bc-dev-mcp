import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLaunchConfig, resolveConnection } from "../../src/core/launch-config";
import { BcDevError } from "../../src/core/agent-errors";

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
      environmentType: undefined,
      environmentName: undefined,
      authentication: "UserPassword",
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
      environmentType: undefined,
      environmentName: undefined,
      authentication: undefined,
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
    expect(c).toEqual({ environmentType: "OnPrem", authentication: "UserPassword", server: "http://a", serverInstance: "BC2", port: undefined, tenant: undefined, username: "u", password: "p" });
  });

  test("throws listing every missing field", () => {
    const error = (() => {
      try { resolveConnection({}, undefined, {}); } catch (caught) { return caught; }
    })();
    expect(error).toBeInstanceOf(BcDevError);
    expect(error).toMatchObject({ code: "CONFIGURATION_ERROR", category: "configuration" });
    expect((error as Error).message).toMatch(/Missing connection settings:.*server.*serverInstance.*username.*password/s);
  });

  test("resolves a cloud launch config without username/password", () => {
    const dir = projectWith(`{"configurations":[{"type":"al","request":"launch","environmentType":"Sandbox","environmentName":"sandbox","tenant":"tenant-id"}]}`);
    expect(resolveConnection({}, dir, {})).toEqual({
      environmentType: "Sandbox",
      authentication: "EntraId",
      environmentName: "sandbox",
      tenant: "tenant-id",
    });
  });

  test("uses the narrow Entra tenant fallback and never Basic fallback", () => {
    const dir = projectWith(`{"configurations":[{"type":"al","request":"launch","environmentType":"Production","environmentName":"Production"}]}`);
    expect(resolveConnection({}, dir, { BC_DEV_ENTRA_TENANT: "tenant-env", BC_DEV_USER: "ignored", BC_DEV_PASSWORD: "ignored" })).toEqual({
      environmentType: "Production",
      authentication: "EntraId",
      environmentName: "Production",
      tenant: "tenant-env",
    });
  });

  test("preserves env-var Basic auth for legacy on-prem Windows/AAD launch settings", () => {
    for (const authentication of ["Windows", "AAD"] as const) {
      const dir = projectWith(`{"configurations":[{"type":"al","request":"launch","server":"http://a","serverInstance":"BC","authentication":"${authentication}"}]}`);
      expect(resolveConnection({}, dir, { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p" })).toMatchObject({
        environmentType: "OnPrem",
        authentication: "UserPassword",
        username: "u",
        password: "p",
      });
    }
  });

  test("rejects unsupported on-prem auth when Basic credentials are unavailable", () => {
    const dir = projectWith(`{"configurations":[{"type":"al","request":"launch","server":"http://a","serverInstance":"BC","authentication":"Windows"}]}`);
    const error = (() => {
      try { resolveConnection({}, dir, {}); } catch (caught) { return caught; }
    })();
    expect(error).toBeInstanceOf(BcDevError);
    expect(error).toMatchObject({ code: "CONFIGURATION_ERROR" });
    expect((error as Error).message).toMatch(/Windows.*not supported/);
  });

  test("missing Entra settings use a typed configuration error", () => {
    const error = (() => {
      try { resolveConnection({ environmentType: "Sandbox" }, undefined, {}); } catch (caught) { return caught; }
    })();
    expect(error).toBeInstanceOf(BcDevError);
    expect(error).toMatchObject({ code: "CONFIGURATION_ERROR", category: "configuration" });
    expect((error as Error).message).toMatch(/^Missing Entra connection settings:/);
  });
});
