import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { ALSEM_ENV_VAR, failed, runCommand, unavailable, type CommandRunner } from "./call-graph";
import type { TestOrderAnalysis } from "./test-order-analysis";
import type { BisectResult } from "./test-order-bisect";
import { identityKey, type OrchestratedTestIdentity } from "./test-orchestration";

/*
 * Static pre-screen for order pollution (bcdev_test_orchestrate mode "order"), from al-sem:
 * one `alsem digest <project> --file <test codeunit file>...` gives each test's typed write effects
 * (DB_INSERT/MODIFY/DELETE, resourceId = table) and COMMIT guarantees; one
 * `alsem query touches --table <id>` per committed table names every routine that touches it.
 * `--file` rather than `--routine`: a bare routine name is ambiguous across codeunits and one
 * unmatched selector voids the whole digest (exit 2, no entries) — al-sem 1.5.0.
 * al-sem does not know the runner's isolation, so it is applied here (scripts/e2e.md #33, #15).
 * The predicted pairs are hints: they seed the bisect and are checked against its result.
 */

/** WIRE: al-sem JSON envelope majors this reader knows (digest 1.3.0, query.touches 1.0.0; al-sem 1.5.0). */
const ALSEM_MAJORS = { digest: 1, "query.touches": 1 } as const;

export interface OrderPredictionMethod extends OrchestratedTestIdentity {
  /** [TransactionModel] value; "AutoCommit" when absent. */
  transactionModel: string;
  /** Source file of the test codeunit. */
  file: string;
}

export interface PredictedPollution {
  polluter: OrchestratedTestIdentity;
  victim: OrchestratedTestIdentity;
  /** al-sem table id (`<appId>/table/<n>`) and name; null = al-sem's unresolved-table bucket. */
  table: { id: string; name: string | null } | null;
  /** explicitCommit: a Commit() is committed before the polluter returns, so it survives even if the test fails. */
  survives: "explicitCommit" | "transactionModel";
  reason: string;
}

export type PredictionVerdict = "confirmed" | "refuted" | "unresolved";

export interface ExplainedPrediction extends PredictedPollution {
  dynamic: PredictionVerdict;
  evidence: string;
}

export interface OrderPollutionPrediction {
  alsemVersion: string;
  pairs: PredictedPollution[];
}

/** Never throws: al-sem missing or failing leaves `prediction` null with one warning. */
export type OrderPollutionPredictor = (
  project: string,
  selection: readonly OrderPredictionMethod[],
) => Promise<{ prediction: OrderPollutionPrediction | null; warnings: string[] }>;

export const STATIC_PREDICTION_NOTE =
  "Static hints from al-sem; the bisect result is the truth. Isolation applied here, not by al-sem: the hub rolls each "
  + "codeunit group back (even Commit()), so only a same-codeunit method declared above the victim can pollute it, and only "
  + "AutoCommit/None methods' writes outlive the method. A victim is any later method whose call cone touches the table "
  + "(read or write). Not seen: Rename writes (al-sem #9), session state (SingleInstance globals, NumberSequence.Next, "
  + "files) and the codeunit's OnRun (it runs before every method, isolation included, so it is never order-dependent). "
  + "Writes to temporary records are dropped and dependency tables (e.g. Customer) resolve from al-sem 1.7.0; "
  + "with an older al-sem they count as writes and stay null. table null = al-sem could not resolve the table: a weak hint.";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Envelope {alsemVersion, kind, schemaVersion, payload, diagnostics}: the payload, or a warning string. */
export function readAlSemEnvelope(text: string, kind: keyof typeof ALSEM_MAJORS): { payload: Json; alsemVersion: string } | string {
  let env: Json;
  try {
    env = obj(JSON.parse(text));
  } catch {
    return `al-sem ${kind} output is not JSON`;
  }
  if (env["kind"] !== kind) return `al-sem output kind '${String(env["kind"])}' is not '${kind}'`;
  const major = Number(String(env["schemaVersion"] ?? "").split(".")[0]);
  if (major !== ALSEM_MAJORS[kind]) {
    return `al-sem ${kind} schemaVersion ${String(env["schemaVersion"])} is not supported (this reader knows ${ALSEM_MAJORS[kind]}.x)`;
  }
  return { payload: obj(env["payload"]), alsemVersion: str(env["alsemVersion"]) ?? "" };
}

