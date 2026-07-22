import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { AL_OBJECT_TYPE } from "./al-objects";
import { BcDevError } from "./agent-errors";
import { extractEntry } from "./snapshot/zip";

interface Token {
  text: string;
  lower: string;
  line: number;
}

interface ObjectSpan {
  objectType: number;
  typeName: string;
  objectId: number;
  name: string;
  open: number;
  close: number;
}

interface SymbolIdentity {
  id: number;
  name: string;
  local: boolean;
}

interface DependencySymbol {
  kind: string;
  name: string;
  id: number;
}

interface CachedPackageSymbols {
  mtimeMs: number;
  size: number;
  symbols: DependencySymbol[];
}

export class AlProcedureDiscoveryCache {
  readonly packages = new Map<string, CachedPackageSymbols>();
}

export interface AlTypeRef {
  navTypeKind: number | null;
  symbolKind: number;
  length?: number;
  subtypeKind?: string;
  subtypeName?: string;
  subtypeId?: number;
  typeArguments?: AlTypeRef[];
  unresolved?: string;
}

export interface ParsedParameter {
  isVar: boolean;
  type: AlTypeRef;
}

export interface AlProcedureIdentity {
  objectType: number;
  objectId: number;
  objectName: string;
  name: string;
  file: string;
  relativeFile: string;
  startLine: number;
  endLine: number;
  methodId: number | null;
  identityWarning?: string;
  /** Compiler identity inputs retained for deterministic verification; not exposed by MCP output schemas. */
  signature: { returnType: AlTypeRef; parameters: ParsedParameter[]; eventLike: boolean };
}

interface ParsedProcedure {
  object: ObjectSpan;
  name: string;
  startLine: number;
  endLine: number;
  parameters: ParsedParameter[];
  returnType: AlTypeRef;
  eventLike: boolean;
}

const SKIP_DIRS = new Set([".alpackages", ".git", ".vscode", "node_modules"]);
const ACCESS = new Set(["local", "internal", "protected"]);
const OBJECT_KEYWORDS = new Set([...Object.keys(AL_OBJECT_TYPE), "interface"]);
const RETURN_VALUE_MASK = 524288;

// WIRE: NavTypeKind numeric values are emitted into AL method IDs. Values and the
// ReturnValuesAddedForRuntimeVersion7 mask come from AL Development Tools 17.0.34.45391,
// Microsoft.Dynamics.Nav.CodeAnalysis.NavTypeKind and NavTypeExtensions.
const NAV_TYPE: Record<string, number> = {
  none: 0,
  array: 1,
  boolean: 12451842,
  byte: 3014659,
  char: 3014660,
  integer: 12451845,
  biginteger: 12451846,
  decimal: 12451847,
  option: 12451848,
  text: 16646153,
  code: 16646154,
  textconst: 2228235,
  label: 2228236,
  datetime: 12451853,
  time: 12451854,
  date: 12451855,
  dateformula: 12451856,
  duration: 12451857,
  guid: 12451858,
  enum: 12451896,
  notification: 917539,
  recordid: 12451880,
  recordref: 917545,
  fieldref: 917546,
  keyref: 917547,
  tablefilter: 11534380,
  instream: 917549,
  outstream: 917550,
  bigtext: 3014703,
  blob: 3145776,
  variant: 917554,
  dotnet: 393268,
  media: 11534389,
  mediaset: 11534390,
  file: 393296,
  filterpagebuilder: 917585,
  dialog: 131154,
  sessionsettings: 917587,
  jsontoken: 917594,
  jsonobject: 917595,
  jsonarray: 917596,
  jsonvalue: 917597,
  httpclient: 917598,
  httprequestmessage: 917599,
  httpresponsemessage: 917600,
  httpheaders: 917601,
  httpcontent: 917602,
  textbuilder: 917603,
  record: 917604,
  codeunit: 917605,
  page: 917606,
  report: 917607,
  xmlport: 917608,
  query: 917609,
  list: 917710,
  dictionary: 917711,
  version: 917713,
  moduleinfo: 917714,
  moduledependencyinfo: 917715,
  errorinfo: 917720,
  interface: 917722,
  datatransfer: 917735,
  secrettext: 917737,
  fileupload: 917739,
  cookie: 917740,
  testpage: 393289,
  testrequestpage: 262216,
};

