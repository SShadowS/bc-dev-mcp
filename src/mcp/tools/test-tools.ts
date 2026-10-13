import { z } from "zod";
import { relative as relativePath, resolve as resolvePath } from "node:path";
import { AL_OBJECT_TYPE, AlObjectIndex, discoverTestRunners, discoverTests } from "../../core/al-objects";
import { TestRunnerClient } from "../../core/hubs/test-runner-hub";
import { fetchServerInfo } from "../../core/server-info";
import type { CoverageEntry, CoverageMode, RunTestsResult } from "../../core/types";
import { enrichTestRun, mapTestRunSources, testRunNeedsSourceMapping } from "../../core/agent-results";
import { AlProcedureDiscoveryCache, discoverAlProcedureIdentities, discoverTestMethodIdentities } from "../../core/al-procedures";
import { analyzeCoverageGaps } from "../../core/coverage-gaps";
import { buildCoverageMap, readCoverageMap, writeCoverageMap, type TestMethodName } from "../../core/coverage-map";
import { selectTests } from "../../core/test-selection";
import type { CallGraph } from "../../core/call-graph";
import { BcDevError } from "../../core/agent-errors";
import { analyzeTestOrchestration } from "../../core/test-orchestration";
import { redactAuthorization } from "../../core/redaction";
import type { ServerState } from "../state";
import { orderOutputSchema, runOrderOrchestration } from "./test-order-tool";
import { claimTestRun, codeunitsShape, connectionShape, requireTestRunningSupport, resolve, runTestsOutputSchema, type ToolDefinition, type ToolDeps } from "./shared";

const indexByDeps = new WeakMap<ToolDeps, Map<string, Promise<AlObjectIndex>>>();
const procedureDiscoveryByDeps = new WeakMap<ToolDeps, AlProcedureDiscoveryCache>();

function procedureDiscoveryCache(deps: ToolDeps): AlProcedureDiscoveryCache {
  let cache = procedureDiscoveryByDeps.get(deps);
  if (!cache) {
    cache = new AlProcedureDiscoveryCache();
    procedureDiscoveryByDeps.set(deps, cache);
  }
  return cache;
}

async function cachedObjectIndex(project: string, deps: ToolDeps): Promise<AlObjectIndex> {
  const key = resolvePath(project);
  let byProject = indexByDeps.get(deps);
  if (!byProject) {
    byProject = new Map();
    indexByDeps.set(deps, byProject);
  }
  let pending = byProject.get(key);
  if (!pending) {
    pending = AlObjectIndex.build(key);
    byProject.set(key, pending);
    void pending.catch(() => {
      if (byProject?.get(key) === pending) byProject.delete(key);
    });
    return await pending;
  }
  const index = await pending;
  await index.refresh();
  return index;
}

const testIdentitySchema = z.object({
  codeunitId: z.number().int().describe("AL test codeunit object ID"),
  method: z.string().describe("AL test method name"),
}).describe("One AL test method identity");

const observationStatusSchema = z
  .enum(["passed", "failed", "skipped", "missing", "ambiguous"])
  .describe("Observed status; missing/ambiguous means this run cannot establish one result");

