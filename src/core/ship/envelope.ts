import { cliError, cliOk, ToolboxError, type CliEnvelope } from "@sshadows/bc-toolbox-envelope";
import { redactAuthorization } from "../redaction";
import type { CycleOutcome } from "./capture-cycle";

type ErrorOutcome = Extract<CycleOutcome, { kind: "error" }>;

/** --json for capture-and-ship (issue #32): one toolbox CLI envelope per run; exit codes unchanged. */
export function shipOutcomeEnvelope(outcome: CycleOutcome): CliEnvelope {
  switch (outcome.kind) {
    case "shipped":
      return cliOk({ outcome: "shipped", activityId: outcome.activityId, gzippedBytes: outcome.gzippedBytes });
    case "duplicate":
      return cliOk({ outcome: "duplicate", activityId: outcome.activityId });
    case "no-capture":
      return cliOk({ outcome: "no-capture" }, ["0 sessions captured in the window; nothing shipped (a normal outcome)."]);
    case "dry-run": {
      const { kind: _kind, ...rest } = outcome;
      return cliOk({ outcome: "dry-run", ...rest }, ["Dry run: nothing POSTed; artifacts kept."]);
    }
    case "error":
      return errorEnvelope(outcome);
  }
}

export function usageEnvelope(errors: string[]): CliEnvelope {
  return cliError(
    new ToolboxError("INVALID_ARGUMENT", errors.join("; "), "validation"),
    ["Fix the arguments (bun scripts/capture-and-ship.ts --help) and run again."],
  );
}

function errorEnvelope(outcome: ErrorOutcome): CliEnvelope {
  const message = redactAuthorization(outcome.message);
  const details = { stage: outcome.stage, ...(outcome.artifacts ?? {}) };
  const authFailed = /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message);
  const [error, nextSteps] = authFailed
    ? [new ToolboxError("AUTHENTICATION_FAILED", message, "auth", false, details), [
        outcome.stage === "ship"
          ? "Check AL_PERF_TENANT and the per-tenant AL_PERF_TOKEN, then run again."
          : "Check the BC credentials (BC_DEV_USER / BC_DEV_PASSWORD, or the Azure CLI login for SaaS), then run again.",
      ]]
    : byStage(outcome.stage, message, details);
  return cliError(error, nextSteps);
}

function byStage(stage: ErrorOutcome["stage"], message: string, details: Record<string, string>): [ToolboxError<string>, string[]] {
  switch (stage) {
    case "preflight":
      return [new ToolboxError("ENDPOINT_UNREACHABLE", message, "network", true, details), ["Check --server, --instance and --snapshot-port (the snapshot debugger, default 7083), then run again."]];
    case "convert":
      return [new ToolboxError("CONFIGURATION_ERROR", message, "configuration", false, details), ["Check --converter / BC_MDC_CONVERTER points at a working bc-mdc-converter; the capture zip is kept (details.zipPath)."]];
    case "budget":
      return [new ToolboxError("TIMEOUT", message, "network", true, details), ["Shorten --duration or raise the run's time budget, then run again."]];
    case "ship":
      return [new ToolboxError("SERVER_REJECTED", message, "server", true, details), ["Check AL_PERF_URL and the al-perf server, then re-ship the kept artifacts (docs/capture-ship-recipe.md) or run again."]];
    default: // attach, capture, finish: the BC snapshot debugger refused or failed
      return [new ToolboxError("SERVER_REJECTED", message, "server", true, details), ["A capture may still be armed on the tenant; wait, then run again. See docs/capture-ship-recipe.md."]];
  }
}
