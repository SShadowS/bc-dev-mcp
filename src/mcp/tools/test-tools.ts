import { z } from "zod";
import { resolve as resolvePath } from "node:path";
import { AlObjectIndex, discoverTests } from "../../core/al-objects";
import { TestRunnerClient } from "../../core/hubs/test-runner-hub";
import { fetchServerInfo } from "../../core/server-info";
import type { CoverageMode, RunTestsResult } from "../../core/types";
import { enrichTestRun, mapTestRunSources, testRunNeedsSourceMapping } from "../../core/agent-results";
import { AlProcedureDiscoveryCache, discoverAlProcedureIdentities } from "../../core/al-procedures";
import { analyzeCoverageGaps } from "../../core/coverage-gaps";
import { BcDevError } from "../../core/agent-errors";
import { analyzeTestOrchestration } from "../../core/test-orchestration";
import { redactAuthorization } from "../../core/redaction";
import type { ServerState } from "../state";
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

const testOrchestrationOutputSchema = z.object({
  runsRequested: z.number().int().describe("Number of sequential runs requested"),
  runsAttempted: z.number().int().describe("Number of run-attempt envelopes retained, including an aborted final attempt"),
  complete: z.boolean().describe("true only when all requested runs completed without abort and every identity has one concrete result in each run"),
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
});

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
      description: "Scan the AL project for test codeunits ([Test] methods). Filesystem only — no server needed.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      schema: { project: connectionShape.project },
      outputSchema: z.object({
        tests: z.array(
          z.looseObject({
            codeunitId: z.number(),
            name: z.string(),
            file: z.string(),
            methods: z.array(z.string()),
          }),
        ),
      }),
      handler: async (params) => {
        return { tests: await discoverTests((params["project"] as string | undefined) ?? deps.cwd) };
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
        changesDeployed: z.literal(true).optional().describe(
          "Explicit assertion that the current working-tree versions of changed AL objects are deployed to this server. Required for covered/uncovered classifications because procedure coverage does not carry an app or source hash.",
        ),
      },
      handler: async (params) => {
        claimTestRun(state);
        try {
          const { config, authorization, project } = resolve(params, deps);
          const coverageAgainst = params["coverageAgainst"] as string | undefined;
          const changesDeployed = params["changesDeployed"] === true;
          const requestedCoverage = params["coverage"] as CoverageMode | undefined;
          if (coverageAgainst !== undefined && requestedCoverage !== undefined && requestedCoverage !== "procedure") {
            throw new BcDevError(
              "INVALID_ARGUMENT",
              "coverageAgainst requires coverage: 'procedure' (or omit coverage to select procedure coverage automatically)",
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
          const coverageMode: CoverageMode | undefined = coverageAgainst === undefined ? requestedCoverage : "procedure";
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
          const result = await new TestRunnerClient(deps.hubFactory).run(
            config,
            authorization,
            params["codeunits"] as Array<{ id: number; methods?: string[] }>,
            { company: params["company"] as string | undefined, coverage: coverageMode },
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
          return result;
        } finally {
          state.testRunActive = false;
        }
      },
    },
    {
      name: "bcdev_test_orchestrate",
      title: "Repeat and compare AL tests",
      description:
        "Run one AL test selection sequentially 2–20 times, retain every enriched attempt, diff adjacent passed/failed sets, and flag flaky or incomplete method outcomes. Non-rolled-back test side effects repeat on every attempt.",
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
          .describe("Number of sequential runs to compare (default 3; minimum 2; maximum 20)"),
      },
      handler: async (params, context) => {
        claimTestRun(state);
        try {
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
