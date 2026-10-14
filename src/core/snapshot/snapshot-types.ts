// WIRE: snapshot payload + enums (tw-decomp Microsoft.Dynamics.Nav.DebuggerService/*Wrapper.cs,
// dep-decomp SnapshotDebuggerClient.cs). Validated live 2026-07-04 (scripts/e2e-profile-capture-2026-07-04.md).

// WIRE: AttachClientTypeWrapper
export const CLIENT_TYPE_WIRE = { WebServiceClient: 0, WebClient: 1, Background: 2, ClientService: 3 } as const;
export type ClientTypeName = keyof typeof CLIENT_TYPE_WIRE;

// WIRE: SnapshotDebuggerSessionStatusWrapper: Failed=0, Initialized=1, Started=2, Finished=3
export type SnapshotStatus = "Failed" | "Initialized" | "Started" | "Finished";
const STATUS_BY_INT: Record<number, SnapshotStatus> = { 0: "Failed", 1: "Initialized", 2: "Started", 3: "Finished" };

export function parseStatus(raw: string): SnapshotStatus {
  const t = raw.trim().replace(/^"|"$/g, "");
  if (t === "Failed" || t === "Initialized" || t === "Started" || t === "Finished") return t;
  const n = Number(t);
  if (n in STATUS_BY_INT) return STATUS_BY_INT[n]!;
  throw new Error(`unrecognized snapshot status: ${raw}`);
}

export interface SamplingAttachParams {
  debuggingContext: string;
  clientType: ClientTypeName;
  userId?: string;
  samplingIntervalMs: 50 | 100 | 150;
  sessionId: number;
}

// WIRE: SnapshotDebuggerAttachPayloadWrapper — PascalCase, integer enums.
// SnapshotVerbosity=SnapPoint(0), ExecutionContext=Profiling(2), Kind=Sampling(1).
export function buildSamplingAttachBody(p: SamplingAttachParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    DebuggingContext: p.debuggingContext,
    ClientType: CLIENT_TYPE_WIRE[p.clientType],
    SnapshotVerbosity: 0,
    SessionId: p.sessionId,
    ExecutionContext: 2,
    Kind: 1,
    SamplingInterval: p.samplingIntervalMs,
  };
  if (p.userId) body["UserId"] = p.userId;
  return body;
}

export interface WireLocation {
  objectType: number;
  objectId: number;
  lines: Array<{ line: number; condition?: string }>; // line 0-based
}

export interface DebugAttachParams {
  debuggingContext: string;
  clientType: ClientTypeName;
  userId?: string;
  sessionId: number;
  verbosity: "snappoint" | "full";
  locations: WireLocation[];
}

// WIRE: debugging attach — ExecutionContext=Debugging(1); SnapshotVerbosity SnapPoint(0) | Full(1); locations are
// SourceBreakpointLocationWrapper[] { Id: ApplicationObjectIdWrapper, Lines: LineWrapper[] } with a 0-based line and
// column 0 (esp-decomp SnapshotDebuggerAttachInitializeRequestHandler Position.Create(line, 0, linesStartAt1)).
// Live Cronus29 2026-10-14: page 50152 line 35 -> Line 34 captured that line.
// WIRE: LineWrapper.Condition is sent, but BC29 (runtime 18.0, snapshot API 5.0) ignored it: "1 = 2" and a false
// "PageLocalText <> ''" still recorded the snappoint (live Cronus29 2026-10-14, scripts/e2e.md "Snapshot debug capture").
// WIRE: SessionId > 0 binds that running NST session at once (attachKind "UserSession", status Started before the
// trigger); UserId takes a user name (resolved by BC; an unknown name is HTTP 400 "The user GUID '<name>' is not valid").
// ClientType WebServiceClient binds an OData call, then BC drops the context with that session (status/finish 404);
// Background was not exercised (live Cronus29 2026-10-14).
export function buildDebugAttachBody(p: DebugAttachParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    DebuggingContext: p.debuggingContext,
    ClientType: CLIENT_TYPE_WIRE[p.clientType],
    SnapshotVerbosity: p.verbosity === "full" ? 1 : 0,
    SessionId: p.sessionId,
    ExecutionContext: 1,
    SourceBreakpointLocations: p.locations.map((l) => ({
      Id: { ObjectType: l.objectType, ObjectNumber: l.objectId },
      Lines: l.lines.map((x) => ({ Position: { Line: x.line, Column: 0 }, ...(x.condition ? { Condition: x.condition } : {}) })),
    })),
  };
  if (p.userId) body["UserId"] = p.userId;
  return body;
}

export interface InstrumentationAttachParams {
  debuggingContext: string;
  clientType: ClientTypeName;
  userId?: string;
  sessionId: number;
}

// WIRE: instrumentation attach — Kind=Instrumentation(0), SnapshotVerbosity=Full(1), ExecutionContext=Profiling(2),
// NO SamplingInterval. Same snapshotdebugger/attach POST as sampling. Validated 2026-07-04.
export function buildInstrumentationAttachBody(p: InstrumentationAttachParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    DebuggingContext: p.debuggingContext,
    ClientType: CLIENT_TYPE_WIRE[p.clientType],
    SnapshotVerbosity: 1,
    SessionId: p.sessionId,
    ExecutionContext: 2,
    Kind: 0,
  };
  if (p.userId) body["UserId"] = p.userId;
  return body;
}
