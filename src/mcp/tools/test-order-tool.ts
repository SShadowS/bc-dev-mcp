import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AlObjectIndex, discoverTestRunners, discoverTests } from "../../core/al-objects";
import { BcDevError } from "../../core/agent-errors";
import { TestRunnerClient } from "../../core/hubs/test-runner-hub";
import { redactAuthorization } from "../../core/redaction";
import { identityKey } from "../../core/test-orchestration";
import { expandOrderSelection, runOrderMode } from "../../core/test-order-mode";
import { planTestOrder } from "../../core/test-order-plan";
import { explainPredictions, STATIC_PREDICTION_NOTE } from "../../core/test-order-static";
import { attributePolluterWrites, runTestsWithRecordWrites, type PolluterWriteAttribution } from "../../core/test-record-writes";
import type { CodeunitTestGroup } from "../../core/types";
import type { ServerState } from "../state";
import { requireTestRunningSupport, resolve, type ToolDeps } from "./shared";

const identity = z.object({
  codeunitId: z.number().int().describe("AL test codeunit object ID"),
  method: z.string().describe("AL test method name"),
});
const status = z.enum(["passed", "failed", "skipped", "missing", "ambiguous"]);

export const orderOutputSchema = z.object({
  seeds: z.array(z.number().int()).describe("Shuffle seeds used; the same selection and seeds replay the same orders"),
  initializes: z.number().int().describe("TestRunnerHub Initializes executed (isolation + orders + bisection probes)"),
  runners: z.array(z.object({
    codeunitId: z.number().int(),
    name: z.string(),
    testIsolation: z.string().describe("TestIsolation property value (Disabled when absent)"),
    setsTestIsolation: z.boolean().describe("true when this runner sets TestIsolation to anything other than Disabled"),
  })).describe("TestRunner codeunits in the local project (from discoverTests)"),
  runnerNote: z.string().describe("Which runner executed these orders and what that means for isolation"),
  runs: z.array(z.object({
    mode: z.enum(["recorded", "reversed", "shuffle"]),
    seed: z.number().int().optional(),
    order: z.array(z.string()).describe("Executed order as codeunitId:method"),
  })).describe("Executed orders; tests[].failingRuns and observations[].run index this array (0-based)"),
  tests: z.array(identity.extend({
    transactionModel: z.string().describe("Method's [TransactionModel] (AutoCommit when absent): AutoCommit/None methods can commit rows later methods of the same codeunit see"),
    classification: z.enum(["consistentPass", "consistentFail", "odVictim", "odBrittle", "flakyInSameOrder", "orderDependent", "incomplete"])
      .describe("odVictim = passes alone, fails after other methods; odBrittle = fails alone, passes after others"),
    candidatePolluters: z.array(identity).describe("odVictim only: methods that preceded it in every failing run"),
    failingRuns: z.array(z.number().int()).describe("Indexes into runs[] where this method failed"),
    observations: z.array(z.object({
      run: z.union([z.number().int(), z.literal("isolation")]),
      status,
    })),
    firstFailureOutput: z.string().nullable().describe("Raw server output of the first failing observation"),
  })),
  summary: z.object({
    consistentPass: z.number().int(),
    consistentFail: z.number().int(),
    odVictim: z.number().int(),
    odBrittle: z.number().int(),
    flakyInSameOrder: z.number().int(),
    orderDependent: z.number().int(),
    incomplete: z.number().int(),
  }),
  bisection: z.object({
    victims: z.array(identity.extend({
      outcome: z.enum(["found", "notReproduced", "compound", "capped", "inconclusive"])
        .describe("found = one preceding method reproduces the failure, verified by a [polluter, victim] probe"),
      polluter: identity.optional(),
      remainingCandidates: z.array(identity).describe("Smallest candidate set known to reproduce the failure"),
      probes: z.number().int(),
      predictionProbes: z.array(z.object({ polluter: identity, reproduced: z.boolean().nullable() })).optional()
        .describe("Statically predicted polluters probed alone before bisecting; reproduced null = inconclusive"),
    })),
    probes: z.number().int(),
    maxProbes: z.number().int(),
    capped: z.boolean(),
  }),
  staticPrediction: z.object({
    engine: z.literal("al-sem"),
    alsemVersion: z.string(),
    pairs: z.array(z.object({
      polluter: identity,
      victim: identity,
      table: z.object({ id: z.string(), name: z.string().nullable() }).nullable()
        .describe("al-sem table id and name; null = al-sem could not resolve the table (weak hint)"),
      survives: z.enum(["explicitCommit", "transactionModel"])
        .describe("explicitCommit = a Commit() runs before the polluter returns (survives even if it fails); transactionModel = committed when an AutoCommit/None method passes"),
      reason: z.string(),
      dynamic: z.enum(["confirmed", "refuted", "unresolved"]).describe("The pair checked against the runs and bisection"),
      evidence: z.string(),
    })),
    note: z.string().describe("What the static pre-screen assumes and cannot see"),
  }).nullable().describe("Predicted polluter -> victim pairs from al-sem, probed first by the bisect; null when al-sem is unavailable (see warnings)"),
  writeAttribution: z.array(identity.extend({
    outcome: z.enum(["found", "notReproduced", "compound", "capped", "inconclusive"]),
    table: z.object({ tableId: z.number().int(), tableName: z.string().nullable() }),
    captureComplete: z.boolean().describe("false = capture truncated/failed: a suspect with no observed write is unknown, not clean"),
    suspects: z.array(identity.extend({
      evidence: z.enum(["writeObserved", "noWriteObserved", "unknown"]),
      writes: z.array(z.object({
        operation: z.enum(["insert", "modify", "modifyAll", "rename", "delete", "deleteAll"]),
        receiver: z.string(),
        count: z.number().int(),
        source: z.enum(["deployed", "localAsserted"]),
      })),
      unresolvedWrites: z.number().int(),
    })),
    unattributedWriteGroups: z.number().int(),
    note: z.string(),
  })).nullable().describe("Per-victim record writes to pollutionTableId by its polluter (or remaining candidates); null when not requested or no suspect"),
}).describe("Order-dependence result (mode 'order' only)");

