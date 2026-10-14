import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { BcDevError } from "../../core/agent-errors";
import { AlObjectIndex } from "../../core/al-objects";
import { redactAuthorization } from "../../core/redaction";
import { converterSupports, resolveConverter as findLocalConverter } from "../../core/snapshot/converter";
import { projectSnapshot } from "../../core/snapshot/debug-snapshot";
import { SNAPSHOT_LIMITS } from "../../core/snapshot/limits";
import { runSnapshotJson, type SnapshotJsonRunner } from "../../core/snapshot/run-converter";
import { SnapshotClient, SnapshotHttpError, type FinishResult } from "../../core/snapshot/snapshot-client";
import { normalizeSnappoints, toWireLocations, type ArmedSnappoint, type SnappointInput } from "../../core/snapshot/snappoints";
import { extractEntry } from "../../core/snapshot/zip";
import { DEFAULT_API_PORT, DEFAULT_SNAPSHOT_PORT } from "../../core/urls";
import { captureActiveError, type ServerState, type SnapshotCapture } from "../state";
import { assertHandle, claimTestRun, codeunitsShape, connectionShape, handleShape, resolve, resolveApiPort, SNAPSHOT_HANDLE, type ToolDefinition, type ToolDeps } from "./shared";

const snapshotId = handleShape(SNAPSHOT_HANDLE);

const snappointShape = z.object({
  file: z.string().optional().describe("Workspace .al file holding the line (relative to project, or absolute); omit to name an object outside the workspace with objectType + objectId"),
  objectType: z
    .enum(["table", "tableextension", "page", "pageextension", "report", "reportextension", "codeunit", "query", "xmlport"])
    .optional()
    .describe("Object type, for an object outside the workspace (reported back unverified)"),
  objectId: z.number().int().optional().describe("Object id 1..2147483647, with objectType"),
  line: z.number().int().describe("1-based source line, as shown in an editor"),
  condition: z.string().optional().describe("Optional AL condition, passed to Business Central; BC29 was seen to ignore it and record every hit, so filter the points yourself"),
});

const DISCLOSURE =
  "Captured variables can contain customer data, credentials and source code; they are returned to the agent as-is (no redaction), and the saved zip holds everything, even what the response omitted.";

const RAW_WARNING = "This bc-mdc-converter cannot decode snapshots: install bc-mdc-converter 0.2.0 or newer (or let bc-dev-mcp download it).";

const major = (v: unknown) => Number(String(v ?? "").split(".")[0]);

function mapError(e: unknown): unknown {
  if (e instanceof SnapshotHttpError) {
    if (e.status === 401 || e.status === 403) {
      return new BcDevError("AUTHENTICATION_FAILED", `${e.operation}: Business Central rejected the credentials (HTTP ${e.status})`, "auth", false, { operation: e.operation, httpStatus: e.status });
    }
    if (e.heldElsewhere) {
      return new BcDevError("PROFILE_ACTIVE", `${e.message} (held by another client or an earlier process)`, "state", false, { heldElsewhere: true, ownerFinishTool: "bcdev_snapshot_finish", capture: "snapshot" });
    }
    if (e.lostContext) {
      return new BcDevError("SERVER_REJECTED", `${e.operation}: Business Central no longer knows this capture (it ended or the server restarted)`, "server", false, { lostContext: true, message: e.bodySnippet });
    }
    return new BcDevError("SERVER_REJECTED", e.message, "server", false, { operation: e.operation, httpStatus: e.status });
  }
  if (e instanceof TypeError || (e instanceof Error && e.name === "AbortError")) {
    return new BcDevError("ENDPOINT_UNREACHABLE", `snapshot endpoint unreachable: ${e.message}`, "network", true);
  }
  return e;
}

// WIRE: the size cap in SnapshotClient.finish raises a SnapshotHttpError carrying the 2xx status of an answered request.
const isTooBig = (e: unknown): e is SnapshotHttpError => e instanceof SnapshotHttpError && e.status < 300 && /byte limit/.test(e.bodySnippet);

