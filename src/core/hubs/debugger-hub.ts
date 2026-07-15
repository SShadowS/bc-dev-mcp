import type { ConnectionConfig, DebuggerEvent, StackFrameInfo } from "../types";
import type { AuthorizationProvider } from "../authorization";
import { redactAuthorization } from "../redaction";
import { hubUrl } from "../urls";
import type { HubFactory, HubProxy } from "./signalr-base";
import { buildHubQuery, normalizeKeys } from "./signalr-base";

export interface DebugAttachOptions {
  breakOnNext?: "WebClient" | "WebServiceClient" | "Background";
  sessionId?: number;
  userId?: string;
  breakOnError?: boolean;
  breakOnRecordWrite?: boolean;
  skipSystemTriggers?: boolean;
}

// WIRE: BreakOnNext enum order (esp-decomp BreakOnNext.cs): WebServiceClient=0, WebClient=1, Background=2
const BREAK_ON_NEXT_WIRE = { WebServiceClient: 0, WebClient: 1, Background: 2 } as const;

export type StepAction = "continue" | "stepOver" | "stepInto" | "stepOut";
// WIRE: BreakpointResponse enum (tw-decomp BreakpointResponse.cs): Continue=0, StepOver=1, StepIn=2, StepOut=3
const STEP_WIRE: Record<StepAction, number> = { continue: 0, stepOver: 1, stepInto: 2, stepOut: 3 };

export interface VariableNode {
  name: string;
  typeName: string;
  summary: string;
  hasChildren: boolean;
  children?: VariableNode[];
}

interface WireLocalNode {
  name: string;
  // WIRE: server sends typeName null on synthetic nodes (e.g. a RecordRef's "Fields")
  // and "" on sibling meta-nodes (live BC28 2026-07-03); coerced to "" in toVariableNode.
  typeName: string | null;
  summary: string | null;
  hasChildren: boolean;
  children?: WireLocalNode[] | null;
}

interface WireStackFrame {
  objectId: { objectType: number; objectNumber: number };
  objectName: string;
  methodName: string;
  statementSpan?: { from?: { line: number; column: number } };
}

interface WireNstSessionInfo {
  sessionId?: unknown;
  hostId?: unknown;
}

export interface NstSessionInfo {
  sessionId: number;
  hostId: string | null;
}

interface WireAttachTarget {
  SessionId: number;
  UserId: string | null;
}

function normalizeAttachTarget(opts: DebugAttachOptions): WireAttachTarget {
  if (opts.sessionId !== undefined && opts.userId !== undefined) {
    throw new Error("sessionId and userId are mutually exclusive");
  }
  if (opts.sessionId !== undefined) {
    if (typeof opts.sessionId !== "number" || !Number.isInteger(opts.sessionId) || opts.sessionId <= 0) {
      throw new Error("sessionId must be a positive integer");
    }
    return { SessionId: opts.sessionId, UserId: null };
  }
  if (opts.userId !== undefined) {
    if (typeof opts.userId !== "string" || opts.userId.trim() === "") {
      throw new Error("userId must be a nonblank string");
    }
    return { SessionId: -1, UserId: opts.userId.trim() };
  }
  return { SessionId: -1, UserId: null };
}

function normalizeNstSessionInfo(value: unknown): NstSessionInfo {
  const info = normalizeKeys<WireNstSessionInfo>(value ?? {});
  if (typeof info.sessionId !== "number" || !Number.isInteger(info.sessionId) || info.sessionId <= 0) {
    throw new Error("Business Central returned an invalid NST session id");
  }
  if (info.hostId !== undefined && info.hostId !== null && typeof info.hostId !== "string") {
    throw new Error("Business Central returned an invalid NST host id");
  }
  return { sessionId: info.sessionId, hostId: typeof info.hostId === "string" && info.hostId.trim() !== "" ? info.hostId.trim() : null };
}

function errorDetail(error: unknown): string {
  return redactAuthorization(error instanceof Error ? error.message : String(error));
}

function toVariableNode(n: WireLocalNode): VariableNode {
  return {
    name: n.name,
    typeName: n.typeName ?? "",
    summary: n.summary ?? "",
    hasChildren: n.hasChildren,
    children: n.children ? n.children.map(toVariableNode) : undefined,
  };
}

