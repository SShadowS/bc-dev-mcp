import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { analyzeCoverageGaps } from "../../src/core/coverage-gaps";
import { discoverAlProcedureIdentities, type AlProcedureIdentity } from "../../src/core/al-procedures";
import type { GitChangeSet } from "../../src/core/git-changes";

const changes: GitChangeSet = {
  baseRef: "origin/main",
  mergeBase: "a".repeat(40),
  head: "workingTree",
  files: [
    { relativeFile: "src/Foo.al", ranges: [{ start: 5, end: 7 }, { start: 20, end: 20 }] },
    { relativeFile: "src/NoProcedures.al", ranges: [{ start: 1, end: 2 }] },
  ],
};

function procedure(overrides: Partial<AlProcedureIdentity>): AlProcedureIdentity {
  return {
    objectType: 5,
    objectId: 50100,
    objectName: "Foo",
    name: "Work",
    file: "/repo/src/Foo.al",
    relativeFile: "src/Foo.al",
    startLine: 4,
    endLine: 10,
    methodId: 100,
    signature: { returnType: { navTypeKind: 0, symbolKind: 2 }, parameters: [], eventLike: false },
    ...overrides,
  };
}

const unattributedChanges: GitChangeSet = {
  baseRef: "origin/main",
  mergeBase: "b".repeat(40),
  head: "workingTree",
  files: [{ relativeFile: "src/Foo.al", ranges: [{ start: 3, end: 4 }] }],
};

const unattributedFoo = {
  objectType: 5,
  objectId: 50100,
  objectName: "Foo",
  file: "/repo/src/Foo.al",
  relativeFile: "src/Foo.al",
  lines: [1, 2, 4, 12],
};

