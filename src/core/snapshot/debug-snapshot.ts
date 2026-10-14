import { SNAPSHOT_LIMITS as L } from "./limits";
import type { ArmedSnappoint } from "./snappoints";

export interface VariableNode { name: string; type: string; value: string; children: VariableNode[]; omittedChildren?: number; valueTruncated?: true }
export type Variables = VariableNode[] | { unavailable: string };
export interface StackFrame { object: { type: string | null; id: number | null; name: string | null }; method: string; line: number | null }
export interface SourceWindow { entry: string; startLine: number; endLine: number; highlightLine: number; lines: string[] }
export interface SnapshotPoint {
  reasons: Array<"snappoint" | "exception" | "recorded">; object: StackFrame["object"]; method: string; line: number | null;
  entry: string; contextIndex: number | null; timestamp: string; stack: StackFrame[]; variables: Variables; source?: SourceWindow; message?: string; omittedVariables?: number;
}
export interface Projection { points: SnapshotPoint[]; omittedPoints: number; methodCount: number; classification: "complete" | "partial"; warnings: string[] }

type Json = any; // converter JSON, validated structurally below

// WIRE (bc-mdc-converter snapshot-json 1): spans are 0-based as stored; ExceptionContext.lineNumber is the
// index of the line context holding the throw-time variables (live Cronus29 2026-10-14).
export function projectSnapshot(doc: unknown, armed: ArmedSnappoint[] | null, readSource: (entry: string) => string | null): Projection {
  const d = doc as Json;
  if (d?.format !== "bc-mdc-snapshot" || d?.schemaVersion !== 1 || !Array.isArray(d?.methods)) {
    throw new Error("not a bc-mdc-snapshot schemaVersion 1 document");
  }
  const warnings: string[] = [];
  const obj = (o: Json) => ({ type: o?.type ?? null, id: o?.id ?? null, name: o?.name ?? null });
  const line1 = (span: Json) => (span?.from?.line === undefined ? null : span.from.line + 1);
  const exceptions: SnapshotPoint[] = [];
  const others: SnapshotPoint[] = [];
  for (const m of d.methods as Json[]) {
    const stack: StackFrame[] = (m.frames ?? []).map((f: Json) => ({ object: obj(f.object), method: f.methodName, line: line1(f.span) }));
    const base = { object: obj(m.object), method: m.methodName as string, entry: m.entry as string, stack };
    const excIndex: number | undefined = m.exception?.lineNumber;
    let excPlaced = false;
    for (const lc of (m.lineContexts ?? []) as Json[]) {
      const isExc = m.exception != null && lc.index === excIndex;
      const isSnap = armed !== null && armed.some((a) => a.objectType === m.object?.typeId && a.objectId === m.object?.id && a.wireLine === lc.span?.from?.line);
      const isRecorded = armed === null && !isExc && (lc.variables?.length ?? 0) > 0;
      if (!isExc && !isSnap && !isRecorded) continue;
      const reasons: SnapshotPoint["reasons"] = [...(isSnap ? ["snappoint" as const] : []), ...(isExc ? ["exception" as const] : []), ...(isRecorded ? ["recorded" as const] : [])];
      const point: SnapshotPoint = { ...base, reasons, line: line1(lc.span), contextIndex: lc.index, timestamp: String(lc.timestamp ?? "0"), variables: lc.variables ?? [], ...(isExc ? { message: m.exception.message } : {}) };
      if (isExc) { excPlaced = true; exceptions.push(point); } else others.push(point);
    }
    if (m.exception != null && !excPlaced) {
      exceptions.push({ ...base, reasons: ["exception"], line: line1(m.exception.span), contextIndex: null, timestamp: "0", message: m.exception.message,
        variables: { unavailable: `exception points at line context ${excIndex}, but the method has no line context with that index` } });
    }
  }
  const ordered = [...exceptions, ...others];
  const points = ordered.slice(0, L.points);
  // variables: caps and one node budget, spent in this order (exceptions first)
  let budget: number = L.variableNodes;
  const cap = (v: Json, depth: number): VariableNode => {
    budget--;
    const value = String(v.value ?? "");
    const cut = cutValue(value);
    const kids: Json[] = Array.isArray(v.children) ? v.children : [];
    const keep = depth + 1 >= L.depth ? [] : kids.slice(0, L.children);
    const node: VariableNode = { name: String(v.name ?? ""), type: String(v.type ?? ""), value: cut, children: [] };
    if (cut.length < value.length) node.valueTruncated = true;
    for (const k of keep) { if (budget <= 0) break; node.children.push(cap(k, depth + 1)); }
    const omitted = kids.length - node.children.length;
    if (omitted > 0) node.omittedChildren = omitted;
    return node;
  };
  for (const p of points) {
    if (!Array.isArray(p.variables)) continue;
    if (budget <= 0) { p.variables = { unavailable: "variable budget used" }; continue; }
    const roots = p.variables as Json[];
    const out: VariableNode[] = [];
    for (const v of roots.slice(0, L.children)) { if (budget <= 0) break; out.push(cap(v, 0)); }
    if (roots.length > out.length) p.omittedVariables = roots.length - out.length;
    p.variables = out;
  }
  // source windows: one bundled source per object type + id
  const sources: Json[] = Array.isArray(d.sources) ? d.sources : [];
  const cache = new Map<string, string[] | null>();
  for (const p of points) {
    if (p.line === null) continue;
    const matches = sources.filter((s) => String(s.objectType).toLowerCase() === String(p.object.type).toLowerCase() && s.objectId === p.object.id); // converter spells "CodeUnit"; entry names may not
    if (matches.length !== 1) { warnings.push(`no single bundled source for ${p.object.type} ${p.object.id} (${matches.length} found); no source window`); continue; }
    const entry = matches[0].entry as string;
    if (!cache.has(entry)) { const text = readSource(entry); cache.set(entry, text === null ? null : text.replace(/^﻿/, "").split(/\r?\n/)); }
    const lines = cache.get(entry);
    if (!lines) { warnings.push(`bundled source ${entry} could not be read; no source window`); continue; }
    const start = Math.max(1, p.line - L.sourceRadius);
    const end = Math.min(lines.length, p.line + L.sourceRadius);
    p.source = { entry, startLine: start, endLine: end, highlightLine: p.line, lines: lines.slice(start - 1, end).map((l) => cutLine(l)) };
  }
  // WIRE: a Background snapshot binds the TaskScheduler session but the archive holds source only (no .mdc);
  // BC drops the context at session end (live Cronus29 2026-10-15).
  if (d.methods.length === 0) warnings.push("The recording holds no method contexts: the session bound but no execution was recorded (seen for Background sessions on BC29).");
  else if (ordered.length === 0) warnings.push("The recording has method contexts but none at an armed line or a throw.");
  return { points, omittedPoints: ordered.length - points.length, methodCount: d.methods.length, classification: armed === null ? "partial" : "complete", warnings: [...new Set(warnings)] };
}

function cutValue(s: string): string {
  if (s.length <= L.valueChars) return s;
  let cut = s.slice(0, L.valueChars);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never split a surrogate pair
  return cut;
}
function cutLine(s: string): string { return s.length <= L.sourceLineChars ? s : s.slice(0, L.sourceLineChars); }