const RUNNER_NOTE =
  "TestRunnerHub's Initialize takes no runner codeunit, so the project runners above did not run these orders. "
  + "The hub rolls data back after every RunTests group even after Commit(), but not between methods of one codeunit group, "
  + "and all groups of one Initialize share one session (scripts/e2e.md #33, #15). A project runner with TestIsolation "
  + "Codeunit or Function would isolate differently.";

export async function runOrderOrchestration(
  params: Record<string, unknown>,
  state: ServerState,
  deps: ToolDeps,
  signal: AbortSignal | undefined,
  progress?: (progress: number, total?: number, message?: string) => void,
) {
  const { config, authorization, project } = resolve(params, deps);
  const company = params["company"] as string | undefined;
  const seeds = (params["seeds"] as number[] | undefined) ?? [1, 2, 3];
  const tableId = params["pollutionTableId"] as number | undefined;
  let discovered;
  try {
    discovered = await discoverTests(project);
  } catch (error) {
    throw new BcDevError("NOT_FOUND", `Cannot read local AL source in ${project}: ${error instanceof Error ? error.message : String(error)}`, "configuration");
  }
  const selection = expandOrderSelection(params["codeunits"] as CodeunitTestGroup[], discovered);
  const runners = await discoverTestRunners(project);
  if (tableId !== undefined) state.assertDebugSlotAvailable(); // fail before the runs, not after
  await requireTestRunningSupport(config, authorization, deps);

  const files = new Map(discovered.map((c) => [c.codeunitId, c.file]));
  const predicted = deps.orderPredictor
    ? await deps.orderPredictor(project, selection.map((m) => ({ ...m, file: files.get(m.codeunitId)! })))
    : { prediction: null, warnings: [] };

  let executions = 0;
  const result = await runOrderMode({
    selection,
    seeds,
    predictions: predicted.prediction?.pairs,
    maxProbes: params["maxProbes"] as number | undefined,
    execute: async (groups) => {
      const result = await new TestRunnerClient(deps.hubFactory).run(config, authorization, groups, { company });
      progress?.(++executions, undefined, `executed ${groups.length} group(s), ${result.results.length} test result(s)`);
      return result;
    },
    cancelled: () => signal?.aborted === true,
  });
  const warnings = [...predicted.warnings, ...result.warnings];
  let complete = result.complete;

  let writeAttribution: PolluterWriteAttribution[] | null = null;
  const suspected = result.bisection.victims.filter((v) => v.polluter || v.remainingCandidates.length > 0);
  if (tableId !== undefined && suspected.length > 0) {
    if (signal?.aborted === true) {
      warnings.push("Client cancellation was observed; the record-write capture was not started.");
      complete = false;
    } else {
      let slot: symbol | null = null;
      try {
        slot = state.claimDebugSlot("recordWrites");
        const index = await AlObjectIndex.build(project);
        const capture = await runTestsWithRecordWrites({
          hubFactory: deps.hubFactory,
          config,
          authorization,
          // The recorded order holds every polluter in front of its victim (same codeunit group).
          plan: planTestOrder(selection, { mode: "recorded" }).groups,
          company,
          tableId,
          changesDeployed: params["changesDeployed"] === true,
          localSource: async (objectType, objectId) => {
            const file = index.byId(objectType, objectId)?.file;
            return file ? await readFile(file, "utf8").catch(() => null) : null;
          },
          localFile: (objectType, objectId) => index.byId(objectType, objectId)?.file,
        });
        writeAttribution = attributePolluterWrites(suspected, capture.writes);
        if (!capture.writes.complete) complete = false;
        warnings.push(...capture.writes.warnings);
      } catch (error) {
        complete = false;
        warnings.push(`Record-write capture failed; polluters are still named by bisection: ${redactAuthorization(error instanceof Error ? error.message : String(error))}`);
      } finally {
        if (slot) state.releaseDebugSlot(slot);
      }
    }
  } else if (tableId !== undefined) {
    warnings.push("pollutionTableId was given but no od-victim had a polluter or candidate, so no record-write capture ran.");
  }

  const transactionModel = new Map(selection.map((m) => [identityKey(m.codeunitId, m.method), m.transactionModel]));
  return {
    mode: "order" as const,
    complete,
    warnings,
    order: {
      seeds,
      initializes: result.initializes + (writeAttribution ? 1 : 0),
      runners: runners.map((r) => ({
        codeunitId: r.codeunitId,
        name: r.name,
        testIsolation: r.testIsolation,
        setsTestIsolation: r.testIsolation.toLowerCase() !== "disabled",
      })),
      runnerNote: RUNNER_NOTE,
      runs: result.analysis.runs,
      tests: result.analysis.tests.map((t) => {
        const key = identityKey(t.codeunitId, t.method);
        return { ...t, transactionModel: transactionModel.get(key) ?? "AutoCommit", firstFailureOutput: result.firstFailureOutput.get(key) ?? null };
      }),
      summary: result.analysis.summary,
      bisection: result.bisection,
      staticPrediction: predicted.prediction
        ? {
            engine: "al-sem" as const,
            alsemVersion: predicted.prediction.alsemVersion,
            pairs: explainPredictions(predicted.prediction.pairs, result.analysis, result.bisection),
            note: STATIC_PREDICTION_NOTE,
          }
        : null,
      writeAttribution,
    },
  };
}
