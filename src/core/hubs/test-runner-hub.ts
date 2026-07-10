import type {
  CodeunitTestGroup,
  ConnectionConfig,
  CoverageEntry,
  CoverageMode,
  RunTestsResult,
  TestMethodResult,
} from "../types";
import { COVERAGE_MODE_WIRE, TEST_STATUS_FROM_WIRE } from "../types";
import { basicAuthHeader, hubUrl } from "../urls";
import type { HubFactory } from "./signalr-base";
import { buildHubQuery, normalizeKeys } from "./signalr-base";

export interface RunOptions {
  company?: string;
  coverage?: CoverageMode;
  debuggingContext?: string;
}

interface WireCoverageForTest {
  methodId: number;
  applicationObjectId: number;
  coveredProcedures?: Array<{ methodId: number; objectId: number; objectType: number }>;
}

export class TestRunnerClient {
  constructor(private factory: HubFactory) {}

  async run(config: ConnectionConfig, plan: CodeunitTestGroup[], opts: RunOptions = {}): Promise<RunTestsResult> {
    const hub = this.factory(hubUrl(config, "TestRunnerHub"), {
      authHeader: basicAuthHeader(config),
      queryParams: buildHubQuery(config),
    });

    const results: TestMethodResult[] = [];
    const coverage: CoverageEntry[] = [];
    let groupIndex = 0;
    let settled = false;

    return await new Promise<RunTestsResult>((resolvePromise) => {
      const finish = async (aborted?: string) => {
        if (settled) return;
        settled = true;
        const result: RunTestsResult = { results };
        if (opts.coverage && opts.coverage !== "none") result.coverage = coverage;
        if (aborted !== undefined) {
          result.runAborted = true;
          result.abortReason = aborted;
        }
        // Always release the connection — stop() on an already-closed hub is a no-op.
        await hub.stop().catch(() => {});
        resolvePromise(result);
      };

      const runNextGroup = async () => {
        const group = plan[groupIndex];
        if (!group) {
          await finish();
          return;
        }
        groupIndex++;
        // WIRE: RunTests(codeunitId, testMethods[]) (lmt-decomp HubBasedTestRunnerService.RunTestInternal)
        await hub.invoke("RunTests", group.id, group.methods ?? []).catch((err) => finish(String(err)));
      };

      hub.on("TestCompleted", (...args) => {
        const [codeunitId, method, status, output, duration] = args as [number, string, number, string, number];
        results.push({
          codeunitId,
          method,
          status: TEST_STATUS_FROM_WIRE[status] ?? "failed",
          durationMs: duration,
          output: output ?? "",
        });
      });

      hub.on("TestRunCompleted", (...args) => {
        const payload = normalizeKeys<{ tests?: WireCoverageForTest[] }>(args[0] ?? {});
        for (const t of payload.tests ?? []) {
          coverage.push({
            testObjectId: t.applicationObjectId,
            testMethodId: t.methodId,
            coveredProcedures: (t.coveredProcedures ?? []).map((p) => ({
              objectType: p.objectType,
              objectId: p.objectId,
              methodId: p.methodId,
            })),
          });
        }
        void runNextGroup();
      });

      hub.onclose((err) => {
        if (!settled) void finish(`Hub connection closed: ${err ? String(err) : "unknown reason"}`);
      });

      // Server-invoked notifications we don't consume — registered to keep the connection log clean (live E2E 2026-07-03).
      hub.on("TestStarted", () => {});
      hub.on("RuntimeInitialized", () => {});
      hub.on("HubConnected", () => {});
      hub.on("LogServerMessage", () => {});
      hub.on("LogServerInfoMessage", () => {});
      hub.on("SendMessage", () => {});

      void (async () => {
        try {
          await hub.start();
          // WIRE: Initialize(company, debuggingContext, coverageMode) (lmt-decomp HubBasedTestRunnerService.Initialize)
          await hub.invoke("Initialize", opts.company ?? "", opts.debuggingContext ?? "", COVERAGE_MODE_WIRE[opts.coverage ?? "none"]);
          await runNextGroup();
        } catch (err) {
          await finish(String(err));
        }
      })();
    });
  }
}
