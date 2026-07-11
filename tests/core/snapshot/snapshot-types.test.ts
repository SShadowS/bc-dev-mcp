import { describe, expect, test } from "bun:test";
import { buildSamplingAttachBody, buildInstrumentationAttachBody, parseStatus, CLIENT_TYPE_WIRE } from "../../../src/core/snapshot/snapshot-types";
import { snapshotUrl, DEFAULT_SNAPSHOT_PORT } from "../../../src/core/urls";

const cfg = { environmentType: "OnPrem", authentication: "UserPassword", server: "http://bc", serverInstance: "BC", tenant: "default", username: "u", password: "p" } as const;

describe("snapshot types", () => {
  test("attach body is PascalCase with integer sampling/profiling enums", () => {
    const body = buildSamplingAttachBody({ debuggingContext: "ctx", clientType: "WebClient", samplingIntervalMs: 100, sessionId: -1 });
    expect(body).toMatchObject({
      DebuggingContext: "ctx",
      ClientType: 1,
      SnapshotVerbosity: 0,
      SessionId: -1,
      ExecutionContext: 2, // Profiling
      Kind: 1, // Sampling
      SamplingInterval: 100,
    });
  });

  test("userId is included only when provided", () => {
    expect(buildSamplingAttachBody({ debuggingContext: "c", clientType: "WebClient", samplingIntervalMs: 50, sessionId: -1 }).UserId).toBeUndefined();
    expect(buildSamplingAttachBody({ debuggingContext: "c", clientType: "WebClient", samplingIntervalMs: 50, sessionId: -1, userId: "me" }).UserId).toBe("me");
  });

  test("parseStatus trims quotes and maps ints", () => {
    expect(parseStatus('"Started"')).toBe("Started");
    expect(parseStatus("Initialized")).toBe("Initialized");
    expect(parseStatus("2")).toBe("Started");
  });

  test("parseStatus handles every plain-string status value", () => {
    expect(parseStatus("Failed")).toBe("Failed");
    expect(parseStatus("Initialized")).toBe("Initialized");
    expect(parseStatus("Started")).toBe("Started");
    expect(parseStatus("Finished")).toBe("Finished");
  });

  test("parseStatus handles every quoted status value", () => {
    expect(parseStatus('"Failed"')).toBe("Failed");
    expect(parseStatus('"Initialized"')).toBe("Initialized");
    expect(parseStatus('"Finished"')).toBe("Finished");
  });

  test("parseStatus handles every integer status value", () => {
    expect(parseStatus("0")).toBe("Failed");
    expect(parseStatus("1")).toBe("Initialized");
    expect(parseStatus("2")).toBe("Started");
    expect(parseStatus("3")).toBe("Finished");
  });

  test("parseStatus throws on an unrecognized value", () => {
    expect(() => parseStatus("bogus")).toThrow();
  });

  test("CLIENT_TYPE_WIRE values", () => {
    expect(CLIENT_TYPE_WIRE).toEqual({ WebServiceClient: 0, WebClient: 1, Background: 2, ClientService: 3 });
  });

  test("buildSamplingAttachBody maps every ClientType wire value", () => {
    for (const [name, wireValue] of Object.entries(CLIENT_TYPE_WIRE)) {
      const body = buildSamplingAttachBody({
        debuggingContext: "ctx",
        clientType: name as keyof typeof CLIENT_TYPE_WIRE,
        samplingIntervalMs: 50,
        sessionId: -1,
      });
      expect(body.ClientType).toBe(wireValue);
    }
  });

  test("buildSamplingAttachBody accepts every samplingIntervalMs value", () => {
    for (const ms of [50, 100, 150] as const) {
      const body = buildSamplingAttachBody({ debuggingContext: "ctx", clientType: "WebClient", samplingIntervalMs: ms, sessionId: -1 });
      expect(body.SamplingInterval).toBe(ms);
    }
  });
});

describe("instrumentation attach body", () => {
  test("instrumentation attach body: Kind=0, Full verbosity, no SamplingInterval", () => {
    const body = buildInstrumentationAttachBody({ debuggingContext: "ctx", clientType: "WebClient", sessionId: -1 });
    expect(body).toMatchObject({ DebuggingContext: "ctx", ClientType: 1, SnapshotVerbosity: 1, SessionId: -1, ExecutionContext: 2, Kind: 0 });
    expect("SamplingInterval" in body).toBe(false);
  });

  test("instrumentation attach body includes UserId only when provided", () => {
    expect(buildInstrumentationAttachBody({ debuggingContext: "c", clientType: "WebClient", sessionId: -1 }).UserId).toBeUndefined();
    expect(buildInstrumentationAttachBody({ debuggingContext: "c", clientType: "WebClient", sessionId: -1, userId: "me" }).UserId).toBe("me");
  });
});

describe("snapshotUrl", () => {
  test("builds the snapshot base with the snapshot port and tenant", () => {
    const u = snapshotUrl(cfg, "attach", DEFAULT_SNAPSHOT_PORT, { debuggingcontext: "ctx" });
    expect(u).toBe("http://bc:7083/BC/snapshotdebugger/attach?debuggingcontext=ctx&tenant=default");
  });
  test("metadata verb with no extra query still carries tenant", () => {
    expect(snapshotUrl(cfg, "snapshotendpointmetadata", 9999)).toBe("http://bc:9999/BC/snapshotdebugger/snapshotendpointmetadata?tenant=default");
  });
  test("config with no tenant still defaults tenant=default", () => {
    const { tenant: _tenant, ...cfgNoTenant } = cfg;
    const u = snapshotUrl(cfgNoTenant, "attach", DEFAULT_SNAPSHOT_PORT, { debuggingcontext: "ctx" });
    expect(u).toContain("tenant=default");
  });
});