export class DebuggerClient {
  private hub: HubProxy | null = null;
  private pendingDebugOptions: Record<string, unknown> | null = null;
  private bindingHandled = false;
  private userAttachFatal: string | null = null;
  private userAttachFailed = false;
  private sessionBoundReported = false;
  onEvent?: (e: DebuggerEvent) => void;

  constructor(private factory: HubFactory) {}

  get connectionId(): string | null {
    return this.hub?.connectionId ?? null;
  }

  async connect(config: ConnectionConfig, authorization: AuthorizationProvider, opts: DebugAttachOptions = {}): Promise<void> {
    const target = normalizeAttachTarget(opts);
    const authHeader = await authorization.getAuthorizationHeader();
    const hub = this.factory(hubUrl(config, "DebuggerHub"), {
      authHeader,
      queryParams: buildHubQuery(config, authHeader),
    });
    this.hub = hub;
    this.bindingHandled = false;
    let attachInFlight = false;
    let exactAttachFatal: string | null = null;
    this.userAttachFatal = null;
    this.userAttachFailed = false;
    this.sessionBoundReported = false;
    // Set before Attach: an exact live session can bind before the Attach invocation resolves.
    this.pendingDebugOptions = {
      // WIRE: DebugAdapterConfigurationDone(DebugOptions) (esp-decomp HubBasedDebuggerService.ConfigurationDoneAsync / DebugOptions.cs)
      // BreakOnErrorBehaviour: Unspecified=0, None=1, All=2, ExcludeTry=3
      // BreakOnRecordWriteBehaviour: Unspecified=0, None=1, All=2, ExcludeTemporary=3
      // (esp-decomp BreakOnRecordWriteBehaviour.cs)
      BreakOnError: opts.breakOnError ?? true,
      BreakOnErrorBehaviour: (opts.breakOnError ?? true) ? 2 : 1,
      BreakOnRecordWrite: opts.breakOnRecordWrite ?? false,
      BreakOnRecordWriteBehaviour: (opts.breakOnRecordWrite ?? false) ? 2 : 1,
      SkipSystemTriggers: opts.skipSystemTriggers ?? true,
      EnableSqlInformationDebugger: false,
      EnableLongRunningSqlStatements: false,
      LongRunningSqlStatementsThreshold: 0,
      NumberOfSqlStatements: 0,
    };

    hub.on("IsAlive", () => {
      void hub.invoke("AcknowledgeIsAlive").catch(() => {});
    });
    hub.on("Break", (...args) => {
      const objectId = normalizeKeys<{ objectType: number; objectNumber: number }>(args[0]);
      if (this.userAttachFailed) return;
      const frames = normalizeKeys<WireStackFrame[]>(args[1] ?? []);
      const errorMessage = (args[2] as string | null) || undefined;
      // WIRE: server lines are 0-based (live BC28 2026-07-03: wire line 9 = editor line 10); tool surface is 1-based (editor convention), converted here.
      const stack: StackFrameInfo[] = frames.map((f) => ({
        objectType: f.objectId.objectType,
        objectId: f.objectId.objectNumber,
        objectName: f.objectName,
        methodName: f.methodName,
        line: (f.statementSpan?.from?.line ?? -1) + 1,
      }));
      this.onEvent?.({
        kind: "break",
        objectType: objectId.objectType,
        objectId: objectId.objectNumber,
        errorMessage,
        line: stack[0]?.line,
        stack,
      });
    });
    hub.on("OnDetachedFromConnection", (...args) => {
      if (this.hub === hub) this.onEvent?.({ kind: "detached", terminateSession: Boolean(args[0]) });
    });
    hub.on("OnFatalDebuggerException", (...args) => {
      const message = String(args[0] ?? "");
      // Live Sandbox BC28 can signal an unavailable exact session here immediately before the
      // Attach invocation resolves. Capture that synchronous attach outcome so the caller's
      // existing rollback path runs; later fatal events remain normal lifecycle events.
      if (attachInFlight && opts.sessionId !== undefined) {
        exactAttachFatal = message;
        return;
      }
      if (attachInFlight && opts.userId !== undefined) {
        this.userAttachFatal = message;
        return;
      }
      if (opts.userId !== undefined && !this.sessionBoundReported && !this.userAttachFailed) {
        void this.failUserAttach(hub, message);
        return;
      }
      if (this.userAttachFailed) return;
      this.onEvent?.({ kind: "fatal", message });
    });
    hub.onclose((err) => {
      if (this.hub === hub) this.hub = null;
      if (err) this.onEvent?.({ kind: "fatal", message: `Hub connection closed: ${String(err)}` });
    });
    // Server-invoked notifications we don't consume — registered to keep the connection log clean (live E2E 2026-07-03).
    hub.on("LogServerMessage", () => {});
    hub.on("LogServerInfoMessage", () => {});
    hub.on("SendMessage", () => {});
    // WIRE: DebugAdapterConfigurationDone is only accepted after the debugger binds to a session —
    // sending it right after Attach throws (live E2E 2026-07-03, BC28). Which callback signals the
    // bind is build-dependent: BC28 live fires HubConnected, not OnAttachedToConnection (round 3,
    // 2026-07-03), even though OnAttachedToConnection is the callback named in the decompiled
    // contract. Handle both, first one wins.
    hub.on("HubConnected", () => this.handleSessionBound(hub));
    hub.on("OnAttachedToConnection", () => this.handleSessionBound(hub));

    try {
      await hub.start();
      // WIRE: Attach(AttachOptions{BreakOnNextClient, SessionId, UserId}) (esp-decomp HubBasedDebuggerService.Attach / AttachOptions.cs)
      // WIRE: SessionId -1 = break-on-next, no specific session (esp-decomp InitializeDebugAdapterRequest.cs AttachOptions()); 0 is rejected by the server (live E2E 2026-07-03)
      // WIRE: UserId null = no user filter. With SessionId -1, a non-null UserId filters the next matching session.
      // WIRE: A positive SessionId selects an existing NST session and takes precedence over BreakOnNextClient.
      try {
        attachInFlight = true;
        await hub.invoke("Attach", {
          BreakOnNextClient: BREAK_ON_NEXT_WIRE[opts.breakOnNext ?? "WebClient"],
          ...target,
        });
      } catch (error) {
        if (opts.sessionId !== undefined) {
          throw new Error(
            `Unable to attach to NST session ${opts.sessionId}. Verify that the session is active and accessible to the current account. Business Central: ${errorDetail(error)}`,
            { cause: error },
          );
        }
        throw error;
      } finally {
        attachInFlight = false;
      }
      if (exactAttachFatal !== null) {
        throw new Error(
          `Unable to attach to NST session ${opts.sessionId}. Verify that the session is active and accessible to the current account. Business Central: ${errorDetail(exactAttachFatal)}`,
        );
      }
      if (this.userAttachFatal !== null) throw this.userAttachError(this.userAttachFatal);
    } catch (err) {
      this.hub = null;
      this.pendingDebugOptions = null;
      await hub.stop().catch(() => {});
      throw err;
    }
  }

