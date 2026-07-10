import { describe, expect, test } from "bun:test";
import { resolveShipConfig, SHIP_USAGE } from "../../../src/core/ship/args";

const ENV = {
  BC_DEV_USER: "admin",
  BC_DEV_PASSWORD: "pw",
  AL_PERF_URL: "http://alperf:3010",
  AL_PERF_TENANT: "acme",
  AL_PERF_TOKEN: "tok",
  BC_MDC_CONVERTER: "C:\\tools\\bc-mdc-converter.exe",
};
const BASE = ["--server", "http://bc", "--instance", "BC"];

describe("resolveShipConfig", () => {
  test("happy path fills defaults from env", () => {
    const r = resolveShipConfig(BASE, ENV);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.connection).toMatchObject({ server: "http://bc", serverInstance: "BC", username: "admin", password: "pw" });
    expect(r.config).toMatchObject({
      snapshotPort: 7083, clientType: "WebClient", captureSeconds: 60, pollSeconds: 5,
      converterPath: "C:\\tools\\bc-mdc-converter.exe",
      alPerfUrl: "http://alperf:3010", alPerfTenant: "acme", alPerfToken: "tok",
      outDir: ".", dryRun: false, keepArtifacts: false,
    });
  });

  test("--help wins over everything", () => {
    expect(resolveShipConfig(["--help"], ENV).kind).toBe("help");
    expect(resolveShipConfig(["-h", "--server", "x"], ENV).kind).toBe("help");
    expect(SHIP_USAGE).toContain("--duration");
    expect(SHIP_USAGE).toContain("--dry-run");
  });

  test("missing credentials, al-perf settings, and converter are aggregated errors", () => {
    const r = resolveShipConfig(BASE, {});
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    const text = r.errors.join("\n");
    expect(text).toContain("BC_DEV_USER");
    expect(text).toContain("AL_PERF_URL");
    expect(text).toContain("AL_PERF_TENANT");
    expect(text).toContain("AL_PERF_TOKEN");
    expect(text).toContain("BC_MDC_CONVERTER");
  });

  test("--dry-run waives the al-perf settings but not the converter", () => {
    const env = { BC_DEV_USER: "u", BC_DEV_PASSWORD: "p", BC_MDC_CONVERTER: "conv.exe" };
    const r = resolveShipConfig([...BASE, "--dry-run"], env);
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config.dryRun).toBe(true);
  });

  test("rejects bad values, aggregated", () => {
    const r = resolveShipConfig(
      [...BASE, "--client-type", "Robot", "--duration", "-5", "--schedule-id", "not-a-guid", "--al-perf-tenant", "bad_tenant!"],
      ENV,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    const text = r.errors.join("\n");
    expect(text).toContain("--client-type");
    expect(text).toContain("--duration");
    expect(text).toContain("--schedule-id");
    expect(text).toContain("AL_PERF_TENANT");
  });

  test("unknown argument and missing flag value are errors", () => {
    expect(resolveShipConfig([...BASE, "--wat"], ENV).kind).toBe("error");
    expect(resolveShipConfig([...BASE, "--duration"], ENV).kind).toBe("error");
  });

  test("flags override env", () => {
    const r = resolveShipConfig(
      [...BASE, "--al-perf-url", "http://other:1", "--converter", "/usr/local/bin/bc-mdc-converter", "--duration", "120",
        "--client-type", "Background", "--schedule-id", "550e8400-e29b-41d4-a716-446655440002", "--user-id", "JOBS",
        "--description", "nightly", "--out-dir", "/tmp/captures", "--keep-artifacts", "--snapshot-port", "7777", "--poll-interval", "10"],
      ENV,
    );
    expect(r.kind).toBe("config");
    if (r.kind !== "config") return;
    expect(r.config).toMatchObject({
      alPerfUrl: "http://other:1", converterPath: "/usr/local/bin/bc-mdc-converter", captureSeconds: 120,
      clientType: "Background", scheduleId: "550e8400-e29b-41d4-a716-446655440002", userId: "JOBS",
      description: "nightly", outDir: "/tmp/captures", keepArtifacts: true, snapshotPort: 7777, pollSeconds: 10,
    });
  });
});
