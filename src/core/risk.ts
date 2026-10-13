import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ALSEM_ENV_VAR, runCommand, toolOutput, type CommandRunner } from "./call-graph";
import { AL_OBJECT_TYPE } from "./al-objects";

/*
 * Risk annotation of changed-but-untested routines (al-sem `alsem digest`). Optional enrichment:
 * a missing or failing alsem only adds one warning, never fails a tool.
 *
 * WIRE: `alsem digest <project> --file <f>... --out <file>` (al-sem 1.5.0): envelope
 * {alsemVersion, kind: "digest", schemaVersion: "1.x.y", payload.entries[]}; each entry has
 * routine {display, stableId "<appId>:<ObjectType>:<id>#<hash>", anchor {file "ws:<rel>", line 0-based}},
 * effects[] {type, detail.resourceDisplay (table for DB_*)} and unresolved[].
 * `--diff` is NOT used: al-sem 1.5.0 resolves a hunk to a routine only when the line carries a
 * call/effect site (a changed `x := 0;` or `exit(...)` line resolves nothing), so whole changed
 * files are digested and joined to the changed procedures here by object + name + location.
 * Known al-sem limits: #28 (two call sites on one line collapse to one site, so effects on such a
 * line can be under-reported), #9 (Record.Rename is not modelled as a write).
 */

export const ALSEM_DIGEST_MAJOR = 1;

export type RiskLevel = "commits" | "writes" | "error-ui" | "none";
const RANK: Record<RiskLevel, number> = { commits: 3, writes: 2, "error-ui": 1, none: 0 };

export interface RoutineRisk {
  level: RiskLevel;
  /** Short text, e.g. "commits; writes Sales Header". */
  summary: string;
  commits: boolean;
  /** Tables written (insert/modify/delete), sorted. */
  writes: string[];
  errors: boolean;
  ui: boolean;
  /** Calls al-sem could not resolve (effects may be missing). */
  unresolved: number;
}

export interface DigestEntry {
  display: string;
  objectType: string;
  objectId: number;
  /** Workspace-relative file, or "" when absent. */
  file: string;
  /** 1-based line of the routine declaration, or 0 when absent. */
  line: number;
  risk: RoutineRisk;
}

export interface RiskDigest {
  entries: DigestEntry[];
  warnings: string[];
}

export type RiskDigestProvider = (project: string, relativeFiles: string[]) => Promise<RiskDigest>;

const WRITE_EFFECTS = new Set(["DB_INSERT", "DB_MODIFY", "DB_DELETE"]);
const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

function summarize(effects: Record<string, unknown>[], unresolved: number): RoutineRisk {
  const types = new Set(effects.map((e) => String(e["type"])));
  const writes = new Set<string>();
  for (const e of effects) {
    if (!WRITE_EFFECTS.has(String(e["type"]))) continue;
    const detail = asRecord(e["detail"]);
    const table = detail["resourceDisplay"] ?? detail["resourceId"];
    writes.add(typeof table === "string" && table !== "" ? table : "unknown table");
  }
  const commits = types.has("COMMIT");
  const errors = types.has("ERROR_THROW");
  const ui = [...types].some((t) => t.startsWith("UI_") && t !== "UI_ERROR");
  const level: RiskLevel = commits ? "commits" : writes.size > 0 ? "writes" : errors || ui ? "error-ui" : "none";
  const parts = [
    ...(commits ? ["commits"] : []),
    ...(writes.size > 0 ? [`writes ${[...writes].sort().join(", ")}`] : []),
    ...(errors ? ["can throw an error"] : []),
    ...(ui ? ["shows UI"] : []),
  ];
  if (parts.length === 0) parts.push("no db writes, commit, error or UI found");
  if (unresolved > 0) parts.push(`${unresolved} unresolved call(s), effects may be incomplete`);
  return { level, summary: parts.join("; "), commits, writes: [...writes].sort(), errors, ui, unresolved };
}