describe("coverage gap analysis", () => {
  test("fails closed when changed code lines belong to no procedure and no trigger", () => {
    const result = analyzeCoverageGaps(
      unattributedChanges,
      { procedures: [], unattributedCode: [unattributedFoo] },
      [],
      false,
      true,
      true,
    );

    expect(result.complete).toBe(false);
    expect(result.summary.unattributedChanges).toBe(1);
    expect(result.warnings.join(" ")).toContain("src/Foo.al");
    expect(result.warnings.join(" ")).toContain("4");
  });

  test("keeps the gate complete when changed lines carry no unattributed code", () => {
    const result = analyzeCoverageGaps(
      { ...unattributedChanges, files: [{ relativeFile: "src/Foo.al", ranges: [{ start: 5, end: 9 }] }] },
      { procedures: [], unattributedCode: [unattributedFoo] },
      [],
      false,
      true,
      true,
    );

    expect(result.complete).toBe(true);
    expect(result.summary.unattributedChanges).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  test("classifies changed procedures and aggregates the tests that covered them", () => {
    const result = analyzeCoverageGaps(changes, {
      procedures: [
        procedure({ name: "Covered", methodId: 100 }),
        procedure({ name: "Missed", methodId: 200, startLine: 18, endLine: 24 }),
        procedure({ name: "Unknown", methodId: null, identityWarning: "unresolved type" }),
        procedure({ name: "Unchanged", methodId: 300, startLine: 11, endLine: 17 }),
      ],
    }, [
      { testObjectId: 60000, testMethodId: 1, coveredProcedures: [{ objectType: 5, objectId: 50100, methodId: 100 }] },
      { testObjectId: 60001, testMethodId: 2, coveredProcedures: [{ objectType: 5, objectId: 50100, methodId: 100 }] },
    ], false, true);

    expect(result.summary).toEqual({ changedFiles: 2, changedProcedures: 3, covered: 1, uncovered: 1, unknown: 1, unattributedChanges: 0 });
    expect(result.complete).toBe(false);
    expect(result.procedures.map((entry) => [entry.name, entry.status])).toEqual([
      ["Covered", "covered"],
      ["Unknown", "unknown"],
      ["Missed", "uncovered"],
    ]);
    expect(result.procedures[0]?.coveredBy).toEqual([
      { testObjectId: 60000, testMethodId: 1 },
      { testObjectId: 60001, testMethodId: 2 },
    ]);
    expect(result.warnings.join(" ")).toContain("unresolved type");
  });

  test("keeps positive evidence but makes absent coverage unknown after an aborted run", () => {
    const result = analyzeCoverageGaps(changes, {
      procedures: [
        procedure({ name: "Covered", methodId: 100 }),
        procedure({ name: "Maybe", methodId: 200, startLine: 18, endLine: 24 }),
      ],
    }, [
      { testObjectId: 60000, testMethodId: 1, coveredProcedures: [{ objectType: 5, objectId: 50100, methodId: 100 }] },
    ], true, true);
    expect(result.procedures.map((entry) => entry.status)).toEqual(["covered", "unknown"]);
    expect(result.summary).toMatchObject({ covered: 1, uncovered: 0, unknown: 1 });
    expect(result.complete).toBe(false);
  });

  test("uses the test identity as coverage for an executed changed test procedure", () => {
    const result = analyzeCoverageGaps(changes, {
      procedures: [procedure({ objectId: 60000, name: "ChangedTest", methodId: 77 })],
    }, [
      { testObjectId: 60000, testMethodId: 77, coveredProcedures: [] },
    ], false, true);
    expect(result.procedures[0]).toMatchObject({
      name: "ChangedTest",
      status: "covered",
      coveredBy: [{ testObjectId: 60000, testMethodId: 77 }],
    });
  });

  test("reports a complete empty result when changed files contain no executable procedures", () => {
    const result = analyzeCoverageGaps(changes, { procedures: [] }, []);
    expect(result.complete).toBe(true);
    expect(result.summary).toEqual({ changedFiles: 2, changedProcedures: 0, covered: 0, uncovered: 0, unknown: 0, unattributedChanges: 0 });
  });

  test("retains server evidence but refuses a complete classification without a deployment assertion", () => {
    const result = analyzeCoverageGaps(changes, {
      procedures: [procedure({ name: "LocallyChanged", methodId: 100, identityWarning: "signature caveat retained" })],
      complete: true,
    }, [
      { testObjectId: 60000, testMethodId: 1, coveredProcedures: [{ objectType: 5, objectId: 50100, methodId: 100 }] },
    ]);
    expect(result).toMatchObject({
      complete: false,
      deployment: { status: "unverified", verified: false },
      summary: { covered: 0, uncovered: 0, unknown: 1 },
    });
    expect(result.procedures[0]).toMatchObject({
      status: "unknown",
      coveredBy: [{ testObjectId: 60000, testMethodId: 1 }],
    });
    expect(result.procedures[0]?.warning).toContain("signature caveat retained");
    expect(result.warnings.join(" ")).toContain("changesDeployed: true");
  });

  test("keeps complete false when AL procedure discovery was incomplete", () => {
    const result = analyzeCoverageGaps(changes, { procedures: [], complete: false, warnings: ["parser stopped"] }, [], false, true);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toContain("procedure discovery was incomplete");
  });

  test("fails closed when changed lines intersect a trigger with an unvalidated coverage identity", () => {
    const result = analyzeCoverageGaps(changes, {
      procedures: [],
      unsupportedExecutables: [{
        objectType: 5,
        objectId: 50100,
        objectName: "Foo",
        kind: "trigger",
        name: "OnRun",
        file: "/repo/src/Foo.al",
        relativeFile: "src/Foo.al",
        startLine: 4,
        endLine: 10,
        warning: "Trigger method identities are not yet validated against Business Central procedure coverage.",
      }],
      complete: true,
    }, [], false, true);

    expect(result.complete).toBe(false);
    expect(result.summary).toEqual({ changedFiles: 2, changedProcedures: 0, covered: 0, uncovered: 0, unknown: 0, unattributedChanges: 0 });
    expect(result.warnings.join(" ")).toContain("trigger OnRun");
    expect(result.warnings.join(" ")).toContain("cannot be used as a complete gate");
  });

  test("fails the real trigger-zoo table change closed instead of returning an empty green gate", async () => {
    const project = resolve("demos/trigger-zoo");
    const relativeFile = "src/TriggerDemo.Table.al";
    const discovered = await discoverAlProcedureIdentities(project, [relativeFile]);
    const triggerChanges: GitChangeSet = {
      baseRef: "origin/main",
      mergeBase: "d".repeat(40),
      head: "workingTree",
      files: [{ relativeFile, ranges: [{ start: 30, end: 37 }] }],
    };

    const result = analyzeCoverageGaps(triggerChanges, discovered, [], false, true);

    expect(result.complete).toBe(false);
    expect(result.summary).toEqual({ changedFiles: 1, changedProcedures: 0, covered: 0, uncovered: 0, unknown: 0, unattributedChanges: 0 });
    expect(result.warnings.join(" ")).toContain("trigger OnInsert");
  });

  test("keeps positive evidence but never infers uncovered from a missing coverage payload", () => {
    const result = analyzeCoverageGaps(changes, {
      procedures: [
        procedure({ name: "Covered", methodId: 100 }),
        procedure({ name: "Maybe", methodId: 200, startLine: 18, endLine: 24 }),
      ],
    }, [
      { testObjectId: 60000, testMethodId: 1, coveredProcedures: [{ objectType: 5, objectId: 50100, methodId: 100 }] },
    ], false, true, false);

    expect(result.procedures.map((entry) => entry.status)).toEqual(["covered", "unknown"]);
    expect(result.summary).toMatchObject({ covered: 1, uncovered: 0, unknown: 1 });
    expect(result.complete).toBe(false);
    expect(result.procedures[1]?.warning).toContain("complete procedure-coverage payload");
  });
});
