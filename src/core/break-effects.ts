import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ALSEM_ENV_VAR } from "./call-graph";
import { WRITE_OPS } from "./alsem-writes";

/*
 * What can the paused routine still do? Optional al-sem enrichment of a debugger break:
 * `alsem query effects` resolves the routine (stable id, db writes, overload candidates) and
 * `alsem prove <stableId> may-commit|throws-error|reaches-ui` answers the absence questions.
 * al-sem is OPTIONAL: when it is missing or unreadable the result carries a status and a
 * warning, never an error.
 *
 * Known al-sem limits (surfaced in `limits`): #28 two call sites on one line collapse to one
 * site key (a cone can under-count); #9 Rename is not modelled as a write.
 */

// WIRE: both commands print the envelope {alsemVersion, kind, schemaVersion, payload, diagnostics};
// kind "query.effects" schema 1.x, kind "prove" schema 1.x (al-sem 1.5.0, recorded in tests/fixtures/alsem-prove/README.md).
export const EFFECTS_KIND = "query.effects";
export const PROVE_KIND = "prove";
export const SUPPORTED_SCHEMA_MAJOR = 1;
/** WIRE: prove selects by bare display name or StableRoutineId only (`Object.Routine` yields "unknown"); `query effects` takes `Object.Routine`. So resolve via effects, prove by stable id. */
export const PROVE_QUESTIONS = [
  ["mayCommit", "may-commit"],
  ["throwsError", "throws-error"],
  ["reachesUi", "reaches-ui"],
] as const;

/** Runs a binary; a non-zero exit WITH stdout is a normal result (WIRE: alsem exits 2 for answer "unknown"/unresolved selectors). */
export type StdoutRunner = (binary: string, args: string[]) => Promise<{ stdout: string; notFound?: true }>;

const execFileAsync = promisify(execFile);

export const runForStdout: StdoutRunner = async (binary, args) => {
  try {
    const { stdout } = await execFileAsync(binary, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return { stdout };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (e.code === "ENOENT") return { stdout: "", notFound: true };
    if (typeof e.stdout === "string" && e.stdout.trim() !== "") return { stdout: e.stdout };
    throw new Error(String(e.stderr ?? error).trim().slice(0, 500) || "alsem failed");
  }
};

export interface ProofAnswer {
  answer: "yes" | "no" | "unknown";
  coverageComplete: boolean;
  unresolvedCallsites: number;
  analysisGaps: number;
  coneTruncated: boolean;
  openWorldRows: number;
}

export interface BreakEffects {
  status: "ok" | "symbolOnly" | "unavailable" | "unmatched" | "ambiguous" | "failed";
  message?: string;
  warning?: string;
  routine?: { display: string; objectDisplay: string; stableId: string };
  candidates?: string[];
  tableWrites?: Array<{ op: string; table: string; via: string; temporary: string }>;
  tableWritesTruncated?: boolean;
  proofs?: { mayCommit: ProofAnswer; throwsError: ProofAnswer; reachesUi: ProofAnswer };
  limits?: string[];
}

export type BreakEffectsProvider = (input: { project: string; objectName: string; methodName: string; inWorkspace: boolean }) => Promise<BreakEffects>;

const MAX_WRITES = 50;

function envelope(stdout: string, kind: string): { payload: Record<string, any> } | { warning: string } {
  let doc: any;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { warning: `alsem ${kind} output was not JSON` };
  }
  if (doc?.kind !== kind) return { warning: `alsem returned kind '${String(doc?.kind)}', expected '${kind}'` };
  const major = Number(String(doc.schemaVersion).split(".")[0]);
  if (major !== SUPPORTED_SCHEMA_MAJOR) return { warning: `alsem ${kind} schemaVersion ${String(doc.schemaVersion)} is not supported (parsed major ${SUPPORTED_SCHEMA_MAJOR}); upgrade bc-dev-mcp or pin alsem` };
  return { payload: doc.payload ?? {} };
}