const SYMBOL_KIND: Record<string, number> = {
  named: 2,
  table: 10,
  codeunit: 11,
  page: 12,
  report: 13,
  query: 14,
  xmlport: 15,
  enum: 22,
  interface: 25,
  testpage: 70,
  testrequestpage: 73,
  record: 90,
  dotnet: 114,
};

const SUBTYPE_KIND = new Set([
  "table", "testrequestpage", "testpage", "record", "codeunit", "page", "xmlport",
  "query", "dotnet", "list", "dictionary", "interface", "enum",
]);

const RETURN_VALUE_TYPES = new Set([
  "table", "testrequestpage", "testpage", "file", "notification", "recordref", "fieldref",
  "keyref", "instream", "outstream", "variant", "filterpagebuilder", "sessionsettings", "httpclient",
  "httprequestmessage", "httpresponsemessage", "httpcontent", "record", "codeunit", "page", "report",
  "xmlport", "query", "list", "dictionary", "interface", "notificationscope", "dateformula", "recordid",
]);

class SubtypeCatalog {
  private symbols = new Map<string, SymbolIdentity[]>();

  add(kind: string, name: string, id: number, local: boolean): void {
    const key = `${kind}|${name.toLowerCase()}`;
    const values = this.symbols.get(key) ?? [];
    if (!values.some((value) => value.id === id && value.name === name && value.local === local)) {
      values.push({ id, name, local });
      this.symbols.set(key, values);
    }
  }

  resolve(kind: string, rawName: string): SymbolIdentity | null {
    const name = rawName.replace(/^"|"$/g, "");
    const candidates = [name, name.split(".").at(-1)!];
    for (const candidate of candidates) {
      const values = this.symbols.get(`${kind}|${candidate.toLowerCase()}`) ?? [];
      const local = values.filter((value) => value.local);
      const chosen = local.length > 0 ? local : values;
      const ids = new Set(chosen.map((value) => value.id));
      if (ids.size === 1) return chosen[0]!;
      if (chosen.length > 0) return null;
    }
    return null;
  }

