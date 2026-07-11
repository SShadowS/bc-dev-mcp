import { describe, expect, test } from "bun:test";
import { baseClientUrl, hubUrl, metadataUrl, snapshotUrl } from "../../src/core/urls";
import type { ConnectionConfig } from "../../src/core/types";

const base: ConnectionConfig = {
  environmentType: "OnPrem",
  authentication: "UserPassword",
  server: "http://localhost",
  serverInstance: "BC",
  username: "admin",
  password: "P@ss",
};

describe("urls", () => {
  test("defaults dev port to 7049", () => {
    expect(baseClientUrl(base)).toBe("http://localhost:7049/BC/");
  });

  test("explicit port field wins over URL port", () => {
    expect(baseClientUrl({ ...base, server: "http://host:8080", port: 7100 })).toBe("http://host:7100/BC/");
  });

  test("URL port used when no port field", () => {
    expect(baseClientUrl({ ...base, server: "https://host:8443" })).toBe("https://host:8443/BC/");
  });

  test("instance is URL-encoded", () => {
    expect(baseClientUrl({ ...base, serverInstance: "My Instance" })).toBe("http://localhost:7049/My%20Instance/");
  });

  test("metadata url with tenant", () => {
    expect(metadataUrl({ ...base, tenant: "default" })).toBe("http://localhost:7049/BC/dev/metadata?tenant=default");
    expect(metadataUrl(base)).toBe("http://localhost:7049/BC/dev/metadata");
  });

  test("hub url", () => {
    expect(hubUrl(base, "TestRunnerHub")).toBe("http://localhost:7049/BC/dev/TestRunnerHub");
    expect(hubUrl(base, "DebuggerHub")).toBe("http://localhost:7049/BC/dev/DebuggerHub");
  });

  test("builds confirmed SaaS developer and snapshot URLs", () => {
    const cloud: ConnectionConfig = {
      environmentType: "Sandbox",
      authentication: "EntraId",
      environmentName: "My Sandbox",
      tenant: "tenant-id",
    };
    expect(metadataUrl(cloud)).toBe("https://api.businesscentral.dynamics.com/v2.0/My%20Sandbox/dev/metadata?tenant=tenant-id");
    expect(hubUrl(cloud, "TestRunnerHub")).toBe("https://api.businesscentral.dynamics.com/v2.0/My%20Sandbox/dev/TestRunnerHub");
    expect(snapshotUrl(cloud, "snapshotendpointmetadata", 7083)).toBe(
      "https://api.businesscentral.dynamics.com/v2.0/My%20Sandbox/snapshotdebugger/snapshotendpointmetadata?tenant=tenant-id",
    );
  });
});
