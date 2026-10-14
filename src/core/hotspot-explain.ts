import { execFile } from "node:child_process";
import { envAlSemBinary, type AlSemBinary } from "./alsem-binary";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { AlObjectIndex } from "./al-objects";
import { ALSEM_ENV_VAR, toolOutput } from "./call-graph";
import type { Hotspot } from "./snapshot/profile-summary";

/*
 * Explains ranked AL self-time hotspots with al-sem's static performance findings. al-sem is
 * OPTIONAL: when `alsem` is missing, too slow, too large or answers with a schema this reader
 * does not know, the hotspots come back unchanged plus one warning — never an error.
 *
 * Join: a finding is attached to a hotspot when both sit in the same object (the profile frame's
 * `Codeunit_50100.dal` url, or a real `.al` path, against the finding's object / file) and the
 * finding's routine (`primaryLocation.routineName`) is the hotspot's function. Overloads share a
 * name, so they share findings. Profile line numbers are lines of the generated .dal, not of the
 * .al source, so lines never take part in the join. A frame url has no app segment, so when the
 * frame names its declaring app (Hotspot.appId) and the workspace's app.json id differs, the
 * frame is another app's and is neither attached to nor counted as a workspace hotspot.
 *
 * Limits of what al-sem reports today (so absence of a finding is not proof of absence):
 * SShadowS/al-sem#9 — Rename is not modelled as a write, so a rename in a loop is not flagged.
 */

/** Detector ids that explain slow code. Unstable on al-sem's side: an id alsem rejects is dropped, an unlisted id in the output is passed through. */
export const PERF_DETECTORS = [
  "d1-db-op-in-loop",
  "d2-event-fanout-in-loop",
  "d3-missing-setloadfields",
  "d4-repeated-lookup-in-loop",
  "d5-set-based-opportunity",
  "d18-constant-filter-in-loop",
  "d21-read-without-load",
  "d22-flowfield-without-calcfields",
  "d33-unfiltered-bulk-write",
  "d36-late-setloadfields",
  "d40-transitive-load-missing",
  "d42-cross-call-wrong-setloadfields",
  "d48-io-in-loop",
  "d55-event-publish-in-loop",
  "d56-clone-before-write-in-loop",
  "d58-query-filter-after-open",
  "d60-upgrade-loop-should-be-datatransfer",
];

/** WIRE: `alsem analyze --format json` envelope kind, and the schemaVersion major read (1.0.0; 1.1.0 with --with-evidence). */
export const ALSEM_ANALYZE_KIND = "analyze-report";
export const ALSEM_ANALYZE_MAJOR = 1;

export const MAX_FINDINGS_PER_HOTSPOT = 5;
export const MAX_EVIDENCE_STEPS = 8;
export const DEFAULT_MAX_AL_FILES = 3000;
export const DEFAULT_ANALYZE_TIMEOUT_MS = 120_000;

export interface EvidenceStep {
  note: string;
  file?: string;
  /** 1-based. */
  line?: number;
}
export interface HotspotFinding {
  detector: string;
  title: string;
  confidence: string;
  severity?: string;
  /** Workspace-relative path al-sem reports ("src/Foo.Codeunit.al"). */
  file: string;
  /** 1-based line of the finding's primary location. */
  line: number;
  rootCause?: string;
  /** Call chain / loop to the costly operation, as al-sem's evidencePath. */
  evidence: EvidenceStep[];
  fix?: string;
  fixSafety?: string;
  /** Field/action whose trigger holds the routine, when the routine is a member trigger. */
  enclosingMember?: string;
}
export type ExplainedHotspot = Hotspot & { findings?: HotspotFinding[]; omittedFindings?: number };

export interface HotspotAnalysis {
  source: "al-sem";
  alsemVersion: string;
  detectors: string[];
  findingsTotal: number;
  /** Findings attached to a hotspot. */
  findingsMatched: number;
  notes: string[];
}
export interface ExplainResult {
  hotspots: ExplainedHotspot[];
  analysis?: HotspotAnalysis;
  warnings: string[];
}

/** Runs `alsem analyze` and returns its stdout. Rejects like execFile (ENOENT code, stderr, killed). */
export type AlSemAnalyze = (project: string, detectors: string[], timeoutMs: number) => Promise<string>;

const execFileAsync = promisify(execFile);

