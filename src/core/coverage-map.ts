import { readFile, writeFile } from "node:fs/promises";
import { BcDevError } from "./agent-errors";
import { AL_OBJECT_TYPE } from "./al-objects";
import type { CoverageEntry } from "./types";

export const COVERAGE_MAP_FORMAT = "bc-dev-mcp.coverage-map";
export const COVERAGE_MAP_VERSION = 1;

export interface CoverageMapProcedure {
  objectType: number;
  objectId: number;
  methodId: number;
}

export interface CoverageMapTest {
  codeunitId: number;
  methodId: number;
  /** AL test method name resolved from local source, or null when no local procedure matches methodId. */
  method: string | null;
  procedures: CoverageMapProcedure[];
}

/**
 * Versioned per-test procedure-coverage map: which procedures each test method reached in one
 * run, stamped with the Git merge base the run's coverage was compared against.
 */
export interface CoverageMap {
  format: typeof COVERAGE_MAP_FORMAT;
  version: typeof COVERAGE_MAP_VERSION;
  baseRef: string | null;
  mergeBase: string | null;
  /** false when the run aborted or Business Central omitted a coverage payload; absence then proves nothing. */
  complete: boolean;
  tests: CoverageMapTest[];
}

export interface TestMethodName {
  objectType: number;
  objectId: number;
  methodId: number | null;
  name: string;
}

const procedureOrder = (a: CoverageMapProcedure, b: CoverageMapProcedure) =>
  a.objectType - b.objectType || a.objectId - b.objectId || a.methodId - b.methodId;

export function buildCoverageMap(
  coverage: CoverageEntry[],
  stamp: { baseRef: string | null; mergeBase: string | null; complete: boolean },
  testMethods: TestMethodName[] = [],
): CoverageMap {
  const names = new Map<string, string>();
  for (const method of testMethods) {
    if (method.objectType === AL_OBJECT_TYPE.codeunit && method.methodId !== null) {
      names.set(`${method.objectId}|${method.methodId}`, method.name);
    }
  }
  // A test reported more than once (e.g. by several groups) gets the union of its procedures.
  const byTest = new Map<string, { test: CoverageMapTest; seen: Set<string> }>();
  for (const entry of coverage) {
    const key = `${entry.testObjectId}|${entry.testMethodId}`;
    let slot = byTest.get(key);
    if (!slot) {
      slot = {
        test: { codeunitId: entry.testObjectId, methodId: entry.testMethodId, method: names.get(key) ?? null, procedures: [] },
        seen: new Set(),
      };
      byTest.set(key, slot);
    }
    for (const { objectType, objectId, methodId } of entry.coveredProcedures) {
      const procedureKey = `${objectType}|${objectId}|${methodId}`;
      if (slot.seen.has(procedureKey)) continue;
      slot.seen.add(procedureKey);
      slot.test.procedures.push({ objectType, objectId, methodId });
    }
  }
  const tests = [...byTest.values()].map(({ test }) => ({ ...test, procedures: test.procedures.sort(procedureOrder) }));
  tests.sort((a, b) => a.codeunitId - b.codeunitId || a.methodId - b.methodId);
  return {
    format: COVERAGE_MAP_FORMAT,
    version: COVERAGE_MAP_VERSION,
    baseRef: stamp.baseRef,
    mergeBase: stamp.mergeBase,
    complete: stamp.complete,
    tests,
  };
}

function invalid(message: string, source: string): BcDevError {
  return new BcDevError("INVALID_ARGUMENT", `Invalid coverage map (${source}): ${message}`, "validation", false, { source });
}

const isInt = (value: unknown): value is number => Number.isInteger(value);
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

export function parseCoverageMap(text: string, source = "input"): CoverageMap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid("not valid JSON", source);
  }
  const map = raw as Partial<CoverageMap> | null;
  if (typeof map !== "object" || map === null || map.format !== COVERAGE_MAP_FORMAT) {
    throw invalid(`format must be "${COVERAGE_MAP_FORMAT}"`, source);
  }
  if (map.version !== COVERAGE_MAP_VERSION) {
    throw invalid(`unsupported version ${String(map.version)}; this build reads version ${COVERAGE_MAP_VERSION}`, source);
  }
  if (!isNullableString(map.baseRef) || !isNullableString(map.mergeBase) || typeof map.complete !== "boolean" || !Array.isArray(map.tests)) {
    throw invalid("baseRef/mergeBase must be string or null, complete boolean, tests an array", source);
  }
  map.tests.forEach((test, index) => {
    const ok = typeof test === "object" && test !== null &&
      isInt(test.codeunitId) && isInt(test.methodId) && isNullableString(test.method) &&
      Array.isArray(test.procedures) &&
      test.procedures.every((p) => typeof p === "object" && p !== null && isInt(p.objectType) && isInt(p.objectId) && isInt(p.methodId));
    if (!ok) throw invalid(`tests[${index}] must carry integer codeunitId/methodId, method string or null, and integer procedure identities`, source);
  });
  return map as CoverageMap;
}

export async function readCoverageMap(path: string): Promise<CoverageMap> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new BcDevError("NOT_FOUND", `Coverage map file could not be read: ${path}`, "configuration", false, { path }, { cause: error });
  }
  return parseCoverageMap(text, path);
}

export async function writeCoverageMap(path: string, map: CoverageMap): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new BcDevError("CONFIGURATION_ERROR", `Coverage map file could not be written: ${path}`, "configuration", false, { path }, { cause: error });
  }
}