// WIRE: a context BC no longer knows can answer 200 with {"Message":"..."} instead of an archive (as status does).
function lostContextBody(body: Uint8Array): SnapshotHttpError | null {
  if (body.length > 4096 || body[0] !== 0x7b) return null;
  try {
    const j: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
    const msg = (j as { Message?: unknown } | null)?.Message;
    return typeof msg === "string" ? new SnapshotHttpError("snapshot finish", 200, redactAuthorization(msg).slice(0, 300)) : null;
  } catch {
    return null;
  }
}

// WIRE: Snapshot-context run_tests result shape (live Cronus29 2026-10-14); load-bearing fields only, the rest passes loose.
const runResultSchema = z.looseObject({
  success: z.boolean(),
  codeunitResults: z.array(z.looseObject({
    codeunitId: z.number(),
    success: z.boolean(),
    errorMessage: z.string().optional(),
    testResults: z.array(z.looseObject({ methodName: z.string(), status: z.string(), message: z.string().optional() })),
  })),
  snapshotDebugging: z.looseObject({ attached: z.boolean(), verbosity: z.string().optional() }).optional(),
});

const RUN_UNREADABLE = "bc-dev-mcp could not read the run_tests result";
const MAX_METHODS = 500;
const MAX_MESSAGE = 2000;

/** Never echoes the body into an error: it can hold application data. */
function parseRunResult(result: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(result["content"]) ? (result["content"] as Array<{ type?: unknown; text?: unknown }>) : [];
  const block = content.find((b) => b?.type === "text");
  const text = typeof block?.text === "string" ? block.text : "";
  if (result["isError"] === true) {
    throw new BcDevError("SERVER_REJECTED", redactAuthorization(text).slice(0, 300) || "run_tests failed", "server", false);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BcDevError("PROTOCOL_ERROR", RUN_UNREADABLE, "protocol", false);
  }
  const parsed = runResultSchema.safeParse(json);
  if (!parsed.success) throw new BcDevError("PROTOCOL_ERROR", RUN_UNREADABLE, "protocol", false);
  const r = parsed.data;
  const cut = (s: string | undefined) => (s === undefined ? {} : { message: s.slice(0, MAX_MESSAGE) });
  const attached = r.snapshotDebugging?.attached ?? null;
  const warnings = attached === null
    ? ["BC did not report whether this test run was attached to the capture"]
    : attached ? [] : ["this test run was not attached to the capture"];
  return {
    attached,
    ...(r.snapshotDebugging?.verbosity === undefined ? {} : { verbosity: r.snapshotDebugging.verbosity }),
    success: r.success,
    codeunits: r.codeunitResults.map((u) => ({
      id: u.codeunitId,
      success: u.success,
      ...(u.errorMessage === undefined ? {} : { errorMessage: u.errorMessage.slice(0, MAX_MESSAGE) }),
      methods: u.testResults.slice(0, MAX_METHODS).map((m) => ({ name: m.methodName, status: m.status, ...cut(m.message) })),
      ...(u.testResults.length > MAX_METHODS ? { omittedMethods: u.testResults.length - MAX_METHODS } : {}),
    })),
    ...(warnings.length ? { warnings } : {}),
  };
}

