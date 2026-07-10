import { describe, expect, test } from "bun:test";
import { DevEndpointError, fetchServerInfo } from "../../src/core/server-info";
import type { ConnectionConfig } from "../../src/core/types";

const config: ConnectionConfig = {
  server: "http://localhost",
  serverInstance: "BC",
  username: "u",
  password: "p",
};

function fakeFetch(status: number, body?: unknown): typeof fetch {
  return (async () =>
    new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("fetchServerInfo", () => {
  test("parses PascalCase metadata and gates features", async () => {
    const info = await fetchServerInfo(config, fakeFetch(200, { WebApiVersion: "7.0", RuntimeVersion: "15.0" }));
    expect(info).toEqual({
      webApiVersion: "7.0",
      runtimeVersion: "15.0",
      supportsTestRunning: true,
      supportsCoreSignalR: true,
    });
  });

  test("parses camelCase and flags old server", async () => {
    const info = await fetchServerInfo(config, fakeFetch(200, { webApiVersion: "5.0" }));
    expect(info.supportsTestRunning).toBe(false);
    expect(info.supportsCoreSignalR).toBe(false);
  });

  test("404 (legacy endpoint) means dev API 1.0", async () => {
    const info = await fetchServerInfo(config, fakeFetch(404));
    expect(info.webApiVersion).toBe("1.0");
    expect(info.supportsTestRunning).toBe(false);
  });

  test("401 throws auth error", async () => {
    await expect(fetchServerInfo(config, fakeFetch(401))).rejects.toThrow(DevEndpointError);
    await expect(fetchServerInfo(config, fakeFetch(401))).rejects.toMatchObject({ kind: "auth" });
  });

  test("network failure throws unreachable", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchServerInfo(config, failing)).rejects.toMatchObject({ kind: "unreachable" });
  });

  test("null wire fields become undefined, not 'null'", async () => {
    const info = await fetchServerInfo(config, fakeFetch(200, { WebApiVersion: "7.0", RuntimeVersion: null }));
    expect(info.runtimeVersion).toBeUndefined();
  });

  test("malformed 200 body throws http-kind DevEndpointError", async () => {
    const badFetch = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    await expect(fetchServerInfo(config, badFetch)).rejects.toMatchObject({ kind: "http" });
  });
});
