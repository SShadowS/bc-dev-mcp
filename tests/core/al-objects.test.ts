import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AlObjectIndex, discoverAlpackagesTests, discoverPackageTests, discoverTestRunners, discoverTests, permissionsIgnoredByHub, type TestCodeunitInfo } from "../../src/core/al-objects";
import { buildAppPackage } from "../fixtures/app-package";

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

  test("captures per-method attributes and TransactionModel (default AutoCommit)", async () => {
    const dir = makeProject();
    writeFileSync(
      join(dir, "Tx.Codeunit.al"),
      [
        'codeunit 50105 "Tx Tests"',
        "{",
        "    Subtype = Test;",
        "",
        "    [Test]",
        "    [TransactionModel(TransactionModel::AutoRollback)]",
        "    procedure Rolled()",
        "    begin",
        "    end;",
        "",
        "    [HandlerFunctions('ConfirmYes')]",
        "    [Test]",
        "    procedure Plain()",
        "    begin",
        "    end;",
        "",
        "    [ConfirmHandler]",
        "    procedure ConfirmYes(Q: Text; var Reply: Boolean)",
        "    begin",
        "    end;",
        "}",
      ].join("\n"),
    );
    const tests = await discoverTests(dir);
    const tx = tests.find((t) => t.codeunitId === 50105);
    expect(tx?.methods).toEqual(["Rolled", "Plain"]);
    expect(tx?.methodDetails).toEqual([
      { name: "Rolled", transactionModel: "AutoRollback", testPermissions: "Restrictive", attributes: ["Test", "TransactionModel(TransactionModel::AutoRollback)"] },
      { name: "Plain", transactionModel: "AutoCommit", testPermissions: "Restrictive", attributes: ["HandlerFunctions('ConfirmYes')", "Test"] },
    ]);
  });

  test("captures TestPermissions: codeunit property (default Restrictive), method attribute overrides", async () => {
    const dir = makeProject();
    writeFileSync(
      join(dir, "Perm.Codeunit.al"),
      [
        'codeunit 50108 "Perm Tests"',
        "{",
        "    Subtype = Test;",
        "    TestPermissions = NonRestrictive;",
        "",
        "    [Test]",
        "    procedure Inherits()",
        "    begin",
        "    end;",
        "",
        "    [Test]",
        "    [TestPermissions(TestPermissions::Disabled)]",
        "    procedure Overrides()",
        "    begin",
        "    end;",
        "}",
      ].join("\n"),
    );
    const tests = await discoverTests(dir);
    const perm = tests.find((t) => t.codeunitId === 50108);
    expect(perm?.testPermissions).toBe("NonRestrictive");
    expect(perm?.methodDetails.map((m) => [m.name, m.testPermissions])).toEqual([["Inherits", "NonRestrictive"], ["Overrides", "Disabled"]]);
    expect(tests.find((t) => t.codeunitId === 50100)?.testPermissions).toBe("Restrictive");
  });

  test("permissionsIgnoredByHub lists targeted methods whose TestPermissions is not Disabled", () => {
    const cu = (codeunitId: number, testPermissions: string, methods: [string, string][]): TestCodeunitInfo => ({
      codeunitId, name: `CU ${codeunitId}`, file: "", testPermissions,
      methods: methods.map(([n]) => n),
      methodDetails: methods.map(([name, tp]) => ({ name, transactionModel: "AutoCommit", testPermissions: tp, attributes: ["Test"] })),
    });
    const tests = [
      cu(1, "Restrictive", [["A", "Restrictive"], ["B", "Disabled"]]),
      cu(2, "Disabled", [["C", "Disabled"]]),
      cu(3, "NonRestrictive", [["D", "NonRestrictive"]]),
      cu(4, "Restrictive", [["E", "Restrictive"]]),
    ];
    expect(permissionsIgnoredByHub(tests, [{ id: 1 }, { id: 2 }, { id: 3, methods: ["d"] }, { id: 99 }])).toEqual([
      { codeunitId: 1, name: "CU 1", testPermissions: "Restrictive", methods: ["A"] },
      { codeunitId: 3, name: "CU 3", testPermissions: "NonRestrictive", methods: ["D"] },
    ]);
    expect(permissionsIgnoredByHub(tests, [{ id: 1, methods: ["B"] }])).toEqual([]);
  });

  test("reports TestRunner codeunits with their TestIsolation", async () => {
    const dir = makeProject();
    writeFileSync(
      join(dir, "Runner.Codeunit.al"),
      ['codeunit 50106 "My Runner"', "{", "    Subtype = TestRunner;", "    TestIsolation = Codeunit;", "}"].join("\n"),
    );
    writeFileSync(join(dir, "Runner2.Codeunit.al"), ['codeunit 50107 "Bare Runner"', "{", "    Subtype = TestRunner;", "}"].join("\n"));
    const runners = await discoverTestRunners(dir);
    expect(runners).toEqual([
      expect.objectContaining({ codeunitId: 50106, name: "My Runner", testIsolation: "Codeunit" }),
      expect.objectContaining({ codeunitId: 50107, name: "Bare Runner", testIsolation: "Disabled" }),
    ]);
    // runners are not test codeunits
    expect((await discoverTests(dir)).map((t) => t.codeunitId)).toEqual([50100]);
  });
});

