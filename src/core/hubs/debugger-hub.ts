import type { ConnectionConfig, DebuggerEvent, StackFrameInfo } from "../types";
import { basicAuthHeader, hubUrl } from "../urls";
import type { HubFactory, HubProxy } from "./signalr-base";
import { buildHubQuery, normalizeKeys } from "./signalr-base";

export interface DebugAttachOptions {
  breakOnNext?: "WebClient" | "WebServiceClient" | "Background";
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
  onEvent?: (e: DebuggerEvent) => void;

  constructor(private factory: HubFactory) {}

  get connectionId(): string | null {
    return this.hub?.connectionId ?? null;
  }

  async connect(config: ConnectionConfig, opts: DebugAttachOptions = {}): Promise<void> {
    const hub = this.factory(hubUrl(config, "DebuggerHub"), {
      authHeader: basicAuthHeader(config),
      queryParams: buildHubQuery(config),
    });
    this.hub = hub;

    hub.on("IsAlive", () => {
      void hub.invoke("AcknowledgeIsAlive").catch(() => {});
    });
    hub.on("Break", (...args) => {
      const objectId = normalizeKeys<{ objectType: number; objectNumber: number }>(args[0]);
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
      this.onEvent?.({ kind: "detached", terminateSession: Boolean(args[0]) });
    });
    hub.on("OnFatalDebuggerException", (...args) => {
      this.onEvent?.({ kind: "fatal", message: String(args[0] ?? "") });
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
    hub.on("HubConnected", () => this.sendPendingDebugOptions());
    hub.on("OnAttachedToConnection", () => this.sendPendingDebugOptions());

    try {
      await hub.start();
      // WIRE: Attach(AttachOptions{BreakOnNextClient, SessionId, UserId}) (esp-decomp HubBasedDebuggerService.Attach / AttachOptions.cs)
      // WIRE: SessionId -1 = break-on-next, no specific session (esp-decomp InitializeDebugAdapterRequest.cs AttachOptions()); 0 is rejected by the server (live E2E 2026-07-03)
      await hub.invoke("Attach", {
        BreakOnNextClient: BREAK_ON_NEXT_WIRE[opts.breakOnNext ?? "WebClient"],
        SessionId: -1,
        UserId: null,
      });
      // WIRE: DebugAdapterConfigurationDone(DebugOptions) (esp-decomp HubBasedDebuggerService.ConfigurationDoneAsync / DebugOptions.cs)
      // BreakOnErrorBehaviour: Unspecified=0, None=1, All=2, ExcludeTry=3
      // BreakOnRecordWriteBehaviour: Unspecified=0, None=1, All=2, ExcludeTemporary=3
      // (esp-decomp BreakOnRecordWriteBehaviour.cs)
      this.pendingDebugOptions = {
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
    } catch (err) {
      this.hub = null;
      await hub.stop().catch(() => {});
      throw err;
    }
  }

  private requireHub(): HubProxy {
    if (!this.hub) throw new Error("Debugger not connected — call connect() first");
    return this.hub;
  }

  private sendPendingDebugOptions(): void {
    const options = this.pendingDebugOptions;
    if (!options || !this.hub) return;
    this.pendingDebugOptions = null;
    // WIRE: session bind is signalled by HubConnected on BC28 (live E2E 2026-07-03);
    // OnAttachedToConnection exists in the decompiled contract but was never observed live —
    // handle both, first one wins.
    void this.hub.invoke("DebugAdapterConfigurationDone", options).catch(() => {});
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
    if (hub) {
      await hub.invoke("StopDebugging").catch(() => {});
      await hub.stop().catch(() => {});
    }
  }
}