const repeatOutputShape = {
  runsRequested: z.number().int().describe("Number of sequential runs requested"),
  runsAttempted: z.number().int().describe("Number of run-attempt envelopes retained, including an aborted final attempt"),
  complete: z.boolean().describe("true only when all requested runs completed without abort and every identity has one concrete result in each run (order mode: also every od-victim narrowed to one polluter and any write capture complete)"),
  outcome: z.enum(["passed", "failed", "unstable", "incomplete"]).describe(
    "Aggregate stability outcome: unstable means a flaky or otherwise inconsistent status sequence",
  ),
  summary: z.object({
    tests: z.number().int().describe("Distinct real or explicitly requested test method identities"),
    stablePassed: z.number().int().describe("Methods that passed in every run"),
    stableFailed: z.number().int().describe("Methods that failed in every run"),
    stableSkipped: z.number().int().describe("Methods that were skipped in every run"),
    flaky: z.number().int().describe("Methods observed both passing and failing"),
    inconsistent: z.number().int().describe("Concrete status mixtures that are not pass/fail flakes"),
    incomplete: z.number().int().describe("Methods classified incomplete because an observation is missing or ambiguous"),
    totalDurationMs: z.number().describe("Sum of server-reported durations for all real result rows across runs"),
  }).describe("Aggregate stability counts"),
  runs: z.array(
    runTestsOutputSchema.extend({
      run: z.number().int().positive().describe("1-based orchestration run number"),
    }),
  ).describe("Retained enriched evidence from every attempted run, including an aborted final attempt"),
  diffs: z.array(z.object({
    fromRun: z.number().int().positive().describe("Earlier 1-based run number"),
    toRun: z.number().int().positive().describe("Later adjacent 1-based run number"),
    passed: z.object({
      added: z.array(testIdentitySchema).describe("Methods newly in the passed set"),
      removed: z.array(testIdentitySchema).describe("Methods removed from the passed set"),
    }).describe("Exact passed-set difference"),
    failed: z.object({
      added: z.array(testIdentitySchema).describe("Methods newly in the failed set"),
      removed: z.array(testIdentitySchema).describe("Methods removed from the failed set"),
    }).describe("Exact failed-set difference"),
    changed: z.array(testIdentitySchema.extend({
      from: observationStatusSchema.describe("Earlier observation"),
      to: observationStatusSchema.describe("Later observation"),
    })).describe("Every identity whose observation changed"),
  }).describe("Difference between two adjacent runs")).describe("Adjacent pass/fail set and observation differences"),
  tests: z.array(testIdentitySchema.extend({
    classification: z
      .enum(["stablePassed", "stableFailed", "stableSkipped", "flaky", "inconsistent", "incomplete"])
      .describe("Stability classification across all returned observations"),
    complete: z.boolean().describe("true when this identity has exactly one concrete observation in every run"),
    passCount: z.number().int().describe("Number of passed observations"),
    failCount: z.number().int().describe("Number of failed observations"),
    skipCount: z.number().int().describe("Number of skipped observations"),
    missingCount: z.number().int().describe("Number of missing observations"),
    ambiguousCount: z.number().int().describe("Number of runs that reported this identity more than once"),
    observations: z.array(z.object({
      run: z.number().int().positive().describe("1-based run number"),
      status: observationStatusSchema,
      durationMs: z.number().nullable().describe("Server-reported duration, or null when no single result exists"),
    }).describe("One run's normalized observation")).describe(
      "One observation for every requested run; unattempted or unreported results are missing",
    ),
  })).describe(
    "Per-method stability analysis; method spelling comes from the first requested or observed identity and may differ in case from raw server rows",
  ),
  warnings: z.array(z.string()).describe("Reasons the aggregate or individual observations are incomplete"),
};

/** One object schema for both modes: repeat-only fields are absent in mode 'order', `order` is absent in mode 'repeat'. */
const testOrchestrationOutputSchema = z.object({
  mode: z.enum(["repeat", "order"]).describe("Which mode produced this result"),
  ...z.object(repeatOutputShape).partial().shape,
  complete: repeatOutputShape.complete,
  warnings: repeatOutputShape.warnings,
  order: orderOutputSchema.optional(),
});

/** Best-effort local name lookup for the test methods in a coverage payload; empty when source is unavailable. */
async function testMethodNames(project: string, coverage: CoverageEntry[], deps: ToolDeps): Promise<TestMethodName[]> {
  if (coverage.length === 0) return [];
  try {
    const index = await cachedObjectIndex(project, deps);
    const files = [...new Set(coverage.flatMap((entry) => {
      const file = index.byId(AL_OBJECT_TYPE.codeunit!, entry.testObjectId)?.file;
      return file === undefined ? [] : [relativePath(resolvePath(project), file)];
    }))];
    if (files.length === 0) return [];
    return (await discoverAlProcedureIdentities(project, files, procedureDiscoveryCache(deps))).procedures;
  } catch {
    return [];
  }
}

