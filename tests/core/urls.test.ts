import { describe, expect, test } from "bun:test";
import { automationUrl, baseClientUrl, devAppsUrl, hubUrl, metadataUrl, snapshotUrl } from "../../src/core/urls";
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

describe("app lifecycle urls", () => {
  const cronus: ConnectionConfig = { ...base, server: "http://cronus28", tenant: "default" };
  const cloud: ConnectionConfig = {
    environmentType: "Sandbox",
    authentication: "EntraId",
    environmentName: "My Sandbox",
    tenant: "contoso.onmicrosoft.com",
  };

  test("on-prem automation url uses port 7048, the instance, and a default tenant", () => {
    expect(automationUrl(base, "companies")).toBe(
      "http://localhost:7048/BC/api/microsoft/automation/v2.0/companies?tenant=default",
    );
  });

  test("on-prem automation url honours apiPort and ignores the dev port", () => {
    expect(automationUrl({ ...cronus, port: 7049 }, "companies", 7148)).toBe(
      "http://cronus28:7148/BC/api/microsoft/automation/v2.0/companies?tenant=default",
    );
  });

  test("OData options keep a literal $ and encode spaces as %20", () => {
    expect(automationUrl(cronus, "companies(abc)/extensions", undefined, { $filter: "publisher eq 'O''Neil Apps'" })).toBe(
      "http://cronus28:7048/BC/api/microsoft/automation/v2.0/companies(abc)/extensions?$filter=publisher%20eq%20'O''Neil%20Apps'&tenant=default",
    );
  });

  test("SaaS automation url sits under the environment and sends no tenant query", () => {
    expect(automationUrl(cloud, "companies", 7148, { $select: "id" })).toBe(
      "https://api.businesscentral.dynamics.com/v2.0/My%20Sandbox/api/microsoft/automation/v2.0/companies?$select=id",
    );
  });

  test("dev/apps url carries tenant and lower-case publish options", () => {
    expect(devAppsUrl(cronus, "recreate", "strict")).toBe(
      "http://cronus28:7049/BC/dev/apps?tenant=default&SchemaUpdateMode=recreate&DependencyPublishingOption=strict",
    );
    expect(devAppsUrl(base, "synchronize", "default")).toBe(
      "http://localhost:7049/BC/dev/apps?tenant=default&SchemaUpdateMode=synchronize&DependencyPublishingOption=default",
    );
  });
});
