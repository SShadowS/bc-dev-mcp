import { describe, expect, test } from "bun:test";
import { fetchSourceContent, sourceContentUrl } from "../../src/core/source-content";
import { DevEndpointError } from "../../src/core/server-info";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import type { ConnectionConfig } from "../../src/core/types";

const config: ConnectionConfig = {
  environmentType: "OnPrem",
  authentication: "UserPassword",
  server: "http://localhost",
  serverInstance: "BC",
  tenant: "default",
  username: "u",
  password: "p",
};
const auth = new BasicAuthorizationProvider("u", "p");

function fakeFetch(status: number, body: string | null, capture?: { url?: string; auth?: string }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (capture) {
      capture.url = input.toString();
      capture.auth = (init?.headers as Record<string, string>)["Authorization"];
    }
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

describe("sourceContentUrl", () => {
  test("builds the on-prem route with type, id, and tenant", () => {
    expect(sourceContentUrl(config, 5, 50130)).toBe("http://localhost:7049/BC/dev/sourcecontent?type=5&id=50130&tenant=default");
  });

  test("builds the cloud route on the v2.0 base", () => {
    const cloud: ConnectionConfig = {
      environmentType: "Sandbox",
      authentication: "EntraId",
      environmentName: "My Sandbox",
      tenant: "tenant-id",
    };
    expect(sourceContentUrl(cloud, 1, 2)).toBe("https://api.businesscentral.dynamics.com/v2.0/My%20Sandbox/dev/sourcecontent?type=1&id=2&tenant=tenant-id");
  });
});

describe("fetchSourceContent", () => {
  test("parses a JSON SourceContent body in either casing and sends auth", async () => {
    const capture: { url?: string; auth?: string } = {};
    const result = await fetchSourceContent(config, auth, 5, 50130, fakeFetch(200, JSON.stringify({ Content: "codeunit 50130 X {}", IsALContent: true }), capture));
    expect(result).toEqual({ content: "codeunit 50130 X {}", isAlContent: true });
    expect(capture.url).toContain("dev/sourcecontent?type=5&id=50130");
    expect(capture.auth).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    const camel = await fetchSourceContent(config, auth, 5, 50130, fakeFetch(200, JSON.stringify({ content: "x", isALContent: false })));
    expect(camel).toEqual({ content: "x", isAlContent: false });
  });

  test("empty content is a result, not an error", async () => {
    const result = await fetchSourceContent(config, auth, 5, 1, fakeFetch(200, JSON.stringify({ Content: "", IsALContent: false })));
    expect(result).toEqual({ content: "", isAlContent: false });
  });

  test("a non-JSON body is treated as raw source text", async () => {
    const result = await fetchSourceContent(config, auth, 5, 50130, fakeFetch(200, "codeunit 50130 X {}"));
    expect(result).toEqual({ content: "codeunit 50130 X {}", isAlContent: true });
  });

  test("401/403 throw auth-kind DevEndpointError with a mode hint", async () => {
    await expect(fetchSourceContent(config, auth, 5, 1, fakeFetch(401, null))).rejects.toMatchObject({ kind: "auth" });
    await expect(fetchSourceContent(config, auth, 5, 1, fakeFetch(403, null))).rejects.toThrow(/BC_DEV_USER/);
  });

  test("404 throws an unsupported error naming the dev-API gate", async () => {
    const error = await fetchSourceContent(config, auth, 5, 1, fakeFetch(404, null)).catch((e: unknown) => e as DevEndpointError);
    expect(error).toBeInstanceOf(DevEndpointError);
    expect((error as DevEndpointError).message).toContain("dev API");
  });

  test("network failure throws unreachable", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchSourceContent(config, auth, 5, 1, failing)).rejects.toMatchObject({ kind: "unreachable" });
  });
});
