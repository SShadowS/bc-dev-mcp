import { z } from "zod";
import { AlObjectIndex, discoverTests } from "../../core/al-objects";
import { TestRunnerClient } from "../../core/hubs/test-runner-hub";
import { fetchServerInfo } from "../../core/server-info";
import type { CoverageMode } from "../../core/types";
import type { ServerState } from "../state";
import { codeunitsShape, connectionShape, resolve, runTestsOutputSchema, type ToolDefinition, type ToolDeps } from "./shared";

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
        if (state.testRunActive) throw new Error("A test run is already running — wait for it to finish");
        const { config, authorization, project } = resolve(params, deps);
        state.testRunActive = true;
        try {
          const result = await new TestRunnerClient(deps.hubFactory).run(
            config,
            authorization,
            params["codeunits"] as Array<{ id: number; methods?: string[] }>,
            { company: params["company"] as string | undefined, coverage: params["coverage"] as CoverageMode | undefined },
          );
          if (result.coverage?.length) {
            const index = await AlObjectIndex.build(project);
            for (const entry of result.coverage) {
              for (const proc of entry.coveredProcedures) {
                proc.file = index.byId(proc.objectType, proc.objectId)?.file;
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
