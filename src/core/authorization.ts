/**
 * Owns the authorization value used by Business Central developer-service transports.
 * UserPassword connections create a Basic value; cloud connections acquire a Bearer token
 * exclusively through the standard Azure CLI. Azure CLI owns interactive login and refresh-token
 * state. This module keeps only the access token header and expiry in memory, refreshes on demand,
 * and shares one acquisition promise between concurrent callers.
 *
 * SECURITY: Never persist or log tokens, CLI stdout, Authorization headers, or authenticated URLs.
 * WIRE: Callers may need the exact returned value in both the HTTP Authorization header and BC's
 * `Authentication` SignalR query parameter. This module deliberately does not build URLs, retry
 * requests, run background refresh, support static tokens, or provide a command plug-in system.
 */
import { execFile } from "node:child_process";
import type { ConnectionConfig } from "./types";

export interface AuthorizationProvider {
  getAuthorizationHeader(): Promise<string>;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (executable: string, args: string[]) => Promise<ProcessResult>;
export type Clock = () => number;
export type AuthorizationProviderFactory = (config: ConnectionConfig) => AuthorizationProvider;

const RESOURCE = "https://api.businesscentral.dynamics.com";
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export const execFileRunner: ProcessRunner = async (executable, args) =>
  await new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { capturedStderr: stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

export class BasicAuthorizationProvider implements AuthorizationProvider {
  private readonly header: string;

  constructor(username: string, password: string) {
    this.header = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }

  async getAuthorizationHeader(): Promise<string> {
    return this.header;
  }
}

interface CachedToken {
  header: string;
  expiresAt: number;
}

interface CliTokenResponse {
  accessToken?: unknown;
  expires_on?: unknown;
  expiresOn?: unknown;
}

export class AzureCliAuthorizationProvider implements AuthorizationProvider {
  private cached: CachedToken | null = null;
  private acquiring: Promise<CachedToken> | null = null;

  constructor(
    private readonly tenant: string,
    private readonly runner: ProcessRunner = execFileRunner,
    private readonly clock: Clock = Date.now,
  ) {}

  async getAuthorizationHeader(): Promise<string> {
    const now = this.clock();
    if (this.cached && this.cached.expiresAt - now > REFRESH_WINDOW_MS) return this.cached.header;
    if (!this.acquiring) {
      this.acquiring = this.acquire().finally(() => {
        this.acquiring = null;
      });
    }
    this.cached = await this.acquiring;
    return this.cached.header;
  }

  private async acquire(): Promise<CachedToken> {
    let result: ProcessResult;
    try {
      result = await this.runner("az", [
        "account",
        "get-access-token",
        "--tenant",
        this.tenant,
        "--resource",
        RESOURCE,
        "--output",
        "json",
        "--only-show-errors",
      ]);
    } catch (error) {
      throw this.cliError(error);
    }

    let parsed: CliTokenResponse;
    try {
      parsed = JSON.parse(result.stdout) as CliTokenResponse;
    } catch {
      throw new Error("Azure CLI returned invalid JSON while acquiring a Business Central access token");
    }
    if (typeof parsed.accessToken !== "string" || parsed.accessToken.trim() === "") {
      throw new Error("Azure CLI response did not contain a Business Central access token");
    }
    const expiresAt = this.parseExpiration(parsed);
    if (expiresAt <= this.clock()) {
      throw new Error("Azure CLI returned an already expired Business Central access token");
    }
    return { header: `Bearer ${parsed.accessToken.trim()}`, expiresAt };
  }

  private parseExpiration(parsed: CliTokenResponse): number {
    if (typeof parsed.expires_on === "number" && Number.isFinite(parsed.expires_on)) return parsed.expires_on * 1000;
    if (typeof parsed.expires_on === "string" && /^\d+$/.test(parsed.expires_on)) {
      const value = Number(parsed.expires_on) * 1000;
      if (Number.isFinite(value)) return value;
    }
    if (typeof parsed.expiresOn === "string" && parsed.expiresOn.trim() !== "") {
      // Older Azure CLI versions document expiresOn as a local datetime (without a UTC offset).
      const normalized = parsed.expiresOn.includes("T") ? parsed.expiresOn : parsed.expiresOn.replace(" ", "T");
      const value = Date.parse(normalized);
      if (Number.isFinite(value)) return value;
    }
    throw new Error("Azure CLI response did not contain a valid token expiration (`expires_on`)");
  }

  private cliError(error: unknown): Error {
    const e = error as { code?: unknown; capturedStderr?: unknown };
    if (e.code === "ENOENT") return new Error("Azure CLI (`az`) was not found; install it and run `az login`");
    const stderr = typeof e.capturedStderr === "string" ? e.capturedStderr.toLowerCase() : "";
    if (/consent|permission|resource|aadsts65001/.test(stderr)) {
      return new Error("Azure CLI account lacks Business Central consent; sign in with an authorized account and grant the required delegated consent");
    }
    if (/aadsts50020|aadsts90002|tenant.*(?:not found|invalid|does not exist)/.test(stderr)) {
      return new Error("Azure CLI could not acquire a token for the configured tenant; verify the launch.json tenant and Azure account");
    }
    if (/login|not logged|interaction_required|authentication/.test(stderr)) {
      return new Error(`Azure CLI is not logged in for the configured tenant; run \`az login --tenant ${this.tenant}\``);
    }
    return new Error("Azure CLI failed to acquire a Business Central access token; verify `az login`, tenant access, and Business Central consent");
  }
}

export function createAuthorizationProvider(config: ConnectionConfig): AuthorizationProvider {
  return config.authentication === "UserPassword"
    ? new BasicAuthorizationProvider(config.username, config.password)
    : new AzureCliAuthorizationProvider(config.tenant);
}

export function createAuthorizationProviderFactory(
  runner: ProcessRunner = execFileRunner,
  clock: Clock = Date.now,
): AuthorizationProviderFactory {
  const entraByTenant = new Map<string, AzureCliAuthorizationProvider>();
  return (config) => {
    if (config.authentication === "UserPassword") {
      return new BasicAuthorizationProvider(config.username, config.password);
    }
    let provider = entraByTenant.get(config.tenant);
    if (!provider) {
      provider = new AzureCliAuthorizationProvider(config.tenant, runner, clock);
      entraByTenant.set(config.tenant, provider);
    }
    return provider;
  };
}