  dependencySymbols(): DependencySymbol[] {
    const result: DependencySymbol[] = [];
    for (const [key, values] of this.symbols) {
      const kind = key.slice(0, key.indexOf("|"));
      for (const value of values) result.push({ kind, name: value.name, id: value.id });
    }
    return result;
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  for (let i = 0; i < source.length;) {
    const ch = source[i]!;
    if (ch === "\n") { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line++;
        i++;
      }
      i = Math.min(source.length, i + 2);
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < source.length) {
        if (source[i] === "\n") line++;
        if (source[i] === "'" && source[i + 1] === "'") { i += 2; continue; }
        if (source[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      const startLine = line;
      let value = "";
      i++;
      while (i < source.length) {
        if (source[i] === '"' && source[i + 1] === '"') { value += '"'; i += 2; continue; }
        if (source[i] === '"') { i++; break; }
        if (source[i] === "\n") line++;
        value += source[i]!;
        i++;
      }
      tokens.push({ text: value, lower: value.toLowerCase(), line: startLine });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i++;
      const text = source.slice(start, i);
      tokens.push({ text, lower: text.toLowerCase(), line });
      continue;
    }
    if (/\d/.test(ch)) {
      const start = i++;
      while (i < source.length && /[0-9.]/.test(source[i]!)) i++;
      const text = source.slice(start, i);
      tokens.push({ text, lower: text, line });
      continue;
    }
    tokens.push({ text: ch, lower: ch, line });
    i++;
  }
  return tokens;
}

function matching(tokens: Token[], start: number, open: string, close: string, limit = tokens.length): number {
  let depth = 0;
  for (let i = start; i < limit; i++) {
    if (tokens[i]!.text === open) depth++;
    else if (tokens[i]!.text === close && --depth === 0) return i;
  }
  return -1;
}

function objectSpans(tokens: Token[]): ObjectSpan[] {
  const spans: ObjectSpan[] = [];
  for (let i = 0; i < tokens.length - 3; i++) {
    const typeName = tokens[i]!.lower;
    if (!OBJECT_KEYWORDS.has(typeName) || !/^\d+$/.test(tokens[i + 1]!.text)) continue;
    const objectType = AL_OBJECT_TYPE[typeName];
    if (objectType === undefined) continue;
    let open = i + 3;
    while (open < tokens.length && tokens[open]!.text !== "{") open++;
    if (open >= tokens.length) continue;
    const close = matching(tokens, open, "{", "}");
    if (close < 0) continue;
    spans.push({
      objectType,
      typeName,
      objectId: Number(tokens[i + 1]!.text),
      name: tokens[i + 2]!.text,
      open,
      close,
    });
    i = close;
  }
  return spans;
}

function declarationStart(tokens: Token[], procedureIndex: number): { index: number; attributes: Set<string> } {
  let start = procedureIndex;
  if (start > 0 && ACCESS.has(tokens[start - 1]!.lower)) start--;
  const attributes = new Set<string>();
  let cursor = start - 1;
  while (cursor >= 0 && tokens[cursor]!.text === "]") {
    let depth = 1;
    let open = cursor - 1;
    for (; open >= 0; open--) {
      if (tokens[open]!.text === "]") depth++;
      if (tokens[open]!.text === "[" && --depth === 0) break;
    }
    if (open < 0) break;
    for (let i = open + 1; i < cursor; i++) {
      if (/^[A-Za-z_]/.test(tokens[i]!.text)) attributes.add(tokens[i]!.lower);
    }
    start = open;
    cursor = open - 1;
  }
  return { index: start, attributes };
}

function splitTopLevel(tokens: Token[], separator: string): Token[][] {
  const groups: Token[][] = [];
  let current: Token[] = [];
  let square = 0;
  let round = 0;
  for (const token of tokens) {
    if (token.text === "[") square++;
    else if (token.text === "]") square--;
    else if (token.text === "(") round++;
    else if (token.text === ")") round--;
    if (token.text === separator && square === 0 && round === 0) {
      groups.push(current);
      current = [];
    } else current.push(token);
  }
  groups.push(current);
  return groups;
}

function typeName(tokens: Token[]): string {
  return tokens
    .filter((token) => token.text !== ";" && token.lower !== "temporary")
    .map((token) => token.text)
    .join("")
    .trim();
}

function parseType(tokensInput: Token[], catalog: SubtypeCatalog): AlTypeRef {
  const tokens = tokensInput.filter((token) => token.text !== ";" && token.lower !== "temporary");
  if (tokens.length === 0) return { navTypeKind: NAV_TYPE.none!, symbolKind: SYMBOL_KIND.named! };
  const first = tokens[0]!.lower;
  if (first === "array") {
    return {
      navTypeKind: NAV_TYPE.array!,
      symbolKind: SYMBOL_KIND.named!,
      unresolved: "array parameter method identities are not resolved conservatively",
    };
  }
  if (first === "list" || first === "dictionary") {
    const open = tokens.findIndex((token) => token.text === "[");
    const close = open < 0 ? -1 : matching(tokens, open, "[", "]");
    if (open < 0 || close < 0) {
      return { navTypeKind: NAV_TYPE[first]!, symbolKind: SYMBOL_KIND.named!, unresolved: `unsupported ${first} type syntax` };
    }
    const args = splitTopLevel(tokens.slice(open + 1, close), ",").map((part) => parseType(part, catalog));
    const expected = first === "list" ? 1 : 2;
    return {
      navTypeKind: NAV_TYPE[first]!,
      symbolKind: SYMBOL_KIND.named!,
      typeArguments: args,
      unresolved: args.length === expected ? undefined : `${first} requires ${expected} type argument(s)`,
    };
  }
  if (first === "record" || first === "codeunit" || first === "page" || first === "report" || first === "xmlport" ||
      first === "query" || first === "enum" || first === "interface" || first === "testpage" || first === "testrequestpage" ||
      first === "dotnet") {
    const rawSubtype = typeName(tokens.slice(1));
    const identity = first === "dotnet" ? null : catalog.resolve(first, rawSubtype);
    const numericId = /^\d+$/.test(rawSubtype) ? Number(rawSubtype) : undefined;
    const subtypeId = numericId ?? identity?.id;
    return {
      navTypeKind: NAV_TYPE[first]!,
      symbolKind: SYMBOL_KIND[first]!,
      subtypeKind: first,
      subtypeName: identity?.name ?? rawSubtype,
      subtypeId,
      unresolved: first === "dotnet"
        ? (rawSubtype === "" ? "missing DotNet subtype" : undefined)
        : (subtypeId === undefined ? `unable to resolve ${first} subtype '${rawSubtype}'` : undefined),
    };
  }
  const navTypeKind = NAV_TYPE[first];
  if (navTypeKind === undefined) {
    return { navTypeKind: null, symbolKind: SYMBOL_KIND.named!, unresolved: `unsupported AL type '${typeName(tokens)}'` };
  }
  const open = tokens.findIndex((token) => token.text === "[");
  const length = open >= 0 && /^\d+$/.test(tokens[open + 1]?.text ?? "") ? Number(tokens[open + 1]!.text) : undefined;
  return { navTypeKind, symbolKind: SYMBOL_KIND.named!, length };
}

function parseParameters(tokens: Token[], catalog: SubtypeCatalog): ParsedParameter[] {
  const parameters: ParsedParameter[] = [];
  for (const group of splitTopLevel(tokens, ";")) {
    let square = 0;
    const colon = group.findIndex((token) => {
      if (token.text === "[") square++;
      else if (token.text === "]") square--;
      return token.text === ":" && square === 0;
    });
    if (colon < 0) continue;
    const names = group.slice(0, colon).filter((token) => token.text === "," || /^[A-Za-z_]/.test(token.text));
    const isVar = names[0]?.lower === "var";
    const count = names.filter((token) => token.text !== "," && token.lower !== "var").length;
    const type = parseType(group.slice(colon + 1), catalog);
    for (let i = 0; i < count; i++) parameters.push({ isVar, type });
  }
  return parameters;
}

function procedureEnd(tokens: Token[], begin: number, limit: number): number {
  let depth = 0;
  for (let i = begin; i < limit; i++) {
    const keyword = tokens[i]!.lower;
    if (keyword === "begin" || keyword === "case" || keyword === "repeat") depth++;
    else if (keyword === "end" || keyword === "until") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseProcedures(source: string, catalog: SubtypeCatalog): ParsedProcedure[] {
  const tokens = tokenize(source);
  const procedures: ParsedProcedure[] = [];
  for (const object of objectSpans(tokens)) {
    for (let i = object.open + 1; i < object.close; i++) {
      if (tokens[i]!.lower !== "procedure") continue;
      const name = tokens[i + 1]?.text;
      if (!name) continue;
      let openParen = i + 2;
      while (openParen < object.close && tokens[openParen]!.text !== "(") openParen++;
      if (openParen >= object.close) continue;
      const closeParen = matching(tokens, openParen, "(", ")", object.close);
      if (closeParen < 0) continue;
      let begin = closeParen + 1;
      while (begin < object.close && tokens[begin]!.lower !== "begin") {
        if (tokens[begin]!.lower === "procedure" || tokens[begin]!.lower === "trigger") break;
        begin++;
      }
      if (begin >= object.close || tokens[begin]!.lower !== "begin") continue;
      const end = procedureEnd(tokens, begin, object.close);
      if (end < 0) continue;
      const declaration = declarationStart(tokens, i);
      const signatureTail = tokens.slice(closeParen + 1, begin);
      const variables = signatureTail.findIndex((token) => token.lower === "var");
      const headerTail = variables < 0 ? signatureTail : signatureTail.slice(0, variables);
      const colon = headerTail.findIndex((token) => token.text === ":");
      const returnTokens = colon < 0
        ? []
        : headerTail.slice(colon + 1, headerTail.findIndex((token, index) => index > colon && token.text === ";") >= 0
          ? headerTail.findIndex((token, index) => index > colon && token.text === ";")
          : headerTail.length);
      const eventLike = [...declaration.attributes].some((attribute) =>
        attribute === "integrationevent" || attribute === "businessevent" || attribute === "internalevent" ||
        attribute === "eventsubscriber" || attribute.endsWith("handler"));
      procedures.push({
        object,
        name,
        startLine: tokens[declaration.index]!.line,
        endLine: tokens[end]!.line,
        parameters: parseParameters(tokens.slice(openParen + 1, closeParen), catalog),
        returnType: parseType(returnTokens, catalog),
        eventLike,
      });
      i = end;
    }
  }
  return procedures;
}

function fnvUtf16(value: string): number {
  let hash = -2128831035;
  const bytes = Buffer.from(value, "utf16le");
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash | 0;
}

function combine(hash: number, ...values: number[]): number {
  for (const value of values) hash = ((((hash << 5) + hash + (hash >> 27)) ^ value) | 0);
  return hash;
}

function typeKey(type: AlTypeRef): string | null {
  return Object.entries(NAV_TYPE).find(([, value]) => value === type.navTypeKind)?.[0] ?? null;
}

function parameterKind(type: AlTypeRef): number | null {
  if (type.navTypeKind === null) return null;
  const key = typeKey(type);
  return key !== null && RETURN_VALUE_TYPES.has(key) ? (type.navTypeKind & ~RETURN_VALUE_MASK) : type.navTypeKind;
}

function subtypeHash(type: AlTypeRef, runtimeMajor: number, recursive = false): number | null {
  if (type.unresolved || type.navTypeKind === null) return null;
  const key = typeKey(type);
  if (key === null) return null;
  if (["table", "testrequestpage", "testpage", "record", "codeunit", "page", "xmlport", "query", "enum"].includes(key)) {
    return type.subtypeId ?? null;
  }
  if (key === "interface" || key === "dotnet") return type.subtypeName ? fnvUtf16(type.subtypeName) : null;
  if (key === "list" || key === "dictionary") {
    const args = type.typeArguments ?? [];
    if (args.some((arg) => arg.unresolved || arg.navTypeKind === null)) return null;
    let hash: number;
    if (runtimeMajor >= 11) {
      hash = combine(type.navTypeKind, args.length);
      for (const arg of args) {
        hash = combine(hash, arg.symbolKind);
        if (typeKey(arg) === "enum") {
          if (arg.subtypeId === undefined) return null;
          hash = combine(hash, arg.subtypeId);
        }
      }
      const first = subtypeHash(args[0]!, runtimeMajor, true);
      if (first === null) return null;
      hash = combine(hash, first);
    } else {
      const first = subtypeHash(args[0]!, runtimeMajor, true);
      if (first === null) return null;
      hash = first;
    }
    for (let i = 1; i < args.length; i++) {
      const next = subtypeHash(args[i]!, runtimeMajor, true);
      if (next === null) return null;
      hash = combine(hash, next);
    }
    return hash;
  }
  if (recursive) {
    let hash = type.navTypeKind;
    if (type.length !== undefined) hash = combine(hash, type.length);
    return hash;
  }
  return 1;
}

// WIRE: procedure coverage reports MethodId. This calculation follows AL compiler
// MethodSymbol.CalculateMethodIdForNewVersions, TypeSymbolExtensions.GetSubTypeHashCodeForNewVersions,
// and Utilities.Hash (AL Development Tools 17.0.34.45391). Cross-checked against compiler-emitted
// SymbolReference.json IDs and the BC28 TestRunCompleted coverage payload.
export function calculateProcedureMethodId(
  name: string,
  returnType: AlTypeRef,
  parameters: ParsedParameter[],
  runtimeMajor: number,
  eventLike = false,
): { methodId: number | null; warning?: string } {
  if (returnType.navTypeKind === null || returnType.unresolved) {
    return { methodId: null, warning: returnType.unresolved ?? "unresolved return type" };
  }
  let hash = combine(fnvUtf16(name.toUpperCase()), returnType.navTypeKind);
  const requiresSubtype = !eventLike && parameters.some((parameter) => {
    const key = typeKey(parameter.type);
    return key !== null && SUBTYPE_KIND.has(key);
  });
  if (runtimeMajor < 7 && requiresSubtype) {
    return { methodId: null, warning: "legacy runtime subtype method IDs are not resolved conservatively" };
  }
  for (let index = 0; index < parameters.length; index++) {
    const parameter = parameters[index]!;
    if (parameter.type.unresolved && !eventLike) {
      return { methodId: null, warning: parameter.type.unresolved };
    }
    const kind = parameterKind(parameter.type);
    if (kind === null) return { methodId: null, warning: parameter.type.unresolved ?? "unresolved parameter type" };
    hash = combine(hash, index, parameter.isVar ? 1 : 0, kind);
    if (requiresSubtype) {
      const subtype = subtypeHash(parameter.type, runtimeMajor);
      if (subtype === null) return { methodId: null, warning: parameter.type.unresolved ?? "unresolved parameter subtype" };
      hash = combine(hash, subtype);
    }
  }
  return { methodId: hash };
}

async function walkAlFiles(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walkAlFiles(join(dir, entry.name), found);
    } else if (entry.name.toLowerCase().endsWith(".al")) found.push(resolve(dir, entry.name));
  }
  return found;
}

function addLocalDeclarations(catalog: SubtypeCatalog, source: string): void {
  const tokens = tokenize(source);
  for (let i = 0; i < tokens.length - 2; i++) {
    const kind = tokens[i]!.lower;
    if (!OBJECT_KEYWORDS.has(kind) || !/^\d+$/.test(tokens[i + 1]!.text)) continue;
    const id = Number(tokens[i + 1]!.text);
    const name = tokens[i + 2]!.text;
    if (kind === "table") catalog.add("record", name, id, true);
    else if (kind === "page") { catalog.add("page", name, id, true); catalog.add("testpage", name, id, true); }
    else if (kind === "report") { catalog.add("report", name, id, true); catalog.add("testrequestpage", name, id, true); }
    else if (["codeunit", "xmlport", "query", "enum", "interface"].includes(kind)) catalog.add(kind, name, id, true);
  }
}

function addDefinitions(catalog: SubtypeCatalog, value: unknown, key: string, kinds: string[]): void {
  const definitions = (value as Record<string, unknown>)[key];
  if (!Array.isArray(definitions)) return;
  for (const definition of definitions) {
    if (typeof definition !== "object" || definition === null) continue;
    const record = definition as Record<string, unknown>;
    if (typeof record["Id"] !== "number" || typeof record["Name"] !== "string") continue;
    for (const kind of kinds) catalog.add(kind, record["Name"], record["Id"], false);
  }
}

function addReferencedSubtypes(catalog: SubtypeCatalog, root: unknown): void {
  const stack: unknown[] = [root];
  const kindByTypeName: Record<string, string> = {
    Record: "record",
    Codeunit: "codeunit",
    Page: "page",
    Report: "report",
    XmlPort: "xmlport",
    Query: "query",
    Enum: "enum",
    Interface: "interface",
    TestPage: "testpage",
    TestRequestPage: "testrequestpage",
  };
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) { stack.push(...value); continue; }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const kind = typeof record["Name"] === "string" ? kindByTypeName[record["Name"]] : undefined;
    const subtype = record["Subtype"];
    if (kind && typeof subtype === "object" && subtype !== null) {
      const typed = subtype as Record<string, unknown>;
      if (typeof typed["Name"] === "string" && typeof typed["Id"] === "number") {
        catalog.add(kind, typed["Name"], typed["Id"], false);
      }
    }
    stack.push(...Object.values(record));
  }
}