  private userAttachError(message: string): Error {
    return new Error(
      `Unable to bind the requested user-filtered session. Verify that the user exists and is accessible to the current account. Business Central: ${errorDetail(message)}`,
    );
  }

  private async failUserAttach(hub: HubProxy, message: string): Promise<void> {
    if (this.userAttachFailed) return;
    this.userAttachFailed = true;
    this.pendingDebugOptions = null;
    if (this.hub === hub) this.hub = null;
    await hub.invoke("StopDebugging").catch(() => {});
    await hub.stop().catch(() => {});
    this.onEvent?.({ kind: "fatal", message: this.userAttachError(message).message });
  }

  private requireHub(): HubProxy {
    if (!this.hub) throw new Error("Debugger not connected — call connect() first");
    return this.hub;
  }

  private handleSessionBound(hub: HubProxy): void {
    if (this.hub !== hub || this.bindingHandled) return;
    this.bindingHandled = true;
    const options = this.pendingDebugOptions;
    this.pendingDebugOptions = null;
    // WIRE: session bind is signalled by HubConnected on BC28 (live E2E 2026-07-03);
    // OnAttachedToConnection exists in the decompiled contract but was never observed live —
    // handle both, first one wins.
    void this.finishSessionBinding(hub, options);
  }

  private async finishSessionBinding(hub: HubProxy, options: Record<string, unknown> | null): Promise<void> {
    if (options) await hub.invoke("DebugAdapterConfigurationDone", options).catch(() => {});
    if (this.hub !== hub) return;
    if (this.userAttachFatal !== null || this.userAttachFailed) {
      if (this.userAttachFatal !== null) await this.failUserAttach(hub, this.userAttachFatal);
      return;
    }
    try {
      // WIRE: GetNstSessionInfo() -> {SessionId, HostId} (live BC28 wire probe 2026-07-04).
      const info = normalizeNstSessionInfo(await hub.invoke<unknown>("GetNstSessionInfo"));
      if (this.userAttachFatal !== null || this.userAttachFailed) {
        if (this.userAttachFatal !== null) await this.failUserAttach(hub, this.userAttachFatal);
      } else if (this.hub === hub) {
        this.sessionBoundReported = true;
        this.onEvent?.({ kind: "sessionBound", ...info });
      }
    } catch (error) {
      if (this.hub === hub) {
        this.onEvent?.({
          kind: "sessionBound",
          sessionId: null,
          hostId: null,
          warning: `Debugger bound, but NST session identity could not be read: ${errorDetail(error)}`,
        });
      }
    }
  }

