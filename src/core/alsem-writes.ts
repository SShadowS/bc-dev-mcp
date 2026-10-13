import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AL_OBJECT_TYPE } from "./al-objects";
import { ALSEM_ENV_VAR } from "./call-graph";
import type { RecordWriteOperation, RecordWriteWriterGroup } from "./record-write-triage";

/*
 * Static cross-check for record-write triage: the writer sites al-sem (`alsem query touches` +
 * `alsem query effects`) believes can write one table, diffed against the writer stacks the
 * debugger actually observed. al-sem is OPTIONAL: when it is missing or answers something this
 * reader does not understand, the enrichment is absent with one warning, never an error.
 *
 * Table selector: bc-dev-mcp knows a numeric table id, alsem wants a name or `<appId>/table/<N>`.
 * We try `<app.json id>/table/<tableId>` first (exact, works for tables the project defines) and
 * then the table NAME (the project's own source object, or the runtime name the debugger reported
 * at finish, which is how base-app tables such as Customer get resolved when their symbols are
 * in .alpackages). Dependency tables whose symbols alsem cannot see stay unresolved: no
 * enrichment, one warning.
 */

/** WIRE: alsem JSON envelope {alsemVersion, kind, schemaVersion, payload, diagnostics}; al-sem 1.5.0 (2c48e56f) emits schemaVersion "1.0.0". */
export const ALSEM_QUERY_SCHEMA_MAJOR = 1;
/** Upper bound on routines whose effects are expanded (one alsem call each); beyond it the list is cut and says so. */
export const MAX_SCANNED_ROUTINES = 200;

/** WIRE: `alsem query effects` lists every DB operation, reads (Get, FindLast, ...) included; only these ops write. */
export const WRITE_OPS = new Set(["insert", "modify", "modifyall", "delete", "deleteall", "rename"]);

/** Listed once, verbatim, wherever a static set is shown. */
export const STATIC_WRITER_CAVEATS = [
  "al-sem #28: two call sites on one source line collapse to one site, so one static site can stand for several writes and 'never observed' can hide the second one.",
  "al-sem #9: Rename is not modelled as a write, so rename writers may be missing from the static set and an observed Rename may wrongly show as not statically known.",
  "Only code al-sem can see is covered: routines in dependencies without shipped source cannot appear in the static set.",
];

export interface AlSemRunResult {
  stdout: string;
  exitCode: number;
}

/** Runs alsem and returns stdout even for a non-zero exit (alsem exits 2 with JSON on stdout for an unmatched selector). Rejects with code ENOENT when the binary is missing. */
export type AlSemJsonRunner = (binary: string, args: string[]) => Promise<AlSemRunResult>;

const execFileAsync = promisify(execFile);

export const runAlSemJson: AlSemJsonRunner = async (binary, args) => {
  try {
    const { stdout } = await execFileAsync(binary, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown };
    if (typeof e.code === "number" && typeof e.stdout === "string") return { stdout: e.stdout, exitCode: e.code };
    throw error;
  }
};

export interface StaticWriteSite {
  operation: string;
  /** "Codeunit", "Table", ... as in al-sem's stable routine id. */
  objectType: string;
  objectId: number;
  objectDisplay: string;
  routine: string;
  /** Workspace-relative path (the `ws:` prefix is stripped), 1-based line (al-sem reports 0-based; converted in effectsOf). */
  file: string;
  line: number;
  /** al-sem tempState: known(false) | known(true) | unknown. */
  tempState: string;
  /** direct = the routine itself writes; inherited = reached through a callee (the origin site is listed once). */
  via: string;
}

export interface StaticWriters {
  engine: "al-sem";
  alsemVersion: string;
  table: { selector: string; name: string | null };
  routinesScanned: number;
  /** Writes proven to target the table. */
  sites: StaticWriteSite[];
  /** Writes whose target table al-sem could not resolve (RecordRef, Variant...): any of them might hit this table. */
  unknownBucketSites: StaticWriteSite[];
  caveats: string[];
}

export interface StaticWritersResult {
  writers: StaticWriters | null;
  warnings: string[];
}

export interface StaticWritersRequest {
  project: string;
  tableId: number;
  /** Table name when known (source object, or the runtime name observed by the debugger). */
  tableName?: string | null;
  includeTemporary: boolean;
}

/** Never rejects. */
export type StaticWritersProvider = (request: StaticWritersRequest) => Promise<StaticWritersResult>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

class SoftFail extends Error {}

