import { describe, expect, test } from "bun:test";
import {
  AzureCliAuthorizationProvider,
  BasicAuthorizationProvider,
  createAuthorizationProviderFactory,
  createExecFileRunner,
  type ExecFileLike,
  type ProcessRunner,
} from "../../src/core/authorization";
import { BcDevError } from "../../src/core/agent-errors";

const NOW = Date.parse("2026-07-10T20:00:00Z");

function response(token = "secret-token", expiresAt = NOW + 60 * 60 * 1000): string {
  return JSON.stringify({ accessToken: token, expires_on: Math.floor(expiresAt / 1000), tokenType: "Bearer" });
}

describe("authorization providers", () => {
  test("Basic provider preserves existing username/password behavior", async () => {
    const provider = new BasicAuthorizationProvider("admin", "P@ss:word");
    expect(await provider.getAuthorizationHeader()).toBe("Basic " + Buffer.from("admin:P@ss:word").toString("base64"));
  });

  test("Azure CLI provider uses direct executable plus the required argument array", async () => {
    let call: { executable: string; args: string[] } | null = null;
    const runner: ProcessRunner = async (executable, args) => {
      call = { executable, args };
      return { stdout: response(), stderr: "" };
    };
    const provider = new AzureCliAuthorizationProvider("tenant-id", runner, () => NOW);
    expect(await provider.getAuthorizationHeader()).toBe("Bearer secret-token");
    expect(call as unknown).toEqual({
      executable: "az",
      args: [
        "account", "get-access-token", "--tenant", "tenant-id",
        "--resource", "https://api.businesscentral.dynamics.com",
        "--output", "json", "--only-show-errors",
      ],
    });
  });

  test("uses a command shell for the Azure CLI .cmd wrapper only on Windows", async () => {
    const shells: boolean[] = [];
    const fakeExecFile: ExecFileLike = (_executable, _args, options, callback) => {
      shells.push(options.shell);
      callback(null, "ok", "");
    };
    await createExecFileRunner("win32", fakeExecFile)("az", ["--version"]);
    await createExecFileRunner("linux", fakeExecFile)("az", ["--version"]);
    expect(shells).toEqual([true, false]);
  });

  test("accepts documented expiresOn compatibility value", async () => {
    const localExpiry = new Date(NOW + 60 * 60 * 1000);
    const pad = (value: number) => String(value).padStart(2, "0");
    const expiresOn = `${localExpiry.getFullYear()}-${pad(localExpiry.getMonth() + 1)}-${pad(localExpiry.getDate())} ${pad(localExpiry.getHours())}:${pad(localExpiry.getMinutes())}:${pad(localExpiry.getSeconds())}`;
    const runner: ProcessRunner = async () => ({
      stdout: JSON.stringify({ accessToken: "legacy", expiresOn }),
      stderr: "",
    });
    expect(await new AzureCliAuthorizationProvider("tenant", runner, () => NOW).getAuthorizationHeader()).toBe("Bearer legacy");
  });

  test("rejects unsafe tenant values before invoking Azure CLI", async () => {
    let called = false;
    const runner: ProcessRunner = async () => {
      called = true;
      return { stdout: response(), stderr: "" };
    };
    await expect(new AzureCliAuthorizationProvider("tenant & whoami", runner, () => NOW).getAuthorizationHeader())
      .rejects.toThrow(/GUID or domain name/);
    expect(called).toBe(false);
  });

  test("reuses a cached token outside the refresh window", async () => {
    let calls = 0;
    let now = NOW;
    const runner: ProcessRunner = async () => ({ stdout: response(`token-${++calls}`, NOW + 60 * 60 * 1000), stderr: "" });
    const provider = new AzureCliAuthorizationProvider("tenant", runner, () => now);
    expect(await provider.getAuthorizationHeader()).toBe("Bearer token-1");
    now += 30 * 60 * 1000;
    expect(await provider.getAuthorizationHeader()).toBe("Bearer token-1");
    expect(calls).toBe(1);
  });

  test("server-composition factory reuses one Azure provider per tenant", () => {
    const factory = createAuthorizationProviderFactory(async () => ({ stdout: response(), stderr: "" }), () => NOW);
    const first = factory({ environmentType: "Sandbox", authentication: "EntraId", environmentName: "one", tenant: "tenant" });
    const second = factory({ environmentType: "Production", authentication: "EntraId", environmentName: "two", tenant: "tenant" });
    const other = factory({ environmentType: "Sandbox", authentication: "EntraId", environmentName: "one", tenant: "other" });
    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });

  test("refreshes within five minutes of expiration", async () => {
    let calls = 0;
    let now = NOW;
    const runner: ProcessRunner = async () => ({ stdout: response(`token-${++calls}`, now + 60 * 60 * 1000), stderr: "" });
    const provider = new AzureCliAuthorizationProvider("tenant", runner, () => now);
    expect(await provider.getAuthorizationHeader()).toBe("Bearer token-1");
    now += 56 * 60 * 1000;
    expect(await provider.getAuthorizationHeader()).toBe("Bearer token-2");
  });

  test("concurrent callers share one in-progress Azure CLI invocation", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner: ProcessRunner = async () => {
      calls++;
      await gate;
      return { stdout: response(), stderr: "" };
    };
    const provider = new AzureCliAuthorizationProvider("tenant", runner, () => NOW);
    const requests = [provider.getAuthorizationHeader(), provider.getAuthorizationHeader(), provider.getAuthorizationHeader()];
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    expect(await Promise.all(requests)).toEqual(["Bearer secret-token", "Bearer secret-token", "Bearer secret-token"]);
  });

  test("clears the in-progress promise after failure so a later call can recover", async () => {
    let calls = 0;
    const runner: ProcessRunner = async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("failed"), { capturedStderr: "please run az login" });
      return { stdout: response("recovered"), stderr: "" };
    };
    const provider = new AzureCliAuthorizationProvider("tenant", runner, () => NOW);
    await expect(provider.getAuthorizationHeader()).rejects.toThrow(/az login/);
    expect(await provider.getAuthorizationHeader()).toBe("Bearer recovered");
    expect(calls).toBe(2);
  });

  test("reports Azure CLI executable not found", async () => {
    const runner: ProcessRunner = async () => { throw Object.assign(new Error("secret-token"), { code: "ENOENT" }); };
    const error = await new AzureCliAuthorizationProvider("tenant", runner, () => NOW).getAuthorizationHeader().catch((caught) => caught);
    expect(error).toBeInstanceOf(BcDevError);
    expect(error).toMatchObject({ code: "CONFIGURATION_ERROR", category: "configuration" });
    expect((error as Error).message).toMatch(/Azure CLI.*not found/);
  });

  test("reports invalid JSON, token, expiration, and expired token separately", async () => {
    const cases: Array<[string, string, RegExp]> = [
      ["invalid JSON", "not-json secret-token", /invalid JSON/],
      ["missing token", JSON.stringify({ expires_on: NOW / 1000 + 3600 }), /did not contain.*access token/],
      ["missing expiration", JSON.stringify({ accessToken: "secret-token" }), /valid token expiration/],
      ["invalid expiration", JSON.stringify({ accessToken: "secret-token", expires_on: "tomorrow" }), /valid token expiration/],
      ["expired", response("secret-token", NOW - 1000), /already expired/],
    ];
    for (const [name, stdout, pattern] of cases) {
      const runner: ProcessRunner = async () => ({ stdout, stderr: "" });
      const error = await new AzureCliAuthorizationProvider("tenant", runner, () => NOW)
        .getAuthorizationHeader().catch((e: unknown) => e as Error);
      expect((error as Error).message, name).toMatch(pattern);
      expect((error as Error).message).not.toContain("secret-token");
      expect(error).toBeInstanceOf(BcDevError);
      expect((error as BcDevError).code, name).toBe(name === "missing token" || name === "expired" ? "AUTHENTICATION_FAILED" : "CONFIGURATION_ERROR");
    }
  });

  test("nonzero CLI errors are actionable without leaking stderr", async () => {
    const runner: ProcessRunner = async () => {
      throw Object.assign(new Error("secret-token"), { capturedStderr: "AADSTS65001 consent required secret-token" });
    };
    const error = await new AzureCliAuthorizationProvider("tenant", runner, () => NOW)
      .getAuthorizationHeader().catch((e: unknown) => e as Error);
    expect((error as Error).message).toMatch(/consent/);
    expect((error as Error).message).not.toContain("secret-token");
    expect(error).toMatchObject({ code: "AUTHENTICATION_FAILED", category: "auth" });
  });

  test("login and tenant-access failures use typed authentication errors", async () => {
    for (const stderr of ["Please run az login", "AADSTS90002 tenant not found"]) {
      const runner: ProcessRunner = async () => { throw Object.assign(new Error("failed"), { capturedStderr: stderr }); };
      const error = await new AzureCliAuthorizationProvider("tenant", runner, () => NOW).getAuthorizationHeader().catch((caught) => caught);
      expect(error).toBeInstanceOf(BcDevError);
      expect(error).toMatchObject({ code: "AUTHENTICATION_FAILED", category: "auth" });
    }
  });
});