function proof(payload: Record<string, any>): ProofAnswer {
  const result = payload["result"] ?? {};
  const o = result.obligations ?? {};
  const answer = result.answer === "yes" || result.answer === "no" ? result.answer : "unknown";
  return {
    answer,
    coverageComplete: o.coverageComplete === true,
    unresolvedCallsites: Number(o.unresolvedCallsites ?? 0),
    analysisGaps: Number(o.analysisGaps ?? 0),
    coneTruncated: o.coneTruncated === true,
    openWorldRows: Number(o.openWorldRows ?? 0),
  };
}

export function createAlSemBreakEffects(env: Record<string, string | undefined>, run: StdoutRunner = runForStdout): BreakEffectsProvider {
  const binary = env[ALSEM_ENV_VAR]?.trim() || "alsem";
  let warned = false;
  const soft = (status: "unavailable" | "failed", message: string): BreakEffects => {
    const out: BreakEffects = { status, message };
    if (!warned) {
      warned = true;
      out.warning = message;
    }
    return out;
  };
  return async ({ project, objectName, methodName, inWorkspace }) => {
    if (!inWorkspace) {
      return { status: "symbolOnly", message: `Top frame ${objectName}.${methodName} is in a symbol-only app (not in the workspace); al-sem analyses workspace source only, so no effects were computed.` };
    }
    try {
      const selector = `${objectName}.${methodName}`;
      const first = await run(binary, ["query", "effects", project, "--routine", selector, "--format", "json"]);
      if (first.notFound) return soft("unavailable", `alsem was not found; set ${ALSEM_ENV_VAR} to alsem.exe (al-sem release) or put it on PATH to enrich breaks with effects.`);
      const eff = envelope(first.stdout, EFFECTS_KIND);
      if ("warning" in eff) return soft("failed", eff.warning);
      const r = eff.payload["routine"] ?? {};
      if (r.resolution === "unmatched") return { status: "unmatched", message: `al-sem found no routine '${selector}' in the workspace (is the deployed code in sync with the source?).` };
      if (r.resolution === "ambiguous") {
        return { status: "ambiguous", message: `'${selector}' is overloaded; the break frame does not carry a signature, so effects were not computed. Candidates are listed.`, candidates: r.candidates ?? [] };
      }
      const routine = { display: String(r.routine?.display ?? ""), objectDisplay: String(r.routine?.objectDisplay ?? ""), stableId: String(r.routine?.stableId ?? "") };
      const effects: any[] = (eff.payload["effects"] ?? []).filter((e: any) => WRITE_OPS.has(String(e?.op).toLowerCase()));
      const answers = await Promise.all(
        PROVE_QUESTIONS.map(async ([, question]) => {
          const out = await run(binary, ["prove", project, routine.stableId, question]);
          const env2 = envelope(out.stdout, PROVE_KIND);
          if ("warning" in env2) throw new Error(env2.warning);
          return proof(env2.payload);
        }),
      );
      const proofs = { mayCommit: answers[0]!, throwsError: answers[1]!, reachesUi: answers[2]! };
      const limits = [
        "Table writes list Insert/Modify/Delete-style operations; al-sem #9: Rename is not modelled as a write.",
        // Live 2026-10-13 (BC28, al-sem 1.6.0): a break on "Attempted to divide by zero." in SplitAmount got throwsError "no" with coverageComplete.
        "throwsError covers errors the code raises explicitly; runtime errors (division by zero, overflow, failed conversions) are not modelled, so 'no' does not mean the routine cannot fail.",
      ];
      if (answers.some((a) => !a.coverageComplete || a.unresolvedCallsites > 0)) {
        limits.push("coverageComplete=false or unresolvedCallsites>0: a 'no' is not a proof of absence. al-sem #28: two call sites on one line collapse to one site key, which can hide a call.");
      }
      return {
        status: "ok",
        routine,
        tableWrites: effects.slice(0, MAX_WRITES).map((e) => ({ op: String(e.op), table: String(e.tableName ?? e.tableId), via: String(e.via), temporary: String(e.tempState) })),
        ...(effects.length > MAX_WRITES ? { tableWritesTruncated: true } : {}),
        proofs,
        limits,
      };
    } catch (error) {
      return soft("failed", `alsem enrichment failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
