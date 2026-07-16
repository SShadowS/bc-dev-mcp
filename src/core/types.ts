export interface OnPremConnectionConfig {
  environmentType: "OnPrem";
  authentication: "UserPassword";
  server: string; // absolute URL, e.g. "http://localhost" or "https://host:8443"
  serverInstance: string; // e.g. "BC"
  port?: number; // developer service port; wins over any port in `server`
  tenant?: string;
  username: string;
  password: string;
}

export interface CloudConnectionConfig {
  environmentType: "Sandbox" | "Production";
  authentication: "EntraId";
  environmentName: string;
  tenant: string;
}

export type ConnectionConfig = OnPremConnectionConfig | CloudConnectionConfig;

export interface ConnectionOverrides {
  environmentType?: "OnPrem" | "Sandbox" | "Production";
  authentication?: "UserPassword" | "AAD" | "EntraId" | "Windows";
  server?: string;
  serverInstance?: string;
  environmentName?: string;
  port?: number;
  tenant?: string;
  username?: string;
  password?: string;
}

export type CoverageMode = "none" | "line" | "procedure";
// WIRE: CoverageMode enum order from lmt-decomp .../TestRunning/CoverageMode.cs
export const COVERAGE_MODE_WIRE: Record<CoverageMode, number> = { none: 0, line: 1, procedure: 2 };

export type TestStatus = "passed" | "failed" | "skipped";
// WIRE: TestResultStatus enum order from lmt-decomp .../TestRunning/TestResultStatus.cs
export const TEST_STATUS_FROM_WIRE: Record<number, TestStatus> = { 0: "passed", 1: "failed", 2: "skipped" };

export interface CodeunitTestGroup {
  id: number;
  methods?: string[];
}

export interface TestMethodResult {
  codeunitId: number;
  method: string;
  status: TestStatus;
  durationMs: number;
  output: string;
}

export interface CoverageProcedure {
  objectType: number;
  objectId: number;
  methodId: number;
  file?: string;
}

export interface CoverageEntry {
  testObjectId: number;
  testMethodId: number;
  coveredProcedures: CoverageProcedure[];
}

export interface RunTestsResult {
  results: TestMethodResult[];
  coverage?: CoverageEntry[];
  runAborted?: boolean;
  abortReason?: string;
}

export interface BreakpointSpec {
  file: string;
  line: number;
  condition?: string;
}

export interface StackFrameInfo {
  objectType: number;
  objectId: number;
  objectName: string;
  methodName: string;
  line: number;
  file?: string;
}

export type DebuggerEvent =
  | { kind: "break"; objectType: number; objectId: number; file?: string; line?: number; errorMessage?: string; stack: StackFrameInfo[] }
  | { kind: "sessionBound"; sessionId: number; hostId: string | null }
  | { kind: "sessionBound"; sessionId: null; hostId: null; warning: string }
  | { kind: "testRunFinished" }
  | { kind: "detached"; terminateSession: boolean }
  | { kind: "fatal"; message: string };
