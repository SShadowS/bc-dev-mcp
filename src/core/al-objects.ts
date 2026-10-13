import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

// WIRE: ObjectTypeWrapper values (tw-decomp ObjectTypeWrapper.cs)
export const AL_OBJECT_TYPE: Record<string, number> = {
  table: 1,
  report: 3,
  codeunit: 5,
  xmlport: 6,
  page: 8,
  query: 9,
  pageextension: 14,
  tableextension: 15,
  enum: 16,
  enumextension: 17,
  reportextension: 22,
};

export interface AlObjectRef {
  objectType: number;
  typeName: string;
  objectId: number;
  name: string;
  file: string; // absolute path
}

export interface TestCodeunitInfo {
  codeunitId: number;
  name: string;
  file: string;
  methods: string[];
  methodDetails: TestMethodInfo[];
}

export interface TestMethodInfo {
  name: string;
  /** From [TransactionModel(...)]; "AutoCommit" when the attribute is absent. */
  transactionModel: string;
  /** Raw attribute texts preceding the procedure, e.g. "Test", "HandlerFunctions('X')". */
  attributes: string[];
}

export interface TestRunnerInfo {
  codeunitId: number;
  name: string;
  file: string;
  testIsolation: string;
}

const OBJECT_DECL = /^\s*(table|report|codeunit|xmlport|page|query|pageextension|tableextension|enum|enumextension|reportextension)\s+(\d+)\s+(?:"([^"]+)"|(\w+))/im;
const SKIP_DIRS = new Set([".alpackages", ".git", ".vscode", "node_modules"]);

async function walkAlFiles(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walkAlFiles(join(dir, entry.name), found);
    } else if (entry.name.toLowerCase().endsWith(".al")) {
      found.push(resolve(dir, entry.name));
    }
  }
  return found;
}

function parseDeclaration(file: string, source: string): AlObjectRef | undefined {
  const m = OBJECT_DECL.exec(source);
  if (!m) return undefined;
  const typeName = m[1]!.toLowerCase();
  const objectType = AL_OBJECT_TYPE[typeName];
  if (objectType === undefined) return undefined;
  return { objectType, typeName, objectId: Number(m[2]), name: m[3] ?? m[4] ?? "", file };
}

export class AlObjectIndex {
  private byFileMap = new Map<string, AlObjectRef>();
  private byIdMap = new Map<string, AlObjectRef>();
  private mtimes = new Map<string, number>();

  private constructor(public readonly projectDir: string) {}

  static async build(projectDir: string): Promise<AlObjectIndex> {
    const index = new AlObjectIndex(resolve(projectDir));
    await index.refresh();
    return index;
  }

  byFile(file: string): AlObjectRef | undefined {
    return this.byFileMap.get(resolve(file));
  }

  byId(objectType: number, objectId: number): AlObjectRef | undefined {
    return this.byIdMap.get(`${objectType}_${objectId}`);
  }

  async refresh(): Promise<void> {
    const current = await walkAlFiles(this.projectDir);
    const seen = new Set(current);
    for (const known of [...this.mtimes.keys()]) {
      if (!seen.has(known)) {
        this.mtimes.delete(known);
        const previous = this.byFileMap.get(known);
        if (previous) this.byIdMap.delete(`${previous.objectType}_${previous.objectId}`);
        this.byFileMap.delete(known);
      }
    }
    for (const file of current) {
      const mtime = (await stat(file)).mtimeMs;
      if (this.mtimes.get(file) === mtime) continue;
      this.mtimes.set(file, mtime);
      const previous = this.byFileMap.get(file);
      if (previous) this.byIdMap.delete(`${previous.objectType}_${previous.objectId}`);
      const ref = parseDeclaration(file, await readFile(file, "utf8"));
      if (ref) {
        this.byFileMap.set(file, ref);
        this.byIdMap.set(`${ref.objectType}_${ref.objectId}`, ref);
      }
    }
  }
}

export async function discoverTests(projectDir: string): Promise<TestCodeunitInfo[]> {
  const results: TestCodeunitInfo[] = [];
  for (const file of await walkAlFiles(resolve(projectDir))) {
    const source = await readFile(file, "utf8");
    const ref = parseDeclaration(file, source);
    if (!ref || ref.typeName !== "codeunit") continue;
    if (!/Subtype\s*=\s*Test\s*;/i.test(source)) continue;
    const methodDetails: TestMethodInfo[] = [];
    let attributes: string[] = []; // attribute block preceding the next procedure
    for (const line of source.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) {
        for (const m of line.matchAll(/\[([^\]]*)\]/g)) attributes.push(m[1]!.trim());
        continue;
      }
      if (/^\s*(\/\/|$)/.test(line)) continue; // comments or blank lines inside the attribute block
      const proc = /^\s*(?:local\s+)?procedure\s+(?:"([^"]+)"|(\w+))/i.exec(line);
      if (proc && attributes.some((a) => /^Test$/i.test(a))) {
        const tm = attributes.map((a) => /^TransactionModel\s*\(\s*(?:TransactionModel\s*::\s*)?(\w+)\s*\)$/i.exec(a)).find(Boolean);
        // Documented default when no [TransactionModel] attribute is present: AutoCommit.
        methodDetails.push({ name: (proc[1] ?? proc[2])!, transactionModel: tm?.[1] ?? "AutoCommit", attributes });
      }
      attributes = [];
    }
    results.push({ codeunitId: ref.objectId, name: ref.name, file, methods: methodDetails.map((m) => m.name), methodDetails });
  }
  return results;
}

/** TestRunner codeunits in the project and their TestIsolation (documented default: Disabled). */
export async function discoverTestRunners(projectDir: string): Promise<TestRunnerInfo[]> {
  const results: TestRunnerInfo[] = [];
  for (const file of await walkAlFiles(resolve(projectDir))) {
    const source = await readFile(file, "utf8");
    const ref = parseDeclaration(file, source);
    if (!ref || ref.typeName !== "codeunit") continue;
    if (!/Subtype\s*=\s*TestRunner\s*;/i.test(source)) continue;
    const iso = /TestIsolation\s*=\s*(\w+)\s*;/i.exec(source);
    results.push({ codeunitId: ref.objectId, name: ref.name, file, testIsolation: iso?.[1] ?? "Disabled" });
  }
  return results;
}