/** Parses an `alsem digest` JSON envelope. Throws a plain Error (caller turns it into a warning). */
export function parseAlSemDigest(text: string): DigestEntry[] {
  const envelope = asRecord(JSON.parse(text));
  if (envelope["kind"] !== "digest") throw new Error(`al-sem output kind '${String(envelope["kind"])}' is not 'digest'`);
  const major = Number(String(envelope["schemaVersion"]).split(".")[0]);
  if (major !== ALSEM_DIGEST_MAJOR) {
    throw new Error(`al-sem digest schemaVersion '${String(envelope["schemaVersion"])}' is not supported (this reader knows major ${ALSEM_DIGEST_MAJOR})`);
  }
  const entries = asRecord(envelope["payload"])["entries"];
  const result: DigestEntry[] = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = asRecord(raw);
    const routine = asRecord(entry["routine"]);
    const id = /:([A-Za-z]+):(\d+)#/.exec(String(routine["stableId"] ?? ""));
    if (!id || typeof routine["display"] !== "string") continue;
    const anchor = asRecord(routine["anchor"]);
    const file = typeof anchor["file"] === "string" ? anchor["file"].replace(/^ws:/, "") : "";
    const effects = (Array.isArray(entry["effects"]) ? entry["effects"] : []).map(asRecord);
    const unresolved = Array.isArray(entry["unresolved"]) ? entry["unresolved"].length : 0;
    result.push({
      display: routine["display"],
      objectType: id[1]!.toLowerCase(),
      objectId: Number(id[2]),
      file,
      line: typeof anchor["line"] === "number" ? anchor["line"] + 1 : 0,
      risk: summarize(effects, unresolved),
    });
  }
  return result;
}

/** Runs `alsem digest` over the given changed files. Never throws: problems become warnings. */
export function createAlSemRiskProvider(
  env: Record<string, string | undefined>,
  run: CommandRunner = runCommand,
): RiskDigestProvider {
  const binary = env[ALSEM_ENV_VAR]?.trim() || "alsem";
  return async (project, relativeFiles) => {
    if (relativeFiles.length === 0) return { entries: [], warnings: [] };
    const work = await mkdtemp(join(tmpdir(), "bcdev-alsem-digest-"));
    try {
      const out = join(work, "digest.json");
      try {
        await run(binary, ["digest", resolve(project), ...relativeFiles.flatMap((f) => ["--file", f]), "--deterministic", "--out", out]);
      } catch (error) {
        const reason = (error as { code?: unknown })?.code === "ENOENT"
          ? `alsem was not found (set ${ALSEM_ENV_VAR} or put it on PATH)`
          : `alsem digest failed: ${toolOutput(error) || String(error)}`;
        return { entries: [], warnings: [`Risk annotation unavailable: ${reason}.`] };
      }
      try {
        return { entries: parseAlSemDigest(await readFile(out, "utf8")), warnings: [] };
      } catch (error) {
        return { entries: [], warnings: [`Risk annotation unavailable: ${error instanceof Error ? error.message : String(error)}.`] };
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}

export interface RiskSubject {
  objectType: number;
  objectId: number;
  name: string;
  relativeFile: string;
  startLine: number;
  endLine?: number;
}

/** The digest entry for a changed procedure (al-sem lists only routines with effects; none = no entry): same object type + id + name; overloads split by location. */
export function findRisk(entries: DigestEntry[], subject: RiskSubject): RoutineRisk | undefined {
  const typeName = Object.keys(AL_OBJECT_TYPE).find((k) => AL_OBJECT_TYPE[k] === subject.objectType);
  const same = entries.filter((e) =>
    e.objectId === subject.objectId && e.objectType === typeName && e.display.toLowerCase() === subject.name.toLowerCase());
  if (same.length <= 1) return same[0]?.risk;
  const file = subject.relativeFile.replace(/\\/g, "/").toLowerCase();
  // Discovery starts at the first attribute, al-sem at the keyword: the anchor is at or after startLine.
  const inSpan = same.filter((e) =>
    e.file.toLowerCase() === file && e.line >= subject.startLine && (subject.endLine === undefined || e.line <= subject.endLine));
  return inSpan.sort((a, b) => a.line - b.line)[0]?.risk;
}

/** Highest risk first; equal risk keeps input order. Items without risk sort with `none`. */
export function sortByRisk<T extends { risk?: RoutineRisk }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => RANK[b.item.risk?.level ?? "none"] - RANK[a.item.risk?.level ?? "none"] || a.index - b.index)
    .map(({ item }) => item);
}

/** Attaches `risk` to every item the digest knows; items it does not know are left untouched. */
export async function annotateRisk<T extends RiskSubject>(
  items: T[],
  provider: RiskDigestProvider | undefined,
  project: string,
): Promise<{ items: Array<T & { risk?: RoutineRisk }>; warnings: string[] }> {
  if (!provider || items.length === 0) return { items, warnings: [] };
  const digest = await provider(project, [...new Set(items.map((i) => i.relativeFile))].sort());
  return {
    items: items.map((item) => {
      const risk = findRisk(digest.entries, item);
      return risk ? { ...item, risk } : item;
    }),
    warnings: digest.warnings,
  };
}
