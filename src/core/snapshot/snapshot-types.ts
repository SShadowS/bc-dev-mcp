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
