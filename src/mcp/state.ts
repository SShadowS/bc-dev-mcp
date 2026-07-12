import type { AlObjectIndex } from "../core/al-objects";
import type { AuthorizationProvider } from "../core/authorization";
import type { DebuggerClient } from "../core/hubs/debugger-hub";
import type { BreakpointSpec, ConnectionConfig, DebuggerEvent, RunTestsResult } from "../core/types";

const QUEUE_CAP = 100;

export interface ProfileHandle {
  debuggingContext: string;
  affinityCookie: string | null;
  attachKind: string;
  snapshotPort: number;
  config: ConnectionConfig;
  authorization: AuthorizationProvider;
  startedAt: string;
  kind: "sampling" | "instrumentation";
}

export class DebugSession {
  breakpoints = new Map<number, BreakpointSpec>();
  lastTestRun: RunTestsResult | null = null;
  droppedEvents = 0; // events discarded at QUEUE_CAP, cumulative for the session
  private queue: DebuggerEvent[] = [];
  private waiter: ((e: DebuggerEvent | { timedOut: true }) => void) | null = null;

  constructor(
    public readonly client: DebuggerClient,
    public readonly index: AlObjectIndex,
  ) {}

  get queueLength(): number {
    return this.queue.length;
  }

  push(e: DebuggerEvent): void {
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
  testRunActive = false;
  profile: ProfileHandle | null = null;
}