  async addBreakpoint(objectType: number, objectId: number, line: number, condition?: string): Promise<number> {
    // WIRE: AddBreakpoint(ApplicationObjectIdWrapper, SourcePosition, condition) -> BreakpointDefinition (tw-decomp)
    // WIRE: server lines are 0-based (live BC28 2026-07-03: wire line 9 = editor line 10); tool surface is 1-based (editor convention), converted here.
    const def = await this.requireHub().invoke<unknown>(
      "AddBreakpoint",
      { ObjectType: objectType, ObjectNumber: objectId },
      { Line: line - 1, Column: 0 },
      condition ?? "",
    );
    const parsed = normalizeKeys<{ breakpointId?: number }>(def ?? {});
    if (typeof parsed.breakpointId !== "number") {
      throw new Error("Server did not return a breakpoint id — breakpoint was not set");
    }
    return parsed.breakpointId;
  }

  async removeBreakpoint(breakpointId: number): Promise<void> {
    await this.requireHub().invoke("RemoveBreakpoint", breakpointId);
  }

  async updateBreakpoint(breakpointId: number, condition: string): Promise<void> {
    await this.requireHub().invoke("UpdateBreakpoint", breakpointId, condition);
  }

  async step(action: StepAction): Promise<void> {
    await this.requireHub().invoke("SetBreakpointResponse", STEP_WIRE[action]);
  }

  async getVariables(frameId: number): Promise<VariableNode[]> {
    const nodes = await this.requireHub().invoke<unknown>("GetVariables", frameId);
    return normalizeKeys<WireLocalNode[]>(nodes ?? []).map(toVariableNode);
  }

  async expandNode(frameId: number, path: string): Promise<VariableNode[]> {
    const nodes = await this.requireHub().invoke<unknown>("ExpandNode", frameId, path);
    return normalizeKeys<WireLocalNode[]>(nodes ?? []).map(toVariableNode);
  }

  async expandGlobals(frameId: number): Promise<VariableNode[]> {
    const nodes = await this.requireHub().invoke<unknown>("ExpandGlobals", frameId);
    return normalizeKeys<WireLocalNode[]>(nodes ?? []).map(toVariableNode);
  }

  async evalWatch(frameId: number, expression: string): Promise<VariableNode | null> {
    // WIRE: GetWatchNode(frameId, expression, WatchOption None=0) (esp-decomp HubBasedDebuggerService.GetWatchNodeAsync)
    const node = await this.requireHub().invoke<unknown>("GetWatchNode", frameId, expression, 0);
    return node ? toVariableNode(normalizeKeys<WireLocalNode>(node)) : null;
  }

  async stop(): Promise<void> {
    const hub = this.hub;
    this.hub = null;
    this.pendingDebugOptions = null;
    this.userAttachFatal = null;
    this.userAttachFailed = false;
    this.sessionBoundReported = false;
    if (hub) {
      await hub.invoke("StopDebugging").catch(() => {});
      await hub.stop().catch(() => {});
    }
  }
}
