import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BcDevError } from "./agent-errors";
import { readSymbolReference } from "./symbol-reference";

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
  /** TestPermissions property; "Restrictive" when absent (what the AL Test Runner applies, live BC28 2026-10-19). */
  testPermissions: string;
  methods: string[];
  methodDetails: TestMethodInfo[];
}

export interface TestMethodInfo {
  name: string;
  /** From [TransactionModel(...)]; "AutoCommit" when the attribute is absent. */
  transactionModel: string;
  /** Effective TestPermissions: a [TestPermissions(...)] attribute overrides the codeunit property. */
  testPermissions: string;
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

  all(): AlObjectRef[] {
    return [...this.byFileMap.values()];
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
    const testPermissions = /TestPermissions\s*=\s*(\w+)\s*;/i.exec(source)?.[1] ?? "Restrictive";
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
        const tp = attributes.map((a) => /^TestPermissions\s*\(\s*(?:TestPermissions\s*::\s*)?(\w+)\s*\)$/i.exec(a)).find(Boolean);
        // Documented default when no [TransactionModel] attribute is present: AutoCommit.
        methodDetails.push({ name: (proc[1] ?? proc[2])!, transactionModel: tm?.[1] ?? "AutoCommit", testPermissions: tp?.[1] ?? testPermissions, attributes });
      }
      attributes = [];
    }
    results.push({ codeunitId: ref.objectId, name: ref.name, file, testPermissions, methods: methodDetails.map((m) => m.name), methodDetails });
  }
  return results;
}

export interface HubPermissionsGap {
  codeunitId: number;
  name: string;
  testPermissions: string;
  /** Targeted methods whose effective TestPermissions is not Disabled. */
  methods: string[];
}

/**
 * Targeted test methods whose TestPermissions TestRunnerHub does not apply. The hub's built-in
 * runner ignores TestPermissions and never runs the AL Test Runner's before-test hook, so the
 * Permissions Mock is never started (personas are silent no-ops) and Restrictive tests run with the
 * caller's own permissions (SUPER) instead of the 130302 D365 FULL ACCESS baseline. Disabled methods
 * get no baseline under either runner and are not listed; a persona inside one would still differ
 * (the AL Test Runner starts the mock for every test), which source scanning does not detect.
 */
