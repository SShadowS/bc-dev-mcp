import { describe, expect, test } from "bun:test";
import { activityTypeFor, buildIngestManifest } from "../../../src/core/ship/manifest";

describe("activityTypeFor", () => {
  test("maps BC client types onto al-perf activity types", () => {
    expect(activityTypeFor("WebClient")).toBe("WebClient");
    expect(activityTypeFor("Background")).toBe("Background");
    expect(activityTypeFor("WebServiceClient")).toBe("WebServiceAPI");
    expect(activityTypeFor("ClientService")).toBe("WebClient");
  });
});

describe("buildIngestManifest", () => {
  const base = {
    activityId: "550e8400-e29b-41d4-a716-446655440001",
    clientType: "WebClient" as const,
    description: "nightly capture",
    startTime: "2026-07-10T01:00:00.000Z",
    activityDurationMs: 60000,
  };

  test("emits exactly the ingest manifest fields al-perf reads", () => {
    expect(buildIngestManifest({ ...base, scheduleId: "550e8400-e29b-41d4-a716-446655440002" })).toEqual({
      activityId: "550e8400-e29b-41d4-a716-446655440001",
      activityType: "WebClient",
      activityDescription: "nightly capture",
      captureKind: "instrumentation",
      startTime: "2026-07-10T01:00:00.000Z",
      activityDuration: 60000,
      scheduleId: "550e8400-e29b-41d4-a716-446655440002",
    });
  });

  test("omits scheduleId when not provided", () => {
    expect("scheduleId" in buildIngestManifest(base)).toBe(false);
  });
});
