import type { AuthorizationProvider } from "./authorization";
import { DebuggerClient } from "./hubs/debugger-hub";
import type { HubFactory } from "./hubs/signalr-base";
import { TestRunnerClient } from "./hubs/test-runner-hub";
import {
  RecordWriteCollector,
  type RecordWriteCollectorOptions,
  type RecordWriteOperation,
  type RecordWriteReport,
  type RecordWriteSource,
  type RecordWriteTarget,
  type RecordWriteUnresolvedGroup,
  type RecordWriteWriterGroup,
} from "./record-write-triage";
import type { BisectedVictim, BisectOutcome } from "./test-order-bisect";
import { identityKey, type OrchestratedTestIdentity } from "./test-orchestration";
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

/**
 * What the collector saw a suspect do. "writeObserved" = a write statement on the target table
 * broke in that test method. Never "committed": the collector sees the statement, not whether
 * the row persisted, was rolled back, or the write failed.
 */
export type PolluterWriteEvidence = "writeObserved" | "noWriteObserved" | "unknown";

export interface PolluterWriteSuspect extends OrchestratedTestIdentity {
  evidence: PolluterWriteEvidence;
  writes: { operation: RecordWriteOperation; receiver: string; count: number; source: RecordWriteSource }[];
  /** Writes in this method whose statement or receiver could not be resolved to the target table. */
  unresolvedWrites: number;
}

export interface PolluterWriteAttribution extends OrchestratedTestIdentity {
  outcome: BisectOutcome;
  table: RecordWriteTarget;
  /** false = capture truncated/failed: a suspect with no observed write is "unknown", not clean. */
  captureComplete: boolean;
  /** The bisected polluter when found, otherwise its remaining candidates. */
  suspects: PolluterWriteSuspect[];
  /** Writer groups with no planned-codeunit frame (cannot be tied to a test method). */
  unattributedWriteGroups: number;
  note: string;
}

const WRITE_NOTE =
  "Writes are record-write breaks observed in each suspect test method. The collector does not see whether a write committed, was rolled back, or failed.";

/**
 * Pure: join a record-write capture (runTestsWithRecordWrites over the failing order) into the
 * bisect report, per victim: which suspect test methods were observed writing the target table.
 */
export function attributePolluterWrites(
  victims: BisectedVictim[],
  writes: TestRunRecordWrites["writes"],
): PolluterWriteAttribution[] {
  const keyOf = (m: TestMethodFrame | null) => (m ? identityKey(m.codeunitId, m.method) : null);
  return victims.map((victim) => {
    const suspects = (victim.polluter ? [victim.polluter] : victim.remainingCandidates).map((s): PolluterWriteSuspect => {
      const key = identityKey(s.codeunitId, s.method);
      const own = writes.writers.filter((w) => keyOf(w.testMethod) === key);
      const unresolvedWrites = writes.unresolved
        .filter((u) => keyOf(u.testMethod) === key)
        .reduce((n, u) => n + u.count, 0);
      const seen = own.length > 0 || unresolvedWrites > 0;
      return {
        codeunitId: s.codeunitId,
        method: s.method,
        evidence: seen ? "writeObserved" : writes.complete ? "noWriteObserved" : "unknown",
        writes: own.map(({ operation, receiver, count, source }) => ({ operation, receiver, count, source })),
        unresolvedWrites,
      };
    });
    return {
      codeunitId: victim.codeunitId,
      method: victim.method,
      outcome: victim.outcome,
      table: writes.target,
      captureComplete: writes.complete,
      suspects,
      unattributedWriteGroups: writes.writers.filter((w) => !w.testMethod).length,
      note: WRITE_NOTE,
    };
  });
}
