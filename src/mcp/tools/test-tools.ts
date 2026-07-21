import { z } from "zod";
import { resolve as resolvePath } from "node:path";
import { AlObjectIndex, discoverTests } from "../../core/al-objects";
import { TestRunnerClient } from "../../core/hubs/test-runner-hub";
import { fetchServerInfo } from "../../core/server-info";
import type { CoverageMode } from "../../core/types";
import { enrichTestRun, mapTestRunSources, testRunNeedsSourceMapping } from "../../core/agent-results";
import type { ServerState } from "../state";
import { claimTestRun, codeunitsShape, connectionShape, requireTestRunningSupport, resolve, runTestsOutputSchema, type ToolDefinition, type ToolDeps } from "./shared";

const indexByDeps = new WeakMap<ToolDeps, Map<string, Promise<AlObjectIndex>>>();

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
      description: "Run AL tests on the BC server. Per-method pass/fail/skip with duration and failure output; optional code coverage.",
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
      },
      handler: async (params) => {
        claimTestRun(state);
        try {
          const { config, authorization, project } = resolve(params, deps);
          await requireTestRunningSupport(config, authorization, deps);
          const result = await new TestRunnerClient(deps.hubFactory).run(
            config,
            authorization,
            params["codeunits"] as Array<{ id: number; methods?: string[] }>,
            { company: params["company"] as string | undefined, coverage: params["coverage"] as CoverageMode | undefined },
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
          return result;
        } finally {
          state.testRunActive = false;
        }
      },
    },
  ];
}