export function permissionsIgnoredByHub(
  tests: TestCodeunitInfo[],
  groups: Array<{ id: number; methods?: string[] }>,
): HubPermissionsGap[] {
  const gaps: HubPermissionsGap[] = [];
  for (const group of groups) {
    const cu = tests.find((t) => t.codeunitId === group.id);
    if (!cu) continue;
    const wanted = group.methods?.length ? new Set(group.methods.map((m) => m.toLowerCase())) : null;
    const methods = cu.methodDetails
      .filter((m) => (!wanted || wanted.has(m.name.toLowerCase())) && m.testPermissions.toLowerCase() !== "disabled")
      .map((m) => m.name);
    if (methods.length) gaps.push({ codeunitId: cu.codeunitId, name: cu.name, testPermissions: cu.testPermissions, methods });
  }
  return gaps;
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

export interface PackageTests {
  path: string;
  appId: string;
  appName: string;
  publisher: string;
  version: string;
  tests: Array<TestCodeunitInfo & { namespace: string }>;
  runners: Array<TestRunnerInfo & { namespace: string }>;
}

type SymbolNode = Record<string, unknown>;
const nodes = (value: unknown): SymbolNode[] =>
  Array.isArray(value) ? value.filter((v): v is SymbolNode => v !== null && typeof v === "object") : [];
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const property = (node: SymbolNode, name: string): string | undefined =>
  nodes(node["Properties"]).find((p) => text(p["Name"]).toLowerCase() === name.toLowerCase())?.["Value"] as string | undefined;

/** Test codeunits and runners recorded in one `.app` package's SymbolReference.json (no server). */
export async function discoverPackageTests(appPath: string): Promise<PackageTests> {
  const path = resolve(appPath);
  const bytes = await readFile(path); // ENOENT propagates (NOT_FOUND)
  let symbols: SymbolNode | null;
  try {
    symbols = readSymbolReference(bytes);
  } catch (error) {
    throw notAPackage(path, error);
  }
  if (!symbols) throw notAPackage(path, new Error("the package has no SymbolReference.json"));
  const result: PackageTests = {
    path,
    appId: text(symbols["AppId"]).toLowerCase(),
    appName: text(symbols["Name"]),
    publisher: text(symbols["Publisher"]),
    version: text(symbols["Version"]),
    tests: [],
    runners: [],
  };
  // WIRE: SymbolReference.json Codeunits/Namespaces/Properties/Attributes shape — alc 30.0.2863738
  // output + Microsoft packages from Cronus29 (live 2026-10-15). Codeunits sit at the top level and
  // under nested Namespaces[] (dotted Name chain); Subtype/TestIsolation are Properties[] (absent =
  // default); Methods[] are in declaration order with Attributes[{Name, Arguments[{Value}]}].
  const walk = (container: SymbolNode, namespace: string): void => {
    for (const cu of nodes(container["Codeunits"])) {
      const subtype = property(cu, "Subtype")?.toLowerCase();
      const base = { codeunitId: Number(cu["Id"]), name: text(cu["Name"]), namespace, file: path };
      if (subtype === "test") {
        // WIRE: TestPermissions is a codeunit Properties[] entry (absent = Restrictive) and a method
        // Attributes[{Name:"TestPermissions", Arguments:[{Value:"Disabled"}]}] — alc 30.0.2863738, 2026-10-19.
        const testPermissions = property(cu, "TestPermissions") ?? "Restrictive";
        const methodDetails: TestMethodInfo[] = [];
        for (const method of nodes(cu["Methods"])) {
          const attrs = nodes(method["Attributes"]);
          if (!attrs.some((a) => text(a["Name"]).toLowerCase() === "test")) continue;
          const args = (a: SymbolNode) => nodes(a["Arguments"]).map((arg) => String(arg["Value"] ?? ""));
          const tm = attrs.find((a) => text(a["Name"]).toLowerCase() === "transactionmodel");
          const tp = attrs.find((a) => text(a["Name"]).toLowerCase() === "testpermissions");
          methodDetails.push({
            name: text(method["Name"]),
            transactionModel: (tm && args(tm)[0]) || "AutoCommit",
            testPermissions: (tp && args(tp)[0]) || testPermissions,
            attributes: attrs.map((a) => (args(a).length ? `${text(a["Name"])}(${args(a).join(", ")})` : text(a["Name"]))),
          });
        }
        result.tests.push({ ...base, testPermissions, methods: methodDetails.map((m) => m.name), methodDetails });
      } else if (subtype === "testrunner") {
        result.runners.push({ ...base, testIsolation: property(cu, "TestIsolation") ?? "Disabled" });
      }
    }
    for (const ns of nodes(container["Namespaces"])) {
      walk(ns, namespace ? `${namespace}.${text(ns["Name"])}` : text(ns["Name"]));
    }
  };
  walk(symbols, "");
  return result;
}

/** Every `*.app` directly in `<projectDir>/.alpackages`; unreadable packages become warnings. */
export async function discoverAlpackagesTests(projectDir: string): Promise<{ packages: PackageTests[]; warnings: string[] }> {
  const dir = join(resolve(projectDir), ".alpackages");
  const warnings: string[] = [];
  let files: string[];
  try {
    files = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".app"))
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return { packages: [], warnings: [`No .alpackages folder at ${dir}; no packages were scanned`] };
  }
  const packages: PackageTests[] = [];
  for (const file of files) {
    try {
      packages.push(await discoverPackageTests(file));
    } catch (error) {
      const cause = error instanceof BcDevError && error.cause instanceof Error ? error.cause : error;
      warnings.push(`Unable to read test symbols from ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { packages, warnings };
}

function notAPackage(path: string, cause?: unknown): BcDevError {
  return new BcDevError(
    "CONFIGURATION_ERROR",
    "appFile is not a readable AL .app package",
    "configuration",
    false,
    { path },
    cause === undefined ? undefined : { cause },
  );
}