async function addDependencySymbols(
  catalog: SubtypeCatalog,
  project: string,
  cache?: AlProcedureDiscoveryCache,
): Promise<string[]> {
  // WIRE: AL compiler .app packages expose object identities in SymbolReference.json under
  // Tables/Codeunits/Pages/Reports/XmlPorts/Queries/EnumTypes/Interfaces. Parameter type nodes
  // also carry Name + Subtype{Name,Id}; verified against AL Development Tools 17.0.34.45391 output.
  const warnings: string[] = [];
  let packages: string[];
  try {
    packages = (await readdir(join(project, ".alpackages"), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".app"))
      .map((entry) => join(project, ".alpackages", entry.name));
  } catch {
    return warnings;
  }
  for (const file of packages) {
    try {
      const metadata = await stat(file);
      const cached = cache?.packages.get(file);
      if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
        for (const symbol of cached.symbols) catalog.add(symbol.kind, symbol.name, symbol.id, false);
        continue;
      }
      const zip = await readFile(file);
      const symbolEntry = extractEntry(zip, "SymbolReference.json");
      if (!symbolEntry) continue;
      const text = symbolEntry.toString("utf8").replace(/^\uFEFF/, "");
      const symbols = JSON.parse(text) as Record<string, unknown>;
      const packageCatalog = new SubtypeCatalog();
      addDefinitions(packageCatalog, symbols, "Tables", ["record"]);
      addDefinitions(packageCatalog, symbols, "Codeunits", ["codeunit"]);
      addDefinitions(packageCatalog, symbols, "Pages", ["page", "testpage"]);
      addDefinitions(packageCatalog, symbols, "Reports", ["report", "testrequestpage"]);
      addDefinitions(packageCatalog, symbols, "XmlPorts", ["xmlport"]);
      addDefinitions(packageCatalog, symbols, "Queries", ["query"]);
      addDefinitions(packageCatalog, symbols, "EnumTypes", ["enum"]);
      addDefinitions(packageCatalog, symbols, "Interfaces", ["interface"]);
      // Symbol packages can omit a moved object's top-level definition while still carrying its
      // exact subtype identity on method parameters. Those references are authoritative too.
      addReferencedSubtypes(packageCatalog, symbols);
      const packageSymbols = packageCatalog.dependencySymbols();
      for (const symbol of packageSymbols) catalog.add(symbol.kind, symbol.name, symbol.id, false);
      cache?.packages.set(file, { mtimeMs: metadata.mtimeMs, size: metadata.size, symbols: packageSymbols });
    } catch {
      warnings.push(`Unable to read dependency symbols from ${file}`);
    }
  }
  return warnings;
}