export function createSnapshotTools(
  state: ServerState,
  deps: ToolDeps,
  seams: {
    runJson?: SnapshotJsonRunner;
    supports?: (binary: string, format: string) => Promise<boolean>;
    resolveConverter?: () => Promise<string | null>;
    saveDir?: string;
    zipBytes?: number;
  } = {},
): ToolDefinition[] {
  const runJson = seams.runJson ?? runSnapshotJson;
  const supports = seams.supports ?? converterSupports;
  // Without the shared resolver: BC_MDC_CONVERTER / PATH only, never a download (as profile-tools).
  const resolveConverter = seams.resolveConverter ?? (async () => (deps.converter ? deps.converter.binary() : (findLocalConverter({ env: deps.env })?.converterPath ?? null)));
  const saveDir = seams.saveDir ?? join(tmpdir(), "bc-dev-mcp-snapshots");
  const zipBytes = seams.zipBytes ?? SNAPSHOT_LIMITS.zipBytes;

  const arm = async (input: SnappointInput[], project: string): Promise<ArmedSnappoint[]> => {
    if (input.length === 0) return [];
    const index = await AlObjectIndex.build(project);
    return normalizeSnappoints(input, index, project, async (f) => (await readFile(f, "utf8")).split(/\r?\n/).length);
  };

  /** null = valid; otherwise the reason. Checked before the server is touched. */
  const outPathProblem = (params: Record<string, unknown>): string | null => {
    const out = params["outPath"] as string | undefined;
    if (out === undefined) return null;
    const abs = resolvePath(deps.cwd, out);
    if (!existsSync(dirname(abs)) || !statSync(dirname(abs)).isDirectory()) return `outPath folder does not exist: ${dirname(abs)}`;
    if (existsSync(abs) && params["overwrite"] !== true) return `outPath already exists: ${abs}; pass overwrite: true to replace it`;
    return null;
  };

  /** Save, convert and project an answered finish. Nothing here touches the capture slot. */
  const decode = async (fin: FinishResult, armed: ArmedSnappoint[] | null, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (fin.empty) {
      return { decodeStatus: "empty", hint: "Nothing was recorded: the session probably never ran or never reached a snappoint between start and finish." };
    }
    const lost = lostContextBody(fin.body);
    if (lost) throw mapError(lost);
    let zipPath: string;
    try {
      const out = params["outPath"] as string | undefined;
      if (out !== undefined) {
        zipPath = resolvePath(deps.cwd, out);
        await writeFile(zipPath, fin.body, { flag: params["overwrite"] === true ? "w" : "wx" });
      } else {
        await mkdir(saveDir, { recursive: true, mode: 0o700 }); // best effort on Windows, where the user's temp folder is already private
        zipPath = join(saveDir, `${randomUUID()}.zip`); // never the caller-supplied context
        await writeFile(zipPath, fin.body, { flag: "wx" });
      }
    } catch (e) {
      return { decodeStatus: "failed", failedStage: "save", error: `could not save the archive: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` };
    }
    const binary = await resolveConverter();
    if (!binary || !(await supports(binary, "snapshot-json"))) {
      const why = binary ? undefined : (await deps.converter?.resolve())?.reason; // resolver's reason text only
      return { decodeStatus: "raw", zipPath, warnings: [why ? `${RAW_WARNING} (${why})` : RAW_WARNING] };
    }
    const conv = await runJson(binary, zipPath);
    if (!conv.ok) return { decodeStatus: "failed", failedStage: "convert", zipPath, error: conv.error };
    const readSource = (entry: string) => {
      try {
        return extractEntry(fin.body, entry, SNAPSHOT_LIMITS.sourceEntryBytes)?.toString("utf8") ?? null;
      } catch {
        return null; // projectSnapshot warns that the window is missing
      }
    };
    try {
      return { decodeStatus: "decoded", zipPath, ...projectSnapshot(conv.json, armed, readSource) };
    } catch {
      // fixed text: a runtime error message could quote document content
      return { decodeStatus: "failed", failedStage: "project", zipPath, error: "snapshot-json is not a readable bc-mdc-snapshot schemaVersion 1 document" };
    }
  };

  const release = (token: symbol) => {
    if (state.capture?.token === token) state.capture = null;
  };

  const requireSnapshot = (params: Record<string, unknown>): SnapshotCapture => {
    const active = state.capture;
    if (active?.captureKind === "profile") throw captureActiveError(active, "snapshot");
    assertHandle(SNAPSHOT_HANDLE, params, active?.snapshotId ?? null);
    if (!active) throw new BcDevError("SNAPSHOT_NOT_ACTIVE", "No active snapshot capture — call bcdev_snapshot_start first", "state");
    return active;
  };

  return [
    {
      name: "bcdev_snapshot_start",
      title: "Start snapshot debugging capture",
      description:
        "Arm a snapshot debugging capture on the BC server: the next matching session records the variables at each snappoint (an AL line, 1-based) and at any error it throws, without pausing it. " +
        "After this, TRIGGER the scenario (open the page in a browser or business-central-mcp), call bcdev_snapshot_status until ready, then bcdev_snapshot_finish to get decoded points. " +
        "clientType WebClient is verified (also with userId or a running sessionId). WebServiceClient is experimental and records nothing usable: it binds an API/OData call, but Business Central drops the capture when that short session ends, so status/finish report it lost. Background and ClientService are experimental and unverified. To capture an AL test run, call bcdev_snapshot_run_tests after start (verified on-prem). " +
        "One capture (profile or snapshot) at a time per tenant. " +
        DISCLOSURE,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      schema: {
        ...connectionShape,
        snapshotPort: z.number().optional().describe("Snapshot-debugger port (default 7083; separate from the dev port)"),
        snappoints: z.array(snappointShape).max(20).optional().describe("Lines to record (0-20). None = record only what throws"),
        clientType: z.enum(["WebClient", "WebServiceClient", "Background", "ClientService"]).optional().describe("Session type to bind (default WebClient; the others are experimental, WebServiceClient records nothing usable)"),
        userId: z.string().optional().describe("Bind the next session of this user only (user name; an unknown user is rejected)"),
        sessionId: z.number().int().refine((v) => v === -1 || v >= 1, "must be -1 or >= 1").optional().describe("Bind this running NST session now (clientType and userId are then ignored); default -1 = next matching session"),
        verbosity: z.enum(["snappoint", "full"]).optional().describe("snappoint (default) records the armed lines and errors; full records every method context (heavier)"),
      },
      outputSchema: z.looseObject({
        snapshotId: z.string().describe("Opaque handle; pass it to bcdev_snapshot_status/finish. Valid until bcdev_snapshot_finish"),
        debuggingContext: z.string(),
        attachKind: z.string(),
        snappoints: z.array(z.looseObject({ objectType: z.string(), objectId: z.number(), line: z.number(), unverified: z.boolean() })),
        verbosity: z.enum(["snappoint", "full"]),
      }),
      handler: async (params) => {
        if (state.capture) throw captureActiveError(state.capture, "snapshot");
        const { config, authorization, project } = resolve(params, deps);
        const snapshotPort = (params["snapshotPort"] as number | undefined) ?? DEFAULT_SNAPSHOT_PORT;
        const verbosity = (params["verbosity"] as "snappoint" | "full" | undefined) ?? "snappoint";
        const sid = params["sessionId"] as number | undefined;
        if (sid !== undefined && sid !== -1 && !(Number.isInteger(sid) && sid >= 1)) {
          throw new BcDevError("INVALID_ARGUMENT", "sessionId must be -1 (next matching session) or an integer >= 1; Business Central rejects 0", "validation");
        }
        const snappoints = await arm((params["snappoints"] as SnappointInput[] | undefined) ?? [], project);
        await resolveConverter(); // any converter download happens now, never while a capture is armed
        const client = new SnapshotClient(deps.fetchFn, config, snapshotPort, authorization);
        let webApiVersion: string | undefined;
        try {
          webApiVersion = (await client.metadata()).webApiVersion;
        } catch (e) {
          if (e instanceof SnapshotHttpError && e.status === 404) webApiVersion = undefined;
          else throw mapError(e);
        }
        if (!(major(webApiVersion) >= 3)) {
          throw new BcDevError(
            "UNSUPPORTED_SERVER",
            `Snapshot debugging needs a snapshot endpoint with webApiVersion 3.0 or newer; this server reports ${webApiVersion ?? "no metadata"}. (Provisional policy: debugging capture has only been verified at 5.0.)`,
            "server",
            false,
            { webApiVersion: webApiVersion ?? null },
          );
        }
        if (state.capture) throw captureActiveError(state.capture, "snapshot"); // another start won the slot while we awaited
        const debuggingContext = randomUUID();
        const token = Symbol("snapshot");
        const claim: SnapshotCapture = {
          captureKind: "snapshot", snapshotId: randomUUID(), debuggingContext, affinityCookie: null, attachKind: "", snapshotPort, config, authorization,
          startedAt: new Date().toISOString(), token, phase: "attaching", snappoints, verbosity,
        };
        state.capture = claim;
        let attach;
        try {
          attach = await client.attachDebug({
            debuggingContext,
            clientType: (params["clientType"] as "WebClient" | undefined) ?? "WebClient",
            userId: params["userId"] as string | undefined,
            sessionId: (params["sessionId"] as number | undefined) ?? -1,
            verbosity,
            locations: toWireLocations(snappoints),
          });
        } catch (e) {
          release(token);
          if (e instanceof SnapshotHttpError || e instanceof BcDevError) throw mapError(e);
          throw new BcDevError(
            "TIMEOUT",
            "attach sent but not answered; finish it as an orphan with bcdev_snapshot_finish { debuggingContext }",
            "network",
            false,
            { debuggingContext, attachUncertain: true },
          );
        }
        if (state.capture?.token === token) {
          claim.affinityCookie = attach.affinityCookie;
          claim.attachKind = attach.attachKind;
          claim.phase = "armed";
        }
        return {
          snapshotId: claim.snapshotId,
          debuggingContext,
          attachKind: attach.attachKind,
          snappoints: snappoints.map(({ objectTypeName, objectId, line, condition, file, unverified }) => ({
            objectType: objectTypeName, objectId, line, ...(condition ? { condition } : {}), ...(file ? { file } : {}), unverified,
          })),
          verbosity,
        };
      },
    },
    {
      name: "bcdev_snapshot_status",
      title: "Snapshot capture status",
      description: "Status of the active snapshot capture: Initialized (no session bound yet; trigger the scenario), Started (recording; ready to finish), Finished or Failed (finish to collect or release it).",
      annotations: { readOnlyHint: true, openWorldHint: true },
      schema: { snapshotId },
      outputSchema: z.looseObject({ status: z.enum(["Failed", "Initialized", "Started", "Finished"]), ready: z.boolean() }),
      handler: async (params) => {
        const c = requireSnapshot(params);
        if (c.phase === "attaching" || c.phase === "finishing" || c.phase === "testing") throw captureActiveError(c, "snapshot");
        try {
          const status = await new SnapshotClient(deps.fetchFn, c.config, c.snapshotPort, c.authorization).status(c.debuggingContext, c.affinityCookie);
          return { status, ready: status === "Started" };
        } catch (e) {
          if (e instanceof SnapshotHttpError && e.lostContext) release(c.token);
          throw mapError(e);
        }
      },
    },
    {
      name: "bcdev_snapshot_finish",
      title: "Finish snapshot capture",
      description:
        "Finish the snapshot capture, save the recording zip and decode it into points (exceptions first, then snappoint hits) with variables, call stack and a source window. " +
        "decodeStatus: decoded | empty (nothing recorded) | raw (zip saved, converter unavailable) | failed (failedStage + error; zipPath when saved). The capture is released once the server answers. " +
        "With debuggingContext (and connection params) it recovers a capture this process does not hold; pass the start's snappoints to classify them. " +
        "Default save folder: <os temp>/bc-dev-mcp-snapshots; bc-dev-mcp never deletes saved zips. " +
        DISCLOSURE,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      schema: {
        ...connectionShape,
        snapshotPort: z.number().optional().describe("Snapshot-debugger port for orphan recovery (default 7083)"),
        snapshotId,
        debuggingContext: z.string().min(1).optional().describe("Recover a capture this process does not hold (another client, or a crashed earlier process); not with snapshotId"),
        snappoints: z.array(snappointShape).max(20).optional().describe("Orphan recovery only: the snappoints given at start, to classify points (without them the result is partial)"),
        outPath: z.string().optional().describe("Where to write the recording zip (default: a new file in <os temp>/bc-dev-mcp-snapshots); the folder must exist"),
        overwrite: z.boolean().optional().describe("Replace an existing outPath file (default false)"),
      },
      outputSchema: z.looseObject({
        decodeStatus: z.enum(["empty", "decoded", "raw", "failed"]),
        zipPath: z.string().optional(),
        failedStage: z.enum(["download", "save", "convert", "project"]).optional(),
        error: z.string().optional(),
        points: z.array(z.looseObject({ reasons: z.array(z.string()), line: z.number().nullable(), variables: z.unknown() })).optional(),
        omittedPoints: z.number().optional(),
        methodCount: z.number().optional(),
        classification: z.enum(["complete", "partial"]).optional(),
        warnings: z.array(z.string()).optional(),
        hint: z.string().optional(),
      }),
      handler: async (params) => {
        const orphan = params["debuggingContext"] as string | undefined;
        if (orphan !== undefined && params["snapshotId"] !== undefined) {
          throw new BcDevError("INVALID_ARGUMENT", "Pass either snapshotId or debuggingContext, not both", "validation");
        }
        if (orphan !== undefined && state.capture?.captureKind === "profile" && orphan === state.capture.debuggingContext) {
          throw captureActiveError(state.capture, "snapshot");
        }
        if (orphan !== undefined && orphan === state.capture?.debuggingContext) {
          throw new BcDevError("INVALID_ARGUMENT", "debuggingContext belongs to the active capture; finish it by its handle (or with no arguments)", "validation");
        }
        const outProblem = outPathProblem(params);

        if (orphan !== undefined) {
          if (outProblem) throw new BcDevError("INVALID_ARGUMENT", outProblem, "validation");
          const { config, authorization, project } = resolve(params, deps);
          const port = (params["snapshotPort"] as number | undefined) ?? DEFAULT_SNAPSHOT_PORT;
          const input = params["snappoints"] as SnappointInput[] | undefined;
          const armed = input ? await arm(input, project) : null;
          let fin: FinishResult;
          try {
            fin = await new SnapshotClient(deps.fetchFn, config, port, authorization).finish(orphan, null, zipBytes);
          } catch (e) {
            if (isTooBig(e)) return { decodeStatus: "failed", failedStage: "download", error: `archive too large: ${e.bodySnippet}` };
            throw mapError(e);
          }
          return decode(fin, armed, params);
        }

        const c = requireSnapshot(params);
        if (c.phase !== "armed" && c.phase !== "uncertain") throw captureActiveError(c, "snapshot");
        if (outProblem) throw new BcDevError("INVALID_ARGUMENT", outProblem, "validation"); // before any server call: the capture stays armed
        const previous = c.phase;
        c.phase = "finishing"; // synchronously, before any await: a concurrent finish/status is refused
        let fin: FinishResult;
        try {
          fin = await new SnapshotClient(deps.fetchFn, c.config, c.snapshotPort, c.authorization).finish(c.debuggingContext, c.affinityCookie, zipBytes);
        } catch (e) {
          const mine = state.capture?.token === c.token;
          if (isTooBig(e)) {
            release(c.token); // the server answered: its side is finished
            return { decodeStatus: "failed", failedStage: "download", error: `archive too large: ${e.bodySnippet}` };
          }
          if (e instanceof SnapshotHttpError) {
            if (e.lostContext) release(c.token);
            else if (mine) c.phase = "armed"; // the capture may still run; fix the cause and finish again
            throw mapError(e);
          }
          if (e instanceof BcDevError) {
            if (mine) c.phase = previous; // failed before sending (e.g. credentials)
            throw e;
          }
          if (mine) c.phase = "uncertain";
          throw new BcDevError("TIMEOUT", "finish not answered; call bcdev_snapshot_finish again", "network", true, { snapshotId: c.snapshotId, phase: "uncertain" });
        }
        release(c.token);
        return decode(fin, c.snappoints, params);
      },
    },
    {
      name: "bcdev_snapshot_run_tests",
      title: "Run AL tests into the snapshot capture",
      description:
        "Run AL test codeunits attached to the armed bcdev_snapshot_start capture, through Business Central's native snapshot MCP run_tests, so the capture records the test run (a failing test's exception and variables). " +
        "Needs an armed capture from bcdev_snapshot_start; on-prem only (cloud is refused). Returns per-method results (failed tests are ordinary results); then call bcdev_snapshot_finish to collect the recording. " +
        "Uses the capture's connection; the MCP endpoint is on the API/OData port (apiPort, default BC_DEV_API_PORT or 7048). Test messages and BC errors can contain application data.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      schema: {
        snapshotId,
        codeunits: codeunitsShape.max(50).describe("Test codeunits to run (1-50)"),
        company: z.string().trim().min(1).max(250).regex(/^[^\r\n]+$/, "company must not contain newline characters").optional().describe("Company name (default: BC's default company)"),
        apiPort: z.number().int().min(1).max(65535).optional().describe("BC API/OData port of the MCP endpoint (default BC_DEV_API_PORT or 7048)"),
        timeoutMs: z.number().int().min(1_000).max(300_000).optional().describe("Whole connect-and-run timeout in milliseconds (default 300000)"),
      },
      outputSchema: z.looseObject({
        attached: z.boolean().nullable().describe("Whether BC attached the run to the capture; null when BC did not say"),
        verbosity: z.string().optional(),
        success: z.boolean(),
        codeunits: z.array(z.looseObject({
          id: z.number(),
          success: z.boolean(),
          errorMessage: z.string().optional(),
          methods: z.array(z.looseObject({ name: z.string(), status: z.string(), message: z.string().optional() })),
          omittedMethods: z.number().optional(),
        })),
        warnings: z.array(z.string()).optional(),
      }),
      handler: async (params) => {
        const c = requireSnapshot(params);
        if (c.phase !== "armed") throw captureActiveError(c, "snapshot");
        if (c.config.environmentType !== "OnPrem") {
          throw new BcDevError("UNSUPPORTED_SERVER", "snapshot test runs are verified on-prem only; cloud routing of a REST-armed context is unproven", "server", false, { environmentType: c.config.environmentType });
        }
        const config = c.config;
        claimTestRun(state);
        c.phase = "testing"; // same tick as the lock claim, before any await: finish/status are refused meanwhile
        try {
          const company = params["company"] as string | undefined;
          const args = {
            debuggingContext: c.debuggingContext,
            testCases: (params["codeunits"] as Array<{ id: number; methods?: string[] }>).map((u) => ({
              codeunitId: u.id, ...(u.methods?.length ? { testMethods: u.methods } : {}),
            })),
            ...(company === undefined ? {} : { companyName: company }),
          };
          // WIRE: Snapshot-context run_tests accepts a REST-armed debuggingContext and records into it (live Cronus29 2026-10-14)
          const { result } = await deps.nativeMcpGateway.callTool({
            kind: "onprem", config, apiPort: resolveApiPort(params, deps) ?? DEFAULT_API_PORT, authorization: c.authorization,
            company, context: "snapshot", timeoutMs: (params["timeoutMs"] as number | undefined) ?? 300_000,
          }, "run_tests", args);
          return parseRunResult(result);
        } catch (error) {
          if (error instanceof BcDevError && error.code === "TIMEOUT" && error.details["timeoutPhase"] === "operation") {
            throw new BcDevError(error.code, error.message, error.category, false, {
              ...error.details,
              upstreamRunCancelled: false,
              warning: "BC may still be running these tests; wait, then call bcdev_snapshot_status / bcdev_snapshot_finish; do not start another test run yet.",
            }, { cause: error });
          }
          throw error;
        } finally {
          state.testRunActive = false;
          if (state.capture?.token === c.token && c.phase === "testing") c.phase = "armed";
        }
      },
    },
  ];
}