/** `<appId>:Codeunit:<id>#<hash>` + display name -> identityKey, or undefined for non-codeunit routines. */
function routineKey(routine: unknown): string | undefined {
  const r = obj(routine);
  const id = /:Codeunit:(\d+)#/.exec(str(r["stableId"]) ?? "")?.[1];
  const name = str(r["display"]);
  return id && name ? identityKey(Number(id), name) : undefined;
}

const tableKey = (table: PredictedPollution["table"]) => table?.id ?? "unknown";

export interface DigestWrites {
  /** Written tables (unknown bucket = null), by identityKey. */
  writes: Map<string, Map<string, PredictedPollution["table"]>>;
  /** identityKeys whose writes are committed before return by an explicit Commit(). */
  explicitCommit: Set<string>;
  warnings: string[];
}

/** Pure: a digest payload's per-routine writes and commit guarantees. */
export function digestWrites(payload: Json): DigestWrites {
  const writes = new Map<string, Map<string, PredictedPollution["table"]>>();
  const explicitCommit = new Set<string>();
  const warnings: string[] = [];
  const unresolvedRoots = arr(payload["changedRootsDiagnostics"]).map((d) => str(obj(d)["kind"]) ?? "unknown");
  if (unresolvedRoots.length > 0) warnings.push(`al-sem digest root diagnostics: ${unresolvedRoots.join(", ")}`);
  for (const entry of arr(payload["entries"]).map(obj)) {
    const key = routineKey(entry["routine"]);
    if (!key) continue;
    const coverage = obj(entry["coverage"]);
    if (coverage["status"] !== "complete") {
      warnings.push(`al-sem coverage of ${str(obj(entry["routine"])["display"])} is ${String(coverage["status"])}: its writes may be incomplete`);
    }
    for (const effect of arr(entry["effects"]).map(obj)) {
      const type = str(effect["type"]);
      if (type === "COMMIT" && arr(effect["guarantees"]).includes("WRITE_COMMITTED_BEFORE_RETURN")) explicitCommit.add(key);
      if (type !== "DB_INSERT" && type !== "DB_MODIFY" && type !== "DB_DELETE") continue;
      const detail = obj(effect["detail"]);
      if (detail["tempState"] === "known(true)") continue; // temp-only write (al-sem >= 1.7.0, #65)
      const id = str(detail["resourceId"]);
      const table = id ? { id, name: str(detail["resourceDisplay"]) ?? null } : null;
      const tables = writes.get(key) ?? new Map();
      tables.set(tableKey(table), table);
      writes.set(key, tables);
    }
  }
  return { writes, explicitCommit, warnings };
}