async function runtimeMajor(project: string): Promise<number> {
  try {
    const app = JSON.parse(await readFile(join(project, "app.json"), "utf8")) as { runtime?: unknown };
    const parsed = Number.parseInt(String(app.runtime ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  } catch {
    // Missing runtime means the compiler uses its current default; use the current method-ID path.
    return Number.MAX_SAFE_INTEGER;
  }
}

export async function discoverAlProcedureIdentities(
  projectDir: string,
  relativeFiles: string[],
  cache?: AlProcedureDiscoveryCache,
): Promise<{ procedures: AlProcedureIdentity[]; warnings: string[] }> {
  const project = resolve(projectDir);
  const catalog = new SubtypeCatalog();
  let allSources: Array<{ file: string; source: string }>;
  try {
    const allFiles = await walkAlFiles(project);
    allSources = await Promise.all(allFiles.map(async (file) => ({ file, source: await readFile(file, "utf8") })));
  } catch (error) {
    throw new BcDevError(
      "CONFIGURATION_ERROR",
      "Unable to read the AL project source for coverage gap analysis",
      "configuration",
      false,
      { project },
      { cause: error },
    );
  }
  for (const entry of allSources) addLocalDeclarations(catalog, entry.source);
  const warnings = await addDependencySymbols(catalog, project, cache);
  const runtime = await runtimeMajor(project);
  const wanted = new Set(relativeFiles.map((file) => resolve(project, file)));
  const procedures: AlProcedureIdentity[] = [];
  for (const { file, source } of allSources) {
    if (!wanted.has(file)) continue;
    for (const parsed of parseProcedures(source, catalog)) {
      const identity = calculateProcedureMethodId(parsed.name, parsed.returnType, parsed.parameters, runtime, parsed.eventLike);
      procedures.push({
        objectType: parsed.object.objectType,
        objectId: parsed.object.objectId,
        objectName: parsed.object.name,
        name: parsed.name,
        file,
        relativeFile: relative(project, file).split("\\").join("/"),
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        methodId: identity.methodId,
        identityWarning: identity.warning,
        signature: { returnType: parsed.returnType, parameters: parsed.parameters, eventLike: parsed.eventLike },
      });
    }
  }
  return { procedures, warnings };
}
