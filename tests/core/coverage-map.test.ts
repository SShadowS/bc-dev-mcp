import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BcDevError } from "../../src/core/agent-errors";
import { buildCoverageMap, parseCoverageMap, readCoverageMap, writeCoverageMap } from "../../src/core/coverage-map";

describe("coverage map", () => {
  const coverage = [
    { testObjectId: 50101, testMethodId: 9, coveredProcedures: [{ objectType: 5, objectId: 50000, methodId: 3, file: "x.al" }] },
    {
      testObjectId: 50100,
      testMethodId: 7,
      coveredProcedures: [
        { objectType: 5, objectId: 50000, methodId: 2 },
        { objectType: 1, objectId: 18, methodId: 1 },
      ],
    },
    { testObjectId: 50100, testMethodId: 7, coveredProcedures: [{ objectType: 5, objectId: 50000, methodId: 2 }, { objectType: 5, objectId: 50000, methodId: 1 }] },
  ];

  test("builds a sorted, deduplicated, name-resolved map stamped with the merge base", () => {
    const map = buildCoverageMap(
      coverage,
      { baseRef: "origin/main", mergeBase: "a".repeat(40), complete: true },
      [
        { objectType: 5, objectId: 50100, methodId: 7, name: "PostsInvoice" },
        { objectType: 5, objectId: 50101, methodId: null, name: "Unresolved" },
      ],
    );
    expect(map).toEqual({
      format: "bc-dev-mcp.coverage-map",
      version: 1,
      baseRef: "origin/main",
      mergeBase: "a".repeat(40),
      complete: true,
      tests: [
        {
          codeunitId: 50100,
          methodId: 7,
          method: "PostsInvoice",
          procedures: [
            { objectType: 1, objectId: 18, methodId: 1 },
            { objectType: 5, objectId: 50000, methodId: 1 },
            { objectType: 5, objectId: 50000, methodId: 2 },
          ],
        },
        { codeunitId: 50101, methodId: 9, method: null, procedures: [{ objectType: 5, objectId: 50000, methodId: 3 }] },
      ],
    });
  });

  test("round-trips through write and read", async () => {
    const map = buildCoverageMap(coverage, { baseRef: null, mergeBase: null, complete: false });
    const file = join(mkdtempSync(join(tmpdir(), "bcmcp-covmap-")), "map.json");
    await writeCoverageMap(file, map);
    expect(await readCoverageMap(file)).toEqual(map);
  });

  test("rejects foreign formats, unknown versions and malformed tests with actionable errors", () => {
    const valid = buildCoverageMap(coverage, { baseRef: null, mergeBase: null, complete: true });
    const bad = [
      "not json",
      JSON.stringify({ ...valid, format: "other" }),
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, tests: [{ codeunitId: "x", methodId: 1, method: null, procedures: [] }] }),
      JSON.stringify({ ...valid, tests: [{ codeunitId: 1, methodId: 1, method: null, procedures: [{ objectType: 5 }] }] }),
    ];
    for (const text of bad) {
      expect(() => parseCoverageMap(text)).toThrow(BcDevError);
    }
    expect(() => parseCoverageMap(JSON.stringify({ ...valid, version: 2 }))).toThrow(/unsupported version 2/);
  });

  test("reports a missing file as NOT_FOUND", async () => {
    const error = await readCoverageMap(join(tmpdir(), "does-not-exist-covmap.json")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BcDevError);
    expect((error as BcDevError).code).toBe("NOT_FOUND");
  });
});