describe("package test discovery", () => {
  const testCodeunit = {
    Id: 50190,
    Name: "Probe Tests",
    Properties: [{ Name: "Subtype", Value: "Test" }, { Name: "TestPermissions", Value: "Disabled" }],
    Methods: [
      { Name: "WithHandlers", Attributes: [
        { Name: "Test" },
        { Name: "HandlerFunctions", Arguments: [{ Value: "MsgHandler" }] },
        { Name: "TransactionModel", Arguments: [{ Value: "AutoRollback" }] },
      ] },
      { Name: "MsgHandler", Attributes: [{ Name: "MessageHandler" }] },
      { Name: "SecondTest", Attributes: [{ Name: "test" }, { Name: "TestPermissions", Arguments: [{ Value: "Restrictive" }] }] },
    ],
  };
  const symbols = {
    Codeunits: [
      testCodeunit,
      { Id: 50191, Name: "Plain", Methods: [{ Name: "X", Attributes: [{ Name: "Test" }] }] },
    ],
    Namespaces: [{
      Name: "SShadowS",
      Namespaces: [{
        Name: "Probe",
        Codeunits: [
          { Id: 50192, Name: "Probe Empty Tests", Properties: [{ Name: "Subtype", Value: "Test" }], Methods: [] },
          { Id: 50193, Name: "Probe Runner", Properties: [{ Name: "Subtype", Value: "TestRunner" }, { Name: "TestIsolation", Value: "Codeunit" }] },
          { Id: 50194, Name: "Default Runner", Properties: [{ Name: "Subtype", Value: "TestRunner" }] },
        ],
      }],
    }],
  };
  const fixture = (name: string, nulPadding = 0) => buildAppPackage({
    publisher: "SShadowS", name, appId: "7A1C0001-0000-4000-8000-0000000000B1", version: "1.0.0.0", symbols, nulPadding,
  });

  test("lists test codeunits and runners from a .app in declaration order with namespaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcmcp-pkg-"));
    const app = join(dir, "probe.app");
    writeFileSync(app, fixture("Probe", 64));
    const pkg = await discoverPackageTests(app);
    expect(pkg).toMatchObject({ path: resolve(app), appId: "7a1c0001-0000-4000-8000-0000000000b1", appName: "Probe", publisher: "SShadowS", version: "1.0.0.0" });
    expect(pkg.tests).toEqual([
      {
        codeunitId: 50190, name: "Probe Tests", namespace: "", file: resolve(app), testPermissions: "Disabled",
        methods: ["WithHandlers", "SecondTest"],
        methodDetails: [
          { name: "WithHandlers", transactionModel: "AutoRollback", testPermissions: "Disabled", attributes: ["Test", "HandlerFunctions(MsgHandler)", "TransactionModel(AutoRollback)"] },
          { name: "SecondTest", transactionModel: "AutoCommit", testPermissions: "Restrictive", attributes: ["test", "TestPermissions(Restrictive)"] },
        ],
      },
      { codeunitId: 50192, name: "Probe Empty Tests", namespace: "SShadowS.Probe", file: resolve(app), testPermissions: "Restrictive", methods: [], methodDetails: [] },
    ]);
    expect(pkg.runners).toEqual([
      { codeunitId: 50193, name: "Probe Runner", namespace: "SShadowS.Probe", file: resolve(app), testIsolation: "Codeunit" },
      { codeunitId: 50194, name: "Default Runner", namespace: "SShadowS.Probe", file: resolve(app), testIsolation: "Disabled" },
    ]);
  });

  test("a file that is not an AL package is a CONFIGURATION_ERROR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcmcp-pkg-"));
    writeFileSync(join(dir, "bad.app"), "not a zip");
    await expect(discoverPackageTests(join(dir, "bad.app"))).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });

  test("a missing appFile propagates ENOENT", async () => {
    await expect(discoverPackageTests(join(tmpdir(), "no-such-bcmcp.app"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("scans .alpackages, warning on unreadable packages and continuing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcmcp-pkg-"));
    mkdirSync(join(dir, ".alpackages", "nested"), { recursive: true });
    writeFileSync(join(dir, ".alpackages", "a.app"), fixture("A"));
    writeFileSync(join(dir, ".alpackages", "broken.app"), "garbage");
    writeFileSync(join(dir, ".alpackages", "nested", "c.app"), fixture("C"));
    writeFileSync(join(dir, ".alpackages", "readme.txt"), "x");
    const { packages, warnings } = await discoverAlpackagesTests(dir);
    expect(packages.map((p) => p.appName)).toEqual(["A"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Unable to read test symbols from ${join(dir, ".alpackages", "broken.app")}`);
  });

  test("a missing .alpackages folder yields no packages and a warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcmcp-pkg-"));
    const { packages, warnings } = await discoverAlpackagesTests(dir);
    expect(packages).toEqual([]);
    expect(warnings[0]).toContain(join(dir, ".alpackages"));
  });
});
