/**
 * Shared Business Central SignalR transport contract for UserPassword and Entra modes.
 * Authorization providers own credentials and Azure CLI caching; this file only carries an
 * already acquired value. SECURITY: never log the URL because BC requires the authorization
 * value in its query string. WIRE: BC duplicates the same value in the HTTP Authorization header
 * and `Authentication` query parameter; live SaaS negotiation reconfirmed this on 2026-07-10.
 * This deliberately does not use SignalR accessTokenFactory or acquire/refresh tokens itself.
 */
import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import type { ConnectionConfig } from "../types";
import { redactAuthorization } from "../redaction";

export interface HubProxy {
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  on(method: string, cb: (...args: unknown[]) => void): void;
  onclose(cb: (err?: Error) => void): void;
  readonly connectionId: string | null;
}

export interface HubConnectOptions {
  authHeader: string;
  queryParams: Record<string, string>;
}

export type HubFactory = (url: string, opts: HubConnectOptions) => HubProxy;

export function redactTransportError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  // Deliberately return a plain Error instead of copying the original type/stack: either can
  // embed the authenticated SignalR URL. Losing that diagnostic context is the safe tradeoff.
  return new Error(redactAuthorization(message));
}

export function buildHubQuery(c: ConnectionConfig, authHeader: string, extra: Record<string, string> = {}): Record<string, string> {
  const query: Record<string, string> = {
    // WIRE: auth value duplicated as `Authentication` query param (lmt-decomp HubBasedTestRunnerService.OpenConnectionAsync)
    Authentication: authHeader,
    ...extra,
  };
  // WIRE: hub negotiate 401s without a tenant param even on single-tenant servers (live E2E 2026-07-03); BC's default tenant name is "default"
  query["tenant"] = c.tenant ?? "default";
  return query;
}

export const signalrHubFactory: HubFactory = (url, opts) => {
  const qs = new URLSearchParams(opts.queryParams).toString();
  const connection = new HubConnectionBuilder()
    .withUrl(`${url}?${qs}`, { headers: { Authorization: opts.authHeader } })
    .configureLogging(LogLevel.None)
    .build();
  return {
    start: () => connection.start().catch((error) => { throw redactTransportError(error); }),
    stop: () => connection.stop(),
    invoke: <T>(method: string, ...args: unknown[]) =>
      connection.invoke<T>(method, ...args).catch((error) => { throw redactTransportError(error); }),
    on: (method, cb) => connection.on(method, cb),
    onclose: (cb) => connection.onclose((error) => cb(error ? redactTransportError(error) : undefined)),
    get connectionId() {
      return connection.connectionId;
    },
  };
};

// WIRE: payload casing is an inference, not decompile-verified — client types use Newtonsoft [JsonProperty]
// (PascalCase member names, tw-decomp *.cs) but the server may serialize camelCase; verify in E2E.
// Normalizing every incoming payload to camelCase makes either casing safe.
export function normalizeKeys<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => normalizeKeys(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.charAt(0).toLowerCase() + k.slice(1)] = normalizeKeys(v);
    }
    return out as T;
  }
  return value as T;
}
