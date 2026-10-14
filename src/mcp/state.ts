import { randomUUID } from "node:crypto";
import type { AlObjectIndex } from "../core/al-objects";
import type { AuthorizationProvider } from "../core/authorization";
import { BcDevError } from "../core/agent-errors";
import type { DebuggerClient } from "../core/hubs/debugger-hub";
import type { StaticWritersResult } from "../core/alsem-writes";
import type { RecordWriteCollector } from "../core/record-write-triage";
import type { ArmedSnappoint } from "../core/snapshot/snappoints";
import type { BreakpointSpec, ConnectionConfig, DebuggerEvent, RunTestsResult } from "../core/types";

const QUEUE_CAP = 100;

export type CapturePhase = "attaching" | "armed" | "finishing" | "uncertain" | "testing";

interface CaptureBase {
  debuggingContext: string;
  affinityCookie: string | null;
  attachKind: string;
  snapshotPort: number;
  config: ConnectionConfig;
  authorization: AuthorizationProvider;
  startedAt: string;
  /** Identity of this claim: a finishing call clears the slot only if it still holds its own token. */
  token: symbol;
  phase: CapturePhase;
}

export interface ProfileCapture extends CaptureBase {
  captureKind: "profile";
  /** Opaque client-facing handle (MCP 2026-07-28 statelessness): returned by bcdev_profile_start. */
  profileId: string;
  profileKind: "sampling" | "instrumentation";
}

export interface SnapshotCapture extends CaptureBase {
  captureKind: "snapshot";
  /** Opaque client-facing handle returned by bcdev_snapshot_start. */
  snapshotId: string;
  snappoints: ArmedSnappoint[];
  verbosity: "snappoint" | "full";
}

/** The tenant allows one snapshot-debugger capture at a time, profile or snapshot. */
export type CaptureState = ProfileCapture | SnapshotCapture;

/** PROFILE_ACTIVE for a start/poll/finish that collides with the capture already holding the slot. */
export function captureActiveError(active: CaptureState, starting: "profile" | "snapshot"): BcDevError {
  const owner = active.captureKind;
  const ownerFinishTool = owner === "profile" ? "bcdev_profile_finish" : "bcdev_snapshot_finish";
  return new BcDevError(
    "PROFILE_ACTIVE",
    `A ${owner} capture is already active — call ${ownerFinishTool} before using the ${starting} tools`,
    "state",
    false,
    {
      capture: owner,
      ownerFinishTool,
      phase: active.phase,
      ...(active.captureKind === "profile" ? { profileId: active.profileId } : { snapshotId: active.snapshotId }),
    },
  );
}

export class DebugSession {
  /** Opaque client-facing handle (MCP 2026-07-28 statelessness): returned by bcdev_debug_attach. */
  readonly id = randomUUID();
  breakpoints = new Map<number, BreakpointSpec>();
  lastTestRun: RunTestsResult | null = null;
  droppedEvents = 0; // events discarded at QUEUE_CAP, cumulative for the session
  private queue: DebuggerEvent[] = [];
  private waiter: ((e: DebuggerEvent | { timedOut: true }) => void) | null = null;
  private boundIdentity: { sessionId: number; hostId: string } | null = null;
  private paused = false;
  private executionRevision = 0;

  constructor(
    public readonly client: DebuggerClient,
    public readonly index: AlObjectIndex,
    public readonly debugSlotToken?: symbol,
  ) {}

  get queueLength(): number {
    return this.queue.length;
  }

  get nativeDebugIdentity(): { sessionId: number; hostId: string } {
    if (!this.paused) {
      throw new BcDevError(
        "DEBUG_SESSION_NOT_PAUSED",
        "The debug session is not paused — wait for a break before using native debugging tools",
        "state",
        false,
        { debugSessionId: this.id },
      );
    }
    if (!this.boundIdentity) {
      throw new BcDevError(
        "DEBUG_SESSION_IDENTITY_UNAVAILABLE",
        "The paused debug session has no confirmed NST session and host identity",
        "state",
        false,
        { debugSessionId: this.id },
      );
    }
    return this.boundIdentity;
  }