async function mapOrchestrationSources(
  runs: RunTestsResult[],
  project: string,
  deps: ToolDeps,
): Promise<void> {
  const needingMapping = runs.filter(testRunNeedsSourceMapping);
  if (needingMapping.length === 0) return;
  let index: AlObjectIndex;
  try {
    index = await cachedObjectIndex(project, deps);
  } catch {
    for (const run of needingMapping) {
      run.sourceMappingWarning =
        "Local AL source mapping was unavailable; server test evidence is retained and call-stack file fields remain null.";
    }
    return;
  }
  for (const run of needingMapping) mapTestRunSources(run, index);
}

export function createTestTools(state: ServerState, deps: ToolDeps): ToolDefinition[] {
  return [
    {
      name: "bcdev_status",
      title: "BC server status",
      description: "Check the BC dev endpoint: reachability, auth, dev API version, test-running support. Call this first when anything fails.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      schema: { ...connectionShape },
      outputSchema: z.looseObject({
        webApiVersion: z.string(),
        runtimeVersion: z.string().optional(),
        debuggerVersion: z.string().optional().describe("Hub debugger protocol version; gates source download and large-string watches"),
        supportsTestRunning: z.boolean().describe("false = server too old for TestRunnerHub (needs dev API >= 7.0)"),
        supportsCoreSignalR: z.boolean(),
        supportsSourceDownload: z.boolean().describe("true = dev/sourcecontent available (dev API >= 2.0) for bcdev_source"),
      }),
      handler: async (params) => {
        const { config, authorization } = resolve(params, deps);
        return await fetchServerInfo(config, authorization, deps.fetchFn);
      },
    },
    {
      name: "bcdev_test_discover",
      title: "Discover AL tests",
      description: "Scan the AL project for test codeunits ([Test] methods, with each method's attributes and TransactionModel) and TestRunner codeunits (with TestIsolation). Filesystem only — no server needed.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      schema: { project: connectionShape.project },
      outputSchema: z.object({
        tests: z.array(
          z.looseObject({
            codeunitId: z.number(),
            name: z.string(),
            file: z.string(),
            methods: z.array(z.string()),
            methodDetails: z.array(
              z.looseObject({ name: z.string(), transactionModel: z.string(), attributes: z.array(z.string()) }),
            ),
          }),
        ),
        runners: z.array(
          z.looseObject({ codeunitId: z.number(), name: z.string(), file: z.string(), testIsolation: z.string() }),
        ),
      }),
      handler: async (params) => {
        const project = (params["project"] as string | undefined) ?? deps.cwd;
        return { tests: await discoverTests(project), runners: await discoverTestRunners(project) };
      },
    },
    {
      name: "bcdev_test_select",
      title: "Select AL tests for a Git diff",
      description:
        "Pick the AL test methods a Git diff can affect, before running anything: changed procedures and triggers are expanded through the whole-program call graph (al-sem `alsem graph`, else altool; BC_DEV_CALLGRAPH_ENGINE) to the [Test] methods that may execute them, and unioned with an optional coverage map from an earlier bcdev_test_run. Returns a ranked selection (direct > event > dynamic), uncoverable changed procedures (with al-sem: no test can reach them, under the graph's stated assumptions), shards whose codeunits feed bcdev_test_run unchanged, and fallbackToAll when the diff is outside what selection can see. Limit: the tests must be in the same app as the code (or a test folder nested in it); with a separate test app selection falls back to the whole suite. Local only (git + alsem/altool); no server needed.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      schema: {
        project: connectionShape.project,
        baseRef: z.string().min(1).describe(
          "Git base ref (for example origin/main). Its merge-base with HEAD is compared to the working tree, including untracked AL files, exactly as bcdev_test_run coverageAgainst does.",
        ),
        coverageMapFile: z.string().min(1).optional().describe(
          "Coverage map written by an earlier bcdev_test_run coverageMapFile, relative to the project. Adds coverage-history evidence; without it selection is static reachability only.",
        ),
        maxCodeunitsPerShard: z.number().int().min(1).optional().describe("Maximum test codeunits per shard (default: one shard)"),
      },
      outputSchema: z.looseObject({
        baseRef: z.string(),
        mergeBase: z.string().describe("Commit the diff was taken from"),
        selection: z.array(z.looseObject({
          codeunitId: z.number().int(),
          method: z.string(),
          reason: z.enum(["direct", "event", "coverage-history", "new-test", "dynamic"]).describe(
            "Strongest evidence; event = any indirect Event/Interface/Run/Trigger path; dynamic = only through an al-sem hub (a call the engine cannot pin to one target)",
          ),
          reasons: z.array(z.string()),
          confidence: z.number().describe("0-1 rank score"),
          reaches: z.array(z.string()).describe("Changed procedures this test reaches, as Object.Procedure"),
        })).describe("Ranked, most confident first"),
        uncoverable: z.array(z.looseObject({ objectName: z.string(), name: z.string(), relativeFile: z.string(), startLine: z.number() }))
          .describe("Changed procedures no test reaches statically or by coverage history"),
        changedProcedures: z.array(z.looseObject({ kind: z.enum(["procedure", "trigger"]), objectName: z.string(), name: z.string() })),
        engine: z.enum(["al-sem", "altool", "none"]).describe("Call-graph engine used; none = no changed code needed a graph"),
        engineVersion: z.string().optional().describe("al-sem engine version (meta.engine)"),
        shards: z.array(z.object({
          codeunits: z.array(z.object({ id: z.number().int(), methods: z.array(z.string()) })).describe("Pass as bcdev_test_run codeunits"),
        })).describe("Run plan; covers every test when fallbackToAll"),
        fallbackToAll: z.boolean().describe("true = the diff touches something selection cannot see; run the whole suite"),
        fallbackReasons: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
      handler: async (params) => {
        const project = (params["project"] as string | undefined) ?? deps.cwd;
        const coverageMapFile = params["coverageMapFile"] as string | undefined;
        const cache = procedureDiscoveryCache(deps);
        const tests = await discoverTestMethodIdentities(project, cache);
        const changes = await deps.gitChanges(project, params["baseRef"] as string);
        const discovered = changes.files.length === 0
          ? { procedures: [], warnings: [], complete: true }
          : await discoverAlProcedureIdentities(project, changes.files.map((file) => file.relativeFile), cache);
        const coverageMap = coverageMapFile === undefined ? null : await readCoverageMap(resolvePath(project, coverageMapFile));
        // No changed procedure or trigger means no graph lookups; skip building the graph.
        const needsGraph = discovered.procedures.length > 0 || ("unsupportedExecutables" in discovered && discovered.unsupportedExecutables.length > 0);
        const graph: CallGraph = needsGraph ? await deps.callGraph(project) : { nodes: [], edges: [] };
        const result = selectTests({
          changes,
          discovered,
          tests: tests.methods,
          graph,
          coverageMap,
          maxCodeunitsPerShard: params["maxCodeunitsPerShard"] as number | undefined,
        });
        const warnings = [...tests.warnings, ...discovered.warnings, ...result.warnings];
        if (!tests.complete) {
          warnings.push(graph.engine === "al-sem"
            ? "Some [Test] methods have no compiler method identity; they cannot match coverage history by identity."
            : "Some [Test] methods have no compiler method identity; they cannot match the call graph or coverage history by identity.");
        }
        if (coverageMap?.mergeBase && coverageMap.mergeBase !== changes.mergeBase) {
          warnings.push(`The coverage map was recorded against ${coverageMap.mergeBase}, not this diff's merge base ${changes.mergeBase}; its history may be stale.`);
        }
        return {
          baseRef: changes.baseRef,
          mergeBase: changes.mergeBase,
          ...result,
          warnings,
          engine: needsGraph ? graph.engine ?? "altool" : "none",
          ...(graph.meta ? { engineVersion: graph.meta.engine } : {}),
        };
      },
    },
    {
      name: "bcdev_test_run",
      title: "Run AL tests",
      description: "Run AL tests on the BC server. Per-method results and optional procedure coverage; coverageAgainst also reports which Git-changed procedures this run did not exercise.",
      // destructiveHint:false assumes BC test isolation (TestIsolation=Codeunit) rolls back data changes.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      outputSchema: runTestsOutputSchema,
      schema: {
        ...connectionShape,
        codeunits: codeunitsShape,
        company: z.string().optional().describe("BC company name (default: the server's default company)"),
        coverage: z
          .enum(["none", "line", "procedure"])
          .optional()
          .describe("Code coverage: 'procedure' is validated against real BC; 'line' is unproven — prefer 'procedure'. Default 'none'."),
        coverageAgainst: z.string().min(1).optional().describe(
          "Git base ref for changed-procedure gap analysis (for example origin/main). Compares its merge-base with HEAD to the current working tree, includes untracked AL files, and requires/implies procedure coverage.",
        ),
        coverageMapFile: z.string().min(1).optional().describe(
          "Write a versioned per-test procedure-coverage map (format bc-dev-mcp.coverage-map v1: test codeunit/method name/methodId -> covered procedure identities, stamped with the coverageAgainst merge base) to this JSON file, relative to the project. Requires/implies procedure coverage; overwrites the file.",
        ),
        changesDeployed: z.literal(true).optional().describe(
          "Explicit assertion that the current working-tree versions of changed AL objects are deployed to this server. Required for covered/uncovered classifications because procedure coverage does not carry an app or source hash.",
        ),
      },
      handler: async (params, context) => {
        claimTestRun(state);
        try {
          const { config, authorization, project } = resolve(params, deps);
          const coverageAgainst = params["coverageAgainst"] as string | undefined;
          const changesDeployed = params["changesDeployed"] === true;
          const coverageMapFile = params["coverageMapFile"] as string | undefined;
          const requestedCoverage = params["coverage"] as CoverageMode | undefined;
          const forcesProcedure = coverageAgainst !== undefined || coverageMapFile !== undefined;
          if (forcesProcedure && requestedCoverage !== undefined && requestedCoverage !== "procedure") {
            throw new BcDevError(
              "INVALID_ARGUMENT",
              `${coverageAgainst !== undefined ? "coverageAgainst" : "coverageMapFile"} requires coverage: 'procedure' (or omit coverage to select procedure coverage automatically)`,
              "validation",
            );
          }
          if (changesDeployed && coverageAgainst === undefined) {
            throw new BcDevError(
              "INVALID_ARGUMENT",
              "changesDeployed is only valid together with coverageAgainst",
              "validation",
            );
          }
          const coverageMode: CoverageMode | undefined = forcesProcedure ? "procedure" : requestedCoverage;
          const gapPreparation = coverageAgainst === undefined
            ? null
            : await deps.gitChanges(project, coverageAgainst).then(async (changes) => ({
                changes,
                discovered: changes.files.length === 0
                  ? { procedures: [], warnings: [], complete: true }
                  : await discoverAlProcedureIdentities(
                      project,
                      changes.files.map((file) => file.relativeFile),
                      procedureDiscoveryCache(deps),
                    ),
              }));
          await requireTestRunningSupport(config, authorization, deps);
          const plannedGroups = params["codeunits"] as Array<{ id: number; methods?: string[] }>;
          // total is known only when every group names its methods
          const plannedTotal = plannedGroups.every((g) => g.methods?.length)
            ? plannedGroups.reduce((n, g) => n + g.methods!.length, 0)
            : undefined;
          const result = await new TestRunnerClient(deps.hubFactory).run(
            config,
            authorization,
            plannedGroups,
            {
              company: params["company"] as string | undefined,
              coverage: coverageMode,
              onTestCompleted: context?.progress && ((r, completed) =>
                context.progress!(completed, plannedTotal, `${r.codeunitId}.${r.method} ${r.status}`)),
            },
          );
          enrichTestRun(result);
          const needsCoverageMapping = result.coverage?.some((entry) => entry.coveredProcedures.length > 0) ?? false;
          const needsCallStackMapping = testRunNeedsSourceMapping(result);
          if (needsCallStackMapping || needsCoverageMapping) {
            let index: AlObjectIndex | null = null;
            try {
              index = await cachedObjectIndex(project, deps);
            } catch {
              const unavailable = [
                ...(needsCallStackMapping ? ["call-stack file fields remain null"] : []),
                ...(needsCoverageMapping ? ["coverage procedure file fields remain unset"] : []),
              ];
              result.sourceMappingWarning =
                `Local AL source mapping was unavailable; server test results are complete and ${unavailable.join("; ")}.`;
            }
            if (index) {
              mapTestRunSources(result, index);
              for (const entry of result.coverage ?? []) {
                for (const proc of entry.coveredProcedures) {
                  proc.file = index.byId(proc.objectType, proc.objectId)?.file;
                }
              }
            }
          }
          if (gapPreparation) {
            result.coverageGaps = analyzeCoverageGaps(
              gapPreparation.changes,
              gapPreparation.discovered,
              result.coverage,
              result.runAborted === true,
              changesDeployed,
              result.coverageComplete === true,
            );
          }
          if (coverageMapFile !== undefined) {
            const file = resolvePath(project, coverageMapFile);
            const map = buildCoverageMap(
              result.coverage ?? [],
              {
                baseRef: gapPreparation?.changes.baseRef ?? null,
                mergeBase: gapPreparation?.changes.mergeBase ?? null,
                complete: result.coverageComplete === true && result.runAborted !== true,
              },
              await testMethodNames(project, result.coverage ?? [], deps),
            );
            const warnings: string[] = [];
            if (map.mergeBase === null) {
              warnings.push("No coverageAgainst ref was given, so the map carries no merge-base stamp and later selection cannot judge its staleness.");
            }
            if (!map.complete) {
              warnings.push("The run aborted or Business Central omitted a coverage payload; a test's absence from this map proves nothing.");
            }
            const unnamed = map.tests.filter((test) => test.method === null).length;
            if (unnamed > 0) warnings.push(`${unnamed} test(s) have no locally resolved method name; they are identified by codeunitId/methodId only.`);
            let written = true;
            try {
              await writeCoverageMap(file, map);
            } catch (error) {
              written = false;
              warnings.push(error instanceof Error ? error.message : String(error));
            }
            result.coverageMap = { file, written, tests: map.tests.length, complete: map.complete, mergeBase: map.mergeBase, warnings };
          }
          return result;
        } finally {
          state.testRunActive = false;
        }
      },
    },
    {
      name: "bcdev_test_orchestrate",
      title: "Repeat or reorder AL tests",
      description:
        "mode 'repeat' (default): run one AL test selection sequentially 2–20 times, retain every enriched attempt, diff adjacent passed/failed sets, and flag flaky or incomplete method outcomes. "
        + "mode 'order': run each method alone, then the selection recorded, reversed and once per seed; classify od-victims (pass alone, fail after others), bisect each to its polluter, and optionally attribute the polluter's writes to pollutionTableId. "
        + "Reports each method's TransactionModel and the project runners' TestIsolation. Needs local AL source. Non-rolled-back test side effects repeat on every attempt.",
      // destructiveHint:false assumes BC test isolation (TestIsolation=Codeunit) rolls back data
      // changes. Suites with disabled isolation or external side effects can repeat those effects.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      outputSchema: testOrchestrationOutputSchema,
      schema: {
        ...connectionShape,
        codeunits: codeunitsShape,
        company: z.string().optional().describe("BC company name (default: the server's default company)"),
        runs: z
          .number()
          .int()
          .min(2)
          .max(20)
          .optional()
          .describe("mode 'repeat' only: number of sequential runs to compare (default 3; minimum 2; maximum 20)"),
        mode: z.enum(["repeat", "order"]).optional().describe("'repeat' (default) repeats one order; 'order' detects order-dependent (polluter/victim) tests"),
        seeds: z
          .array(z.number().int().min(0).max(0xffffffff))
          .min(1)
          .max(10)
          .optional()
          .describe("mode 'order' only: shuffle seeds, one shuffled order each (default [1, 2, 3]); same seeds replay the same orders"),
        maxProbes: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("mode 'order' only: bisection probe budget across all victims, one Initialize each (default 50)"),
        pollutionTableId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("mode 'order' only: table ID to capture writes to (one debugger-bound recorded run) and attribute to each victim's polluter, e.g. 18 for Customer"),
        changesDeployed: z
          .boolean()
          .optional()
          .describe("mode 'order' with pollutionTableId only: assert local AL source is exactly deployed, so writes can be identified from local source when server source is unavailable"),
      },
      handler: async (params, context) => {
        const mode = (params["mode"] as "repeat" | "order" | undefined) ?? "repeat";
        const misplaced = (mode === "order" ? ["runs"] : ["seeds", "maxProbes", "pollutionTableId", "changesDeployed"])
          .filter((name) => params[name] !== undefined);
        if (misplaced.length > 0) {
          throw new BcDevError("INVALID_ARGUMENT", `${misplaced.join(", ")} cannot be used with mode '${mode}'`, "validation");
        }
        if (params["changesDeployed"] !== undefined && params["pollutionTableId"] === undefined) {
          throw new BcDevError("INVALID_ARGUMENT", "changesDeployed is only valid together with pollutionTableId", "validation");
        }
        claimTestRun(state);
        try {
          if (mode === "order") return await runOrderOrchestration(params, state, deps, context?.signal, context?.progress);
          const { config, authorization, project } = resolve(params, deps);
          const plan = params["codeunits"] as Array<{ id: number; methods?: string[] }>;
          const runsRequested = (params["runs"] as number | undefined) ?? 3;
          await requireTestRunningSupport(config, authorization, deps);
          const runs: RunTestsResult[] = [];
          let cancellationObserved = false;
          const clientCancelled = () => context?.signal?.aborted === true;
          for (let index = 0; index < runsRequested; index++) {
            if (clientCancelled()) {
              cancellationObserved = true;
              break;
            }
            let result: RunTestsResult;
            try {
              result = await new TestRunnerClient(deps.hubFactory).run(
                config,
                authorization,
                plan,
                { company: params["company"] as string | undefined },
              );
            } catch (error) {
              const detail = redactAuthorization(error instanceof Error ? error.message : String(error));
              result = {
                results: [],
                runAborted: true,
                abortReason: `Attempt ${index + 1} failed before a complete server result: ${detail}`,
              };
            }
            enrichTestRun(result);
            runs.push(result);
            context?.progress?.(runs.length, runsRequested, `run ${runs.length}/${runsRequested} ${result.runAborted ? "aborted" : "finished"}`);
            if (result.runAborted === true) break;
            if (clientCancelled() && index + 1 < runsRequested) {
              cancellationObserved = true;
              break;
            }
          }
          await mapOrchestrationSources(runs, project, deps);
          const analysis = analyzeTestOrchestration(plan, runs, runsRequested);
          if (cancellationObserved) {
            analysis.warnings.push(
              "Client cancellation was observed between attempts; no later attempt was started. An active server run is never cancelled by this check.",
            );
          }
          return {
            mode: "repeat" as const,
            ...analysis,
            runs: runs.map((run, index) => ({ ...run, run: index + 1 })),
          };
        } finally {
          state.testRunActive = false;
        }
      },
    },
  ];
}