/** Parses an alsem envelope of `kind`, failing soft (SoftFail) on bad JSON, wrong kind or an unknown schema major. */
function parseEnvelope(stdout: string, kind: string): { version: string; payload: Record<string, unknown> } {
  let json: Record<string, unknown> | undefined;
  try {
    json = obj(JSON.parse(stdout));
  } catch {
    throw new SoftFail(`alsem ${kind} output is not JSON`);
  }
  if (!json || json["kind"] !== kind) throw new SoftFail(`alsem output kind '${String(json?.["kind"])}' is not '${kind}'`);
  const schema = str(json["schemaVersion"]) ?? "";
  if (Number.parseInt(schema, 10) !== ALSEM_QUERY_SCHEMA_MAJOR) {
    throw new SoftFail(`alsem ${kind} schemaVersion '${schema}' is not supported (this reader knows major ${ALSEM_QUERY_SCHEMA_MAJOR})`);
  }
  const payload = obj(json["payload"]);
  if (!payload) throw new SoftFail(`alsem ${kind} output has no payload`);
  return { version: str(json["alsemVersion"]) ?? "", payload };
}

interface RoutineRef {
  stableId: string;
}

function routinesOf(payload: Record<string, unknown>): RoutineRef[] {
  const list = obj(payload["up"])?.["routines"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((r) => {
    const stableId = str(obj(r)?.["stableId"]);
    return stableId ? [{ stableId }] : [];
  });
}

interface RawEffect {
  operationId: string;
  site: StaticWriteSite;
  unknownBucket: boolean;
}

/** `<appId>:Codeunit:50171#<hash>` */
const STABLE_ID = /:([A-Za-z]+):(\d+)#/;

/** `tableId` = the watched table's al-sem id: a routine that touches it may also write other tables, whose effects must not leak into the set. */
function effectsOf(payload: Record<string, unknown>, tableId: string | undefined): RawEffect[] {
  const list = payload["effects"];
  if (!Array.isArray(list)) return [];
  const out: RawEffect[] = [];
  for (const raw of list) {
    const e = obj(raw);
    const op = str(e?.["op"]);
    if (!e || !op || !WRITE_OPS.has(op.toLowerCase())) continue;
    const origin = obj(e["origin"]);
    const routine = obj(origin?.["routine"]);
    const anchor = obj(origin?.["anchor"]);
    const id = STABLE_ID.exec(str(routine?.["stableId"]) ?? "");
    const anchorLine = anchor?.["line"];
    if (!id || typeof anchorLine !== "number") continue;
    const unknownBucket = e["isUnknownBucket"] === true;
    if (!unknownBucket && str(e["tableId"]) !== tableId) continue;
    // WIRE: al-sem anchor line/column are 0-based (fixture: Insert on file line 8 -> 7); the tool surface is 1-based.
    const line = anchorLine + 1;
    out.push({
      operationId: str(e["operationId"]) ?? `${id[1]}:${id[2]}:${line}:${op}`,
      unknownBucket,
      site: {
        operation: op,
        objectType: id[1]!,
        objectId: Number(id[2]),
        objectDisplay: str(routine?.["objectDisplay"]) ?? "",
        routine: str(routine?.["display"]) ?? "",
        file: (str(anchor?.["file"]) ?? "").replace(/^ws:/, ""),
        line,
        tempState: str(e["tempState"]) ?? "unknown",
        via: str(e["via"]) ?? "",
      },
    });
  }
  return out;
}

async function appIdOf(project: string): Promise<string | undefined> {
  try {
    return str(JSON.parse(await readFile(join(project, "app.json"), "utf8"))?.id);
  } catch {
    return undefined;
  }
}

/** Runs `fn` over `items` four at a time, keeping order. */
async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** The al-sem-backed provider. A missing binary, a failing query or an unknown schema major all yield `writers: null` with exactly one warning. */
export function createAlSemStaticWritersProvider(
  env: Record<string, string | undefined>,
  run: AlSemJsonRunner = runAlSemJson,
): StaticWritersProvider {
  const binary = env[ALSEM_ENV_VAR]?.trim() || "alsem";
  return async ({ project, tableId, tableName, includeTemporary }) => {
    try {
      const appId = await appIdOf(project);
      const selectors = [...(appId ? [`${appId}/table/${tableId}`] : []), ...(tableName ? [tableName] : [])];
      if (selectors.length === 0) throw new SoftFail("no app.json id or table name to build an alsem table selector from");
      const query = async (kind: string, args: string[]) =>
        parseEnvelope((await run(binary, ["query", ...args, project, "--format", "json", "--deterministic"])).stdout, kind);

      let version = "";
      let resolved: { selector: string; name: string | null; id: string | undefined; routines: RoutineRef[] } | undefined;
      for (const selector of selectors) {
        const touches = await query("query.touches", ["touches", "--table", selector]);
        version = touches.version;
        const table = obj(touches.payload["table"]);
        if (table?.["resolution"] === "resolved") {
          resolved = { selector, name: str(table["name"]) ?? null, id: str(table["id"]), routines: routinesOf(touches.payload) };
          break;
        }
      }
      if (!resolved) throw new SoftFail(`alsem could not resolve table ${tableId} (tried ${selectors.map((s) => `'${s}'`).join(", ")}); its symbols may be missing from .alpackages`);

      const unknown = await query("query.touches", ["touches", "--table", "unknown"]);
      const routines = [...new Map([...resolved.routines, ...routinesOf(unknown.payload)].map((r) => [r.stableId, r])).values()];
      const warnings: string[] = [];
      const scanned = routines.slice(0, MAX_SCANNED_ROUTINES);
      if (routines.length > scanned.length) {
        warnings.push(`al-sem lists ${routines.length} routines touching the table; only the first ${MAX_SCANNED_ROUTINES} were expanded, so the static set is incomplete.`);
      }
      const tableAlsemId = resolved.id;
      if (!tableAlsemId) throw new SoftFail("alsem touches output carries no table id, so effects cannot be matched to the table");
      const effects = await mapLimited(scanned, async (r) => effectsOf((await query("query.effects", ["effects", "--routine", r.stableId])).payload, tableAlsemId));

      const seen = new Set<string>();
      const sites: StaticWriteSite[] = [];
      const unknownBucketSites: StaticWriteSite[] = [];
      for (const effect of effects.flat()) {
        if (seen.has(effect.operationId)) continue;
        seen.add(effect.operationId);
        if (effect.unknownBucket) {
          unknownBucketSites.push(effect.site);
        } else if (includeTemporary || effect.site.tempState !== "known(true)") {
          sites.push(effect.site);
        }
      }
      return {
        writers: {
          engine: "al-sem",
          alsemVersion: version,
          table: { selector: resolved.selector, name: resolved.name },
          routinesScanned: scanned.length,
          sites,
          unknownBucketSites,
          caveats: STATIC_WRITER_CAVEATS,
        },
        warnings,
      };
    } catch (error) {
      const missing = (error as { code?: unknown })?.code === "ENOENT";
      const why = missing
        ? `'${binary}' was not found (set ${ALSEM_ENV_VAR} or put alsem on PATH)`
        : error instanceof Error ? error.message : String(error);
      return { writers: null, warnings: [`al-sem static writer cross-check unavailable: ${why}.`] };
    }
  };
}

export interface ObservedWriterNotStatic {
  operation: RecordWriteOperation;
  receiver: string;
  count: number;
  /** The write statement's frame (innermost). */
  frame: { objectType: number; objectId: number; objectName: string; methodName: string; line: number; file?: string };
  /** true = al-sem knows a write at this site but could not resolve its target table (the unknown bucket). */
  inUnknownBucket: boolean;
}

export interface StaticWriterDiff {
  matched: number;
  /** Statically possible, never observed in this capture. */
  staticNotObserved: StaticWriteSite[];
  /** Observed, but not in al-sem's proven set for the table (flagged when it is in the unknown bucket). */
  observedNotStatic: ObservedWriterNotStatic[];
  /** false = the capture was incomplete, so "never observed" proves little. */
  observationComplete: boolean;
  caveats: string[];
}

function siteMatches(site: StaticWriteSite, group: RecordWriteWriterGroup): boolean {
  const frame = group.stack[0];
  if (!frame || site.operation.toLowerCase() !== group.operation.toLowerCase()) return false;
  if ((AL_OBJECT_TYPE[site.objectType.toLowerCase()] ?? -1) !== frame.objectType || site.objectId !== frame.objectId) return false;
  const span = frame.statementSpan;
  return span ? site.line >= span.from.line && site.line <= span.to.line : site.line === frame.line;
}

/** Pure: diffs the static set against the observed writer groups (site = write op + object + line). */
export function diffStaticVsObserved(
  writers: StaticWriters,
  observed: RecordWriteWriterGroup[],
  observationComplete: boolean,
): StaticWriterDiff {
  const hit = new Set<StaticWriteSite>();
  const observedNotStatic: ObservedWriterNotStatic[] = [];
  for (const group of observed) {
    const frame = group.stack[0];
    const matches = writers.sites.filter((site) => siteMatches(site, group));
    matches.forEach((site) => hit.add(site));
    if (matches.length > 0 || !frame) continue;
    observedNotStatic.push({
      operation: group.operation,
      receiver: group.receiver,
      count: group.count,
      frame: {
        objectType: frame.objectType,
        objectId: frame.objectId,
        objectName: frame.objectName,
        methodName: frame.methodName,
        line: frame.line,
        ...(frame.file ? { file: frame.file } : {}),
      },
      inUnknownBucket: writers.unknownBucketSites.some((site) => siteMatches(site, group)),
    });
  }
  return {
    matched: hit.size,
    staticNotObserved: writers.sites.filter((site) => !hit.has(site)),
    observedNotStatic,
    observationComplete,
    caveats: writers.caveats,
  };
}