  beginResume(): { revision: number; wasPaused: boolean } {
    const wasPaused = this.paused;
    const revision = ++this.executionRevision;
    this.paused = false;
    return { revision, wasPaused };
  }

  rollbackResume(transition: { revision: number; wasPaused: boolean }): void {
    // A Break/detach/fatal callback delivered while the hub invocation was pending owns the
    // newer execution state. Only restore the pre-invocation state when no callback superseded it.
    if (this.executionRevision === transition.revision) {
      this.paused = transition.wasPaused;
    }
  }

  push(e: DebuggerEvent): void {
    if (e.kind === "sessionBound") {
      // Identity lookup is asynchronous after the hub bind callback. A fast workload can
      // deliver Break before sessionBound; enriching that already-paused session must not
      // incorrectly mark it running.
      this.boundIdentity = e.sessionId !== null && e.hostId !== null
        ? { sessionId: e.sessionId, hostId: e.hostId }
        : null;
    } else if (e.kind === "break") {
      this.executionRevision++;
      this.paused = true;
    } else if (e.kind === "detached" || e.kind === "fatal") {
      this.executionRevision++;
      this.paused = false;
      this.boundIdentity = null;
    }
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(e);
      return;
    }
    this.queue.push(e);
    if (this.queue.length > QUEUE_CAP) {
      this.queue.shift();
      this.droppedEvents++;
    }
  }

  async wait(timeoutMs: number): Promise<DebuggerEvent | { timedOut: true }> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.waiter) throw new Error("bcdev_debug_wait already pending — one waiter at a time");
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve({ timedOut: true });
      }, timeoutMs);
      this.waiter = (e) => {
        clearTimeout(timer);
        resolve(e);
      };
    });
  }
}

export class ServerState {
  debug: DebugSession | null = null;
  recordWrites: RecordWriteCollector | null = null;
  recordWriteSlotToken: symbol | null = null;
  /** Opaque client-facing handle for the active record-write capture, returned by bcdev_record_writes_start. */
  recordingId: string | null = null;
  /** al-sem static writer set taken at start (null writers = unavailable); finish diffs it against the observed stacks. */
  recordWriteStatic: {
    project: string;
    tableId: number;
    includeTemporary: boolean;
    tableName: string | null;
    result: StaticWritersResult;
  } | null = null;
  testRunActive = false;
  capture: CaptureState | null = null;
  private debugSlot: { owner: "manual" | "recordWrites"; token: symbol } | null = null;

  get debugOwner(): "manual" | "recordWrites" | null {
    return this.debugSlot?.owner ?? null;
  }

  assertDebugSlotAvailable(): void {
    if (this.debugSlot?.owner === "recordWrites" || (!this.debugSlot && this.recordWrites)) {
      throw new BcDevError(
        "RECORD_WRITE_TRIAGE_ACTIVE",
        "Record-write triage is active — call bcdev_record_writes_status or bcdev_record_writes_finish first",
        "state",
        false,
        { recordingId: this.recordingId },
      );
    }
    if (this.debugSlot || this.debug) {
      throw new BcDevError(
        "DEBUG_SESSION_ACTIVE",
        "Debug session already active — call bcdev_debug_detach first",
        "state",
        false,
        { debugSessionId: this.debug?.id ?? null },
      );
    }
  }

  claimDebugSlot(owner: "manual" | "recordWrites"): symbol {
    this.assertDebugSlotAvailable();
    const token = Symbol(owner);
    this.debugSlot = { owner, token };
    return token;
  }

  releaseDebugSlot(token: symbol): void {
    if (this.debugSlot?.token === token) this.debugSlot = null;
  }
}
