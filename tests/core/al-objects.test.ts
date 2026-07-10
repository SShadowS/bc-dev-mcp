import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AlObjectIndex, discoverTests } from "../../src/core/al-objects";

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "bcmcp-al-"));
  writeFileSync(
    join(dir, "MyTests.Codeunit.al"),
    [
      'codeunit 50100 "My Tests"',
      "{",
      "    Subtype = Test;",
      "",
      "    [Test]",
      "    procedure PostInvoice()",
      "    begin",
      "    end;",
      "",
      "    local procedure Helper()",
      "    begin",
      "    end;",
      "",
      "    [Test]",
      "    procedure CancelInvoice()",
      "    begin",
      "    end;",
      "}",
    ].join("\n"),
  );
  writeFileSync(join(dir, "Setup.Table.al"), 'table 50101 "My Setup"\n{\n}\n');
  mkdirSync(join(dir, ".alpackages"));
  writeFileSync(join(dir, ".alpackages", "Ignored.al"), "codeunit 99999 Ignored\n{\n}\n");
  return dir;
}

describe("AlObjectIndex", () => {
  test("indexes objects both directions, skipping .alpackages", async () => {
    const dir = makeProject();
    const index = await AlObjectIndex.build(dir);
    const byFile = index.byFile(resolve(dir, "MyTests.Codeunit.al"));
    expect(byFile).toMatchObject({ objectType: 5, objectId: 50100, name: "My Tests" });
    expect(index.byId(1, 50101)?.name).toBe("My Setup");
    expect(index.byId(5, 99999)).toBeUndefined();
  });

  test("refresh picks up new files", async () => {
    const dir = makeProject();
    const index = await AlObjectIndex.build(dir);
    writeFileSync(join(dir, "New.Page.al"), 'page 50102 "My Page"\n{\n}\n');
    await index.refresh();
    expect(index.byId(8, 50102)?.name).toBe("My Page");
  });

  test("refresh prunes deleted files", async () => {
    const dir = makeProject();
    const index = await AlObjectIndex.build(dir);
    expect(index.byId(1, 50101)).toBeDefined();
    rmSync(join(dir, "Setup.Table.al"));
    await index.refresh();
    expect(index.byId(1, 50101)).toBeUndefined();
    expect(index.byFile(resolve(dir, "Setup.Table.al"))).toBeUndefined();
  });
});

describe("discoverTests", () => {
  test("finds test codeunits with [Test] methods only", async () => {
    const dir = makeProject();
    const tests = await discoverTests(dir);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({
      codeunitId: 50100,
      name: "My Tests",
      methods: ["PostInvoice", "CancelInvoice"],
    });
  });

  test("finds test methods with quoted procedure names", async () => {
    const dir = makeProject();
    writeFileSync(
      join(dir, "Quoted.Codeunit.al"),
      [
        'codeunit 50104 "Quoted Tests"',
        "{",
        "    Subtype = Test;",
        "",
        "    [Test]",
        '    procedure "Post Invoice With Spaces"()',
        "    begin",
        "    end;",
        "}",
      ].join("\n"),
    );
    const tests = await discoverTests(dir);
    const quoted = tests.find((t) => t.codeunitId === 50104);
    expect(quoted?.methods).toEqual(["Post Invoice With Spaces"]);
  });

  test("tolerates comments between [Test] and procedure", async () => {
    const dir = makeProject();
    writeFileSync(
      join(dir, "More.Codeunit.al"),
      [
        'codeunit 50103 "More Tests"',
        "{",
        "    Subtype = Test;",
        "",
        "    [Test]",
        "    [HandlerFunctions('H')]",
        "    // regression: comment between attributes and procedure",
        "    procedure WithComment()",
        "    begin",
        "    end;",
        "}",
      ].join("\n"),
    );
    const tests = await discoverTests(dir);
    const more = tests.find((t) => t.codeunitId === 50103);
    expect(more?.methods).toEqual(["WithComment"]);
  });
});
