import { isAbsolute, relative, resolve } from "node:path";
import { AL_OBJECT_TYPE, type AlObjectIndex } from "../al-objects";
import { BcDevError } from "../agent-errors";
import type { WireLocation } from "./snapshot-types";

export interface SnappointInput {
  file?: string;
  objectType?: string;
  objectId?: number;
  line: number;
  condition?: string;
}
export interface ArmedSnappoint {
  objectType: number;
  objectTypeName: string;
  objectId: number;
  line: number; // 1-based
  wireLine: number; // 0-based
  condition?: string;
  file?: string;
  unverified: boolean;
}

const MAX_SNAPPOINTS = 20;
const CODE_TYPES = new Set(["table", "tableextension", "page", "pageextension", "report", "reportextension", "codeunit", "query", "xmlport"]);

export async function normalizeSnappoints(
  input: SnappointInput[],
  index: AlObjectIndex,
  project: string,
  readLines: (file: string) => Promise<number>,
): Promise<ArmedSnappoint[]> {
  const bad = (i: number, msg: string) => new BcDevError("INVALID_ARGUMENT", `snappoint ${i}: ${msg}`, "validation", false, { snappoint: i });
  if (input.length > MAX_SNAPPOINTS) {
    throw new BcDevError("INVALID_ARGUMENT", `at most ${MAX_SNAPPOINTS} snappoints are allowed (got ${input.length})`, "validation", false);
  }
  const out = new Map<string, ArmedSnappoint>();
  for (const [i, sp] of input.entries()) {
    if (!Number.isInteger(sp.line) || sp.line < 1) throw bad(i, `line must be an integer >= 1 (got ${sp.line})`);
    let typeName: string;
    let objectId: number;
    let file: string | undefined;
    let unverified: boolean;
    if (sp.file !== undefined) {
      const abs = resolve(project, sp.file);
      const rel = relative(index.projectDir, abs);
      if (rel.startsWith("..") || isAbsolute(rel)) throw bad(i, `file is outside the workspace: ${sp.file}`);
      const ref = index.byFile(abs);
      if (!ref) throw bad(i, `file is not an AL object in the workspace (no object declaration found): ${sp.file}`);
      const total = await readLines(abs);
      if (sp.line > total) throw bad(i, `line ${sp.line} is past the end of ${sp.file} (${total} lines)`);
      ({ typeName, objectId, file, unverified } = { typeName: ref.typeName, objectId: ref.objectId, file: abs, unverified: false });
    } else {
      typeName = (sp.objectType ?? "").toLowerCase();
      if (!Number.isInteger(sp.objectId) || sp.objectId! < 1) throw bad(i, "objectId must be an integer >= 1");
      objectId = sp.objectId!;
      unverified = true;
    }
    if (!CODE_TYPES.has(typeName)) throw bad(i, `object type '${typeName}' has no executable code; use one of ${[...CODE_TYPES].join(", ")}`);
    const objectType = AL_OBJECT_TYPE[typeName]!;
    const key = `${objectType}:${objectId}:${sp.line}`;
    if (out.has(key)) continue;
    out.set(key, {
      objectType, objectTypeName: typeName, objectId, line: sp.line, wireLine: sp.line - 1,
      ...(sp.condition ? { condition: sp.condition } : {}), ...(file ? { file } : {}), unverified,
    });
  }
  return [...out.values()];
}

export function toWireLocations(points: ArmedSnappoint[]): WireLocation[] {
  const groups = new Map<string, WireLocation>();
  for (const p of points) {
    const key = `${p.objectType}:${p.objectId}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { objectType: p.objectType, objectId: p.objectId, lines: [] }));
    g.lines.push({ line: p.wireLine, ...(p.condition ? { condition: p.condition } : {}) });
  }
  return [...groups.values()];
}