/** Pure: identityKeys of the routines a query.touches payload lists. */
export function touchingRoutines(payload: Json): Set<string> {
  const keys = new Set<string>();
  for (const side of ["up", "down"]) {
    for (const routine of arr(obj(payload[side])["routines"])) {
      const key = routineKey(routine);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/** Writes outlive the method unless it is AutoRollback (live BC28, scripts/e2e.md #33). */
export const writesSurviveMethod = (transactionModel: string) => transactionModel.toLowerCase() !== "autorollback";

/**
 * Pure: polluter -> victim pairs. `selection` is in declaration order per codeunit (one group
 * each). A polluter is a non-AutoRollback method that writes a table; its victims are methods of
 * the same codeunit declared below it whose cone touches that table (`touches` by tableKey).
 */
export function predictOrderPollution(
  selection: readonly OrderPredictionMethod[],
  digest: DigestWrites,
  touches: ReadonlyMap<string, ReadonlySet<string>>,
): PredictedPollution[] {
  const pairs: PredictedPollution[] = [];
  selection.forEach((polluter, index) => {
    const pKey = identityKey(polluter.codeunitId, polluter.method);
    if (!writesSurviveMethod(polluter.transactionModel)) return;
    const explicit = digest.explicitCommit.has(pKey);
    for (const [tKey, table] of digest.writes.get(pKey) ?? []) {
      const touchers = touches.get(tKey);
      if (!touchers) continue;
      for (const victim of selection.slice(index + 1)) {
        if (victim.codeunitId !== polluter.codeunitId) continue; // other groups are rolled back first
        if (!touchers.has(identityKey(victim.codeunitId, victim.method))) continue;
        const name = table ? `table ${table.name ?? table.id}` : "a table al-sem could not resolve";
        pairs.push({
          polluter: { codeunitId: polluter.codeunitId, method: polluter.method },
          victim: { codeunitId: victim.codeunitId, method: victim.method },
          table,
          survives: explicit ? "explicitCommit" : "transactionModel",
          reason: `${polluter.method} ${explicit ? "commits (explicit Commit() before it returns)" : `writes under ${polluter.transactionModel} (committed when it passes)`} `
            + `to ${name}; ${victim.method}, declared below it in codeunit ${victim.codeunitId}, touches ${table ? "it" : "an unresolved table too"}`,
        });
      }
    }
  });
  return pairs;
}

/** Pure: check each predicted pair against the dynamic analysis and bisection. */
export function explainPredictions(
  pairs: readonly PredictedPollution[],
  analysis: TestOrderAnalysis,
  bisection: BisectResult,
): ExplainedPrediction[] {
  const same = (a: OrchestratedTestIdentity, b: OrchestratedTestIdentity) =>
    identityKey(a.codeunitId, a.method) === identityKey(b.codeunitId, b.method);
  return pairs.map((pair) => {
    const bisected = bisection.victims.find((v) => same(v, pair.victim));
    const tested = analysis.tests.find((t) => same(t, pair.victim));
    const verdict = (dynamic: PredictionVerdict, evidence: string): ExplainedPrediction => ({ ...pair, dynamic, evidence });
    if (bisected?.polluter && same(bisected.polluter, pair.polluter)) {
      return verdict("confirmed", `bisection found ${pair.polluter.method} as ${pair.victim.method}'s polluter`);
    }
    if (bisected?.predictionProbes?.some((p) => same(p.polluter, pair.polluter) && p.reproduced === false)) {
      return verdict("refuted", `${pair.victim.method} passed when run right after ${pair.polluter.method}`);
    }
    if (tested?.classification === "consistentPass") {
      return verdict("refuted", `${pair.victim.method} passed in every order, including after ${pair.polluter.method} in its group`);
    }
    return verdict("unresolved", bisected
      ? `bisection outcome ${bisected.outcome}${bisected.polluter ? ` (polluter ${bisected.polluter.method})` : ""}`
      : `${pair.victim.method} is ${tested?.classification ?? "not in the selection"}, so it was not bisected`);
  });
}

/** Runs al-sem (BC_DEV_ALSEM or `alsem` on PATH); optional, so every failure becomes one warning. */
export function createAlSemOrderPredictor(
  env: Record<string, string | undefined>,
  run: CommandRunner = runCommand,
): OrderPollutionPredictor {
  const binary = env[ALSEM_ENV_VAR]?.trim() || "alsem";
  return async (project, selection) => {
    const skipped = (why: string) => ({ prediction: null, warnings: [`Static pollution prediction skipped: ${why}`] });
    let work: string | undefined;
    try {
      work = await mkdtemp(join(tmpdir(), "bcdev-alsem-order-"));
      let outputs = 0;
      const alsem = async (step: string, args: string[], kind: keyof typeof ALSEM_MAJORS) => {
        const out = join(work!, `${outputs++}.json`);
        try {
          await run(binary, [...args, "--out", out]);
        } catch (error) {
          if ((error as { code?: unknown })?.code === "ENOENT") return unavailable(binary, ALSEM_ENV_VAR, "(alsem.exe from an al-sem release) ", error).message;
          return failed(binary, step, error, "Check that the project has an app.json.").message;
        }
        return readAlSemEnvelope(await readFile(out, "utf8"), kind);
      };
      const root = resolve(project);
      const files = [...new Set(selection.map((m) => relative(root, resolve(m.file)).replaceAll("\\", "/")))];
      const digested = await alsem("alsem digest", ["digest", root, ...files.flatMap((f) => ["--file", f])], "digest");
      if (typeof digested === "string") return skipped(digested);
      const digest = digestWrites(digested.payload);
      const warnings = [...digest.warnings];

      const tables = new Set<string>();
      for (const m of selection) {
        if (!writesSurviveMethod(m.transactionModel)) continue;
        for (const t of digest.writes.get(identityKey(m.codeunitId, m.method))?.keys() ?? []) tables.add(t);
      }
      const touches = new Map<string, Set<string>>();
      for (const table of tables) {
        const queried = await alsem("alsem query touches", ["query", "touches", root, "--table", table, "--format", "json"], "query.touches");
        if (typeof queried === "string") warnings.push(`al-sem touches for ${table} skipped: ${queried}`);
        else touches.set(table, touchingRoutines(queried.payload));
      }
      return { prediction: { alsemVersion: digested.alsemVersion, pairs: predictOrderPollution(selection, digest, touches) }, warnings };
    } catch (error) {
      return skipped(error instanceof Error ? error.message : String(error));
    } finally {
      if (work) await rm(work, { recursive: true, force: true });
    }
  };
}
