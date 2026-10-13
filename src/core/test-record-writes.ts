import type { AuthorizationProvider } from "./authorization";
import { DebuggerClient } from "./hubs/debugger-hub";
import type { HubFactory } from "./hubs/signalr-base";
import { TestRunnerClient } from "./hubs/test-runner-hub";
import {
  RecordWriteCollector,
  type RecordWriteCollectorOptions,
  type RecordWriteReport,
  type RecordWriteUnresolvedGroup,
  type RecordWriteWriterGroup,
} from "./record-write-triage";
import type { CodeunitTestGroup, ConnectionConfig, RunTestsResult, StackFrameInfo } from "./types";

const CODEUNIT_OBJECT_TYPE = 5;

/** The test-codeunit frame that (transitively) issued a write: the outermost frame in a planned codeunit. */
export interface TestMethodFrame {
  codeunitId: number;
  method: string;
  frameIndex: number;
}

export type TestBoundWriterGroup = RecordWriteWriterGroup & { testMethod: TestMethodFrame | null };
export type TestBoundUnresolvedGroup = RecordWriteUnresolvedGroup & { testMethod: TestMethodFrame | null };

export interface TestRunRecordWrites {
  testRun: RunTestsResult;
  writes: Omit<RecordWriteReport, "writers" | "unresolved"> & {
    writers: TestBoundWriterGroup[];
    unresolved: TestBoundUnresolvedGroup[];
  };
}

export interface TestRunRecordWritesOptions {
  hubFactory: HubFactory;
  config: ConnectionConfig;
  authorization: AuthorizationProvider;
  plan: CodeunitTestGroup[];
  company?: string;
  tableId: number;
  includeTemporary?: boolean;
  changesDeployed?: boolean;
  maxObservedWrites?: number;
  localSource: RecordWriteCollectorOptions["localSource"];
  localFile: RecordWriteCollectorOptions["localFile"];
}

/**
 * Stack frames are innermost-first and the test method is the outermost planned-codeunit
 * frame (helpers in the test codeunit sit above it).
 * WIRE: live BC28 break stacks during a debuggingContext-bound run end at the test method;
 * no runner-codeunit frame appears below it (2026-10-13, scripts/e2e.md #38).
 */
export function findTestMethodFrame(stack: StackFrameInfo[], plan: CodeunitTestGroup[]): TestMethodFrame | null {
  const planned = new Set(plan.map((group) => group.id));
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i]!;
    if (frame.objectType === CODEUNIT_OBJECT_TYPE && planned.has(frame.objectId)) {
      return { codeunitId: frame.objectId, method: frame.methodName, frameIndex: i };
    }
  }
  return null;
}

/**
 * Arm a record-write collector on a fresh debugger connection, run the plan bound to it via
 * debuggingContext, then finish the capture. The capture is always finished (debugger
 * released and stopped) even when the test run throws.
 */
export async function runTestsWithRecordWrites(opts: TestRunRecordWritesOptions): Promise<TestRunRecordWrites> {
  const client = new DebuggerClient(opts.hubFactory);
  const collector = new RecordWriteCollector({
    tableId: opts.tableId,
    changesDeployed: opts.changesDeployed ?? false,
    maxObservedWrites: opts.maxObservedWrites ?? 500,
    client,
    localSource: opts.localSource,
    localFile: opts.localFile,
  });
  client.onEvent = (event) => collector.onEvent(event);
  try {
    await client.connect(opts.config, opts.authorization, {
      breakOnError: false,
      breakOnRecordWrite: opts.includeTemporary ? "all" : "nonTemporary",
      skipSystemTriggers: false,
    });
  } catch (error) {
    await client.stop().catch(() => {});
    throw error;
  }

  let testRun: RunTestsResult;
  try {
    // WIRE: Initialize(company, debuggingContext=<DebuggerHub connectionId>, ...) binds the test
    // session to that debugger even though Attach used the default WebClient break-on-next,
    // so record-write breaks fire in test code (live BC28 2026-10-13, scripts/e2e.md #38).
    testRun = await new TestRunnerClient(opts.hubFactory).run(opts.config, opts.authorization, opts.plan, {
      company: opts.company,
      debuggingContext: client.connectionId ?? "",
    });
  } catch (error) {
    await collector.finish().catch(() => {});
    throw error;
  }
  const report = await collector.finish();
  return {
    testRun,
    writes: {
      ...report,
      writers: report.writers.map((group) => ({ ...group, testMethod: findTestMethodFrame(group.stack, opts.plan) })),
      unresolved: report.unresolved.map((group) => ({ ...group, testMethod: findTestMethodFrame(group.stack, opts.plan) })),
    },
  };
}
