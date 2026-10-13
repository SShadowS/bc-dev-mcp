import { describe, expect, test } from "bun:test";
import { CliEnvelopeSchema } from "@sshadows/bc-toolbox-envelope";
import type { CycleOutcome } from "../../../src/core/ship/capture-cycle";
import { shipOutcomeEnvelope, usageEnvelope } from "../../../src/core/ship/envelope";

const ok = (o: CycleOutcome) => {
  const env = CliEnvelopeSchema.parse(shipOutcomeEnvelope(o));
  if (env.status !== "ok") throw new Error("expected ok");
  return env;
};
const err = (o: CycleOutcome) => {
  const env = CliEnvelopeSchema.parse(shipOutcomeEnvelope(o));
  if (env.status !== "error") throw new Error("expected error");
  return env.error;
};

describe("capture-and-ship --json envelope", () => {
  test("every success outcome is status ok with the outcome kind in data", () => {
    expect(ok({ kind: "shipped", activityId: "a", gzippedBytes: 9 }).data).toEqual({ outcome: "shipped", activityId: "a", gzippedBytes: 9 });
    expect(ok({ kind: "duplicate", activityId: "a" }).data).toEqual({ outcome: "duplicate", activityId: "a" });
    expect(ok({ kind: "no-capture" }).warnings[0]).toContain("normal outcome");
    expect(ok({ kind: "dry-run", activityId: "a", manifest: { x: 1 }, gzippedBytes: 2, zipPath: "z", irPath: "i" }).data)
      .toEqual({ outcome: "dry-run", activityId: "a", manifest: { x: 1 }, gzippedBytes: 2, zipPath: "z", irPath: "i" });
  });

  test("errors map by stage to core codes, keep stage and artifacts, and carry next steps", () => {
    expect(err({ kind: "error", stage: "preflight", message: "ECONNREFUSED" })).toMatchObject({ code: "ENDPOINT_UNREACHABLE", retryable: true, details: { stage: "preflight" } });
    expect(err({ kind: "error", stage: "convert", message: "bad", artifacts: { zipPath: "z.zip" } }))
      .toMatchObject({ code: "CONFIGURATION_ERROR", details: { stage: "convert", zipPath: "z.zip" } });
    expect(err({ kind: "error", stage: "budget", message: "late" }).code).toBe("TIMEOUT");
    expect(err({ kind: "error", stage: "ship", message: "HTTP 500" }).code).toBe("SERVER_REJECTED");
    expect(err({ kind: "error", stage: "attach", message: "HTTP 400" }).code).toBe("SERVER_REJECTED");
    expect(err({ kind: "error", stage: "finish", message: "x" }).nextSteps.length).toBeGreaterThan(0);
  });

  test("401/403 is AUTHENTICATION_FAILED with stage-specific advice, and secrets are redacted", () => {
    const ship = err({ kind: "error", stage: "ship", message: "HTTP 401 Authorization: Bearer abc.def" });
    expect(ship.code).toBe("AUTHENTICATION_FAILED");
    expect(ship.nextSteps[0]).toContain("AL_PERF_TOKEN");
    expect(ship.message).not.toContain("abc.def");
    expect(err({ kind: "error", stage: "preflight", message: "HTTP 403" }).nextSteps[0]).toContain("BC_DEV_USER");
  });

  test("usage errors are INVALID_ARGUMENT", () => {
    const env = CliEnvelopeSchema.parse(usageEnvelope(["--duration must be a positive integer, got -5"]));
    expect(env.status === "error" && env.error.code).toBe("INVALID_ARGUMENT");
  });
});