export function createAlSemAnalyze(env: Record<string, string | undefined>, alsemBinary: AlSemBinary = envAlSemBinary(env)): AlSemAnalyze {
  return async (project, detectors, timeoutMs) => {
    const { stdout } = await execFileAsync(
      await alsemBinary(),
      ["analyze", resolve(project), "--format", "json", "--with-evidence", "--single-app", "--detector", detectors.join(",")],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    return stdout;
  };
}

const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

interface ParsedFinding extends HotspotFinding {
  objectKey?: string;
  routine: string;
}

/** "<appId>/Codeunit/50100" or a url/path naming `Codeunit_50100.dal` -> "codeunit_50100". */
function objectKeyFromId(objectId: string | undefined): string | undefined {
  const parts = objectId?.split("/");
  return parts && parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1]!) ? `${parts[parts.length - 2]!.toLowerCase()}_${parts[parts.length - 1]}` : undefined;
}
const DAL_URL = /([A-Za-z]+)_(\d+)\.dal(?:$|[?#])/;
function objectKeyFromUrl(url: string): string | undefined {
  const m = DAL_URL.exec(url);
  return m ? `${m[1]!.toLowerCase()}_${m[2]}` : undefined;
}
const stripWs = (file: string): string => file.replace(/^[^:/\\]+:(?!\/\/)/, "").replace(/\\/g, "/");

/** Reads one al-sem analyze envelope. Never throws: an unreadable or unknown-major envelope is a warning. */
export function parseAlSemAnalyze(text: string): { findings: ParsedFinding[]; alsemVersion: string; warnings: string[] } {
  const none = (warning: string) => ({ findings: [], alsemVersion: "", warnings: [warning] });
  let root: Record<string, unknown> | undefined;
  try {
    root = rec(JSON.parse(text));
  } catch {
    root = undefined;
  }
  if (!root) return none("al-sem analyze output is not a JSON object; hotspots are shown without findings.");
  if (root["kind"] !== ALSEM_ANALYZE_KIND) {
    return none(`al-sem analyze output has kind '${String(root["kind"])}', expected '${ALSEM_ANALYZE_KIND}'; hotspots are shown without findings.`);
  }
  const version = str(root["schemaVersion"]) ?? "";
  if (Number(version.split(".")[0]) !== ALSEM_ANALYZE_MAJOR) {
    return none(`al-sem analyze schemaVersion '${version}' is not supported (this reader knows ${ALSEM_ANALYZE_MAJOR}.x); hotspots are shown without findings.`);
  }
  const raw = rec(root["payload"])?.["findings"];
  const findings: ParsedFinding[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const f = rec(item);
    const loc = rec(f?.["primaryLocation"]);
    const detector = str(f?.["detector"]);
    const routine = str(loc?.["routineName"]);
    const file = str(loc?.["file"]);
    if (!f || !loc || !detector || !routine || !file) continue; // unknown shape: skip this finding, keep the rest
    const evidence: EvidenceStep[] = [];
    for (const step of Array.isArray(f["evidencePath"]) ? f["evidencePath"] : []) {
      const s = rec(step);
      const note = str(s?.["note"]);
      if (!s || !note) continue;
      const anchor = rec(s["sourceAnchor"]);
      const startLine = num(rec(anchor?.["range"])?.["startLine"]);
      const unit = str(anchor?.["sourceUnitId"]);
      evidence.push({
        note,
        ...(unit ? { file: stripWs(unit) } : {}),
        // WIRE: anchor ranges are 0-based; primaryLocation.line is 1-based (alsem 1.5.0, recorded in tests/fixtures/alsem-hotspots).
        ...(startLine !== undefined ? { line: startLine + 1 } : {}),
      });
    }
    const fix = rec(f["fixHint"]);
    findings.push({
      detector,
      title: str(f["title"]) ?? detector,
      confidence: str(rec(f["confidence"])?.["level"]) ?? "unknown",
      ...(str(f["severity"]) ? { severity: str(f["severity"])! } : {}),
      file: stripWs(file),
      line: num(loc["line"]) ?? 0,
      ...(str(f["rootCause"]) ? { rootCause: str(f["rootCause"])! } : {}),
      evidence: evidence.slice(0, MAX_EVIDENCE_STEPS),
      ...(str(fix?.["description"]) ? { fix: str(fix?.["description"])! } : {}),
      ...(str(fix?.["safety"]) ? { fixSafety: str(fix?.["safety"])! } : {}),
      ...(str(loc["enclosingMember"]) ? { enclosingMember: str(loc["enclosingMember"])! } : {}),
      objectKey: objectKeyFromId(str(loc["objectId"])),
      routine,
    });
  }
  return { findings, alsemVersion: str(root["alsemVersion"]) ?? "", warnings: [] };
}

export interface ExplainOptions {
  maxAlFiles?: number;
  timeoutMs?: number;
  detectors?: string[];
}

const NOTES = [
  "Static findings joined to profile frames by object + routine name (overloads share findings); a hotspot with no finding is not proof the code is fine.",
  "al-sem#9: Rename is not modelled as a write, so a rename in a loop is not flagged.",
];

/**
 * Attaches al-sem performance findings to the hotspots that sit in the workspace app at `project`.
 * Skips (hotspots unchanged) with at most one warning when nothing matches the workspace, the
 * workspace is above `maxAlFiles`, alsem is missing, times out, fails, or answers unreadably.
 */
export async function explainHotspots(
  hotspots: Hotspot[],
  project: string,
  analyze: AlSemAnalyze,
  options: ExplainOptions = {},
): Promise<ExplainResult> {
  const skip = (warning?: string): ExplainResult => ({ hotspots, warnings: warning ? [warning] : [] });
  const maxFiles = options.maxAlFiles ?? DEFAULT_MAX_AL_FILES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ANALYZE_TIMEOUT_MS;

  let workspaceKeys: Set<string>;
  let relFiles: string[];
  let appId = "";
  try {
    await stat(join(project, "app.json"));
    try {
      const id = (JSON.parse((await readFile(join(project, "app.json"), "utf8")).replace(/^﻿/, "")) as { id?: unknown }).id;
      if (typeof id === "string") appId = id.replace(/-/g, "").toLowerCase();
    } catch {
      // unreadable app.json: no id, so the app guard below stays off
    }
    const refs = (await AlObjectIndex.build(project)).all();
    workspaceKeys = new Set(refs.map((r) => `${r.typeName}_${r.objectId}`));
    relFiles = refs.map((r) => relative(project, r.file).replace(/\\/g, "/").toLowerCase());
  } catch {
    return skip(); // not an AL workspace: nothing to explain against
  }
  // Only hotspots inside the workspace app are worth a static run.
  // WIRE: a frame url has no app segment (live Cronus28/29 2026-10-13), so a same-id object of another app would
  // match by object key; the frame's declaringApplication.appId (Hotspot.appId) tells them apart when present.
  const otherApp = (h: Hotspot): boolean => appId !== "" && h.appId !== undefined && h.appId !== appId;
  const inWorkspace = (h: Hotspot): boolean => {
    if (otherApp(h)) return false;
    const key = objectKeyFromUrl(h.url);
    if (key) return workspaceKeys.has(key);
    const url = h.url.replace(/\\/g, "/").toLowerCase();
    return url.endsWith(".al") && relFiles.some((f) => url === f || url.endsWith(`/${f}`));
  };
  if (!hotspots.some(inWorkspace)) return skip();
  if (relFiles.length > maxFiles) {
    return skip(`al-sem hotspot explanation skipped: workspace has ${relFiles.length} .al files (limit ${maxFiles}); the hotspots are shown without findings.`);
  }

  let detectors = options.detectors ?? PERF_DETECTORS;
  let stdout = "";
  for (;;) {
    try {
      stdout = await analyze(project, detectors, timeoutMs);
      break;
    } catch (error) {
      const e = error as { code?: unknown; killed?: unknown };
      if (e?.code === "ENOENT") {
        return skip(`al-sem was not found, so hotspots have no static findings. Set ${ALSEM_ENV_VAR} to alsem.exe or put alsem on PATH.`);
      }
      if (e?.killed === true) return skip(`al-sem hotspot explanation timed out after ${Math.round(timeoutMs / 1000)}s; the hotspots are shown without findings.`);
      const output = toolOutput(error);
      const rejected = /Unknown detector:\s*(\S+)/.exec(output)?.[1];
      if (rejected && detectors.includes(rejected) && detectors.length > 1) {
        detectors = detectors.filter((d) => d !== rejected); // ids are unstable across al-sem versions
        continue;
      }
      return skip(`al-sem analyze failed${output === "" ? "" : `: ${output}`}; the hotspots are shown without findings.`);
    }
  }

  const parsed = parseAlSemAnalyze(stdout);
  if (parsed.warnings.length > 0) return { hotspots, warnings: parsed.warnings };

  let matched = 0;
  const explained = hotspots.map((h): ExplainedHotspot => {
    if (otherApp(h)) return h;
    const key = objectKeyFromUrl(h.url);
    const fn = h.function.replace(/^"|"$/g, "").toLowerCase();
    const url = h.url.replace(/\\/g, "/").toLowerCase();
    const hits = parsed.findings.filter(
      (f) =>
        f.routine.toLowerCase() === fn &&
        (key !== undefined ? f.objectKey === key : url.endsWith(f.file.toLowerCase())),
    );
    if (hits.length === 0) return h;
    matched += hits.length;
    const shown = hits.slice(0, MAX_FINDINGS_PER_HOTSPOT).map(({ objectKey: _k, routine: _r, ...finding }) => finding);
    return { ...h, findings: shown, ...(hits.length > shown.length ? { omittedFindings: hits.length - shown.length } : {}) };
  });
  return {
    hotspots: explained,
    analysis: { source: "al-sem", alsemVersion: parsed.alsemVersion, detectors, findingsTotal: parsed.findings.length, findingsMatched: matched, notes: NOTES },
    warnings: [],
  };
}
