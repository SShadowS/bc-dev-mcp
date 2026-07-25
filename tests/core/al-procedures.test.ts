import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AlProcedureDiscoveryCache,
  calculateProcedureMethodId,
  discoverAlProcedureIdentities,
} from "../../src/core/al-procedures";

function symbolPackage(symbols: unknown): Buffer {
  const name = Buffer.from("SymbolReference.json");
  const content = Buffer.from(JSON.stringify(symbols));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + name.length + content.length;
  const centralSize = central.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  const zip = Buffer.concat([local, name, content, central, name, eocd]);
  return Buffer.concat([Buffer.alloc(40, 0x4e), zip]);
}

describe("AL procedure identities", () => {
  test("matches compiler-grounded method-ID vectors for public demo procedure signatures", () => {
    expect(calculateProcedureMethodId(
      "SplitAmount",
      { navTypeKind: 12451847, symbolKind: 2 },
      [
        { isVar: false, type: { navTypeKind: 12451847, symbolKind: 2 } },
        { isVar: false, type: { navTypeKind: 12451845, symbolKind: 2 } },
      ],
      17,
    ).methodId).toBe(616839936);
    expect(calculateProcedureMethodId(
      "TryDivide",
      { navTypeKind: 12451842, symbolKind: 2 },
      [
        { isVar: false, type: { navTypeKind: 12451847, symbolKind: 2 } },
        { isVar: false, type: { navTypeKind: 12451847, symbolKind: 2 } },
      ],
      17,
    ).methodId).toBe(1393946970);
    expect(calculateProcedureMethodId(
      "Größe",
      { navTypeKind: 0, symbolKind: 2 },
      [],
      17,
    ).methodId).toBe(-1116888289);
  });

  test("matches a fixed method-ID vector for var Record and sized Text parameters", () => {
    expect(calculateProcedureMethodId(
      "ArchiveEntry",
      { navTypeKind: 0, symbolKind: 2 },
      [
        { isVar: true, type: { navTypeKind: 917604, symbolKind: 90, subtypeKind: "record", subtypeName: "Demo Entry", subtypeId: 50140 } },
        { isVar: false, type: { navTypeKind: 16646153, symbolKind: 2, length: 2048 } },
      ],
      17,
    ).methodId).toBe(248331974);
  });

  test("discovers executable procedures with attributes, multiline signatures, nested blocks, and quoted names", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-procedures-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "16.0" }));
    writeFileSync(join(project, "Thing.Table.al"), 'table 50101 "Thing"\n{\n}\n');
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      'codeunit 50100 "Worker"',
      "{",
      "    [TryFunction]",
      "    local procedure \"Do Work\"(",
      '        var Thing: Record "Thing";',
      "        Values: List of [Text[20]]) Result: Boolean",
      "    begin",
      "        if Result then begin",
      "            case Values.Count() of",
      "                0: Result := false;",
      "            end;",
      "        end;",
      "    end;",
      "",
      "    [IntegrationEvent(false, false)]",
      "    procedure Published(var Thing: Record \"Thing\")",
      "    begin",
      "    end;",
      "",
      "    procedure NoReturnWithLocals()",
      "    var",
      "        Value: Integer;",
      "    begin",
      "        Value := 1;",
      "    end;",
      "}",
      "",
    ].join("\n"));

    const found = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);
    expect(found.warnings).toEqual([]);
    expect(found.procedures).toHaveLength(3);
    expect(found.procedures[0]).toMatchObject({
      objectType: 5,
      objectId: 50100,
      objectName: "Worker",
      name: "Do Work",
      startLine: 3,
      endLine: 13,
    });
    expect(found.procedures[0]?.methodId).toBe(1097008892);
    expect(found.procedures[0]?.signature.returnType.navTypeKind).toBe(12451842);
    expect(found.procedures[1]).toMatchObject({ name: "Published", startLine: 15, endLine: 18 });
    expect(found.procedures[1]?.methodId).toBeNumber();
    expect(found.procedures[2]).toMatchObject({ name: "NoReturnWithLocals", startLine: 20, endLine: 25 });
    expect(found.procedures[2]?.signature.returnType.navTypeKind).toBe(0);
  });

  test("reproduces method IDs captured from an alc 18 runtime 17 fixture", async () => {
    const fixtureProject = resolve("tests/fixtures/coverage-gap");
    const groundTruth = JSON.parse(
      readFileSync(join(fixtureProject, "compiler-method-ids.json"), "utf8"),
    ) as { vectors: Array<{ source: string; name: string; methodId: number }> };
    const expected = new Map(
      groundTruth.vectors
        .filter((vector) => vector.source.startsWith("src/"))
        .map((vector) => [vector.name, vector.methodId]),
    );

    const found = await discoverAlProcedureIdentities(
      fixtureProject,
      ["src/CompilerVectors.Codeunit.al"],
    );

    expect(found.complete).toBe(true);
    expect(found.unsupportedExecutables).toEqual([]);
    expect(new Map(found.procedures.map((procedure) => [procedure.name, procedure.methodId]))).toEqual(expected);
  });

  test("discovers trigger spans as unsupported executable changes instead of silently omitting them", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-triggers-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "17.0" }));
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      "codeunit 50100 Worker",
      "{",
      "    trigger OnRun()",
      "    begin",
      "        Message('changed');",
      "    end;",
      "",
      "    procedure Helper()",
      "    begin",
      "    end;",
      "}",
    ].join("\n"));

    const found = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);

    expect(found.complete).toBe(true);
    expect(found.procedures.map((procedure) => procedure.name)).toEqual(["Helper"]);
    expect(found.unsupportedExecutables).toMatchObject([{
      kind: "trigger",
      name: "OnRun",
      startLine: 3,
      endLine: 6,
    }]);
  });

  test("reports object code lines outside every procedure and trigger as unattributed", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-unattributed-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "17.0" }));
    writeFileSync(join(project, "Cust.Table.al"), [
      "table 50100 MyCust",                    // 1
      "{",                                     // 2
      "    // a comment",                      // 3
      "",                                      // 4
      "    fields",                            // 5
      "    {",                                 // 6
      "        field(1; Name; Text[50]) { }",  // 7
      "    }",                                 // 8
      "",                                      // 9
      "    procedure Helper()",                // 10
      "    begin",                             // 11
      "        Message('x');",                 // 12
      "    end;",                              // 13
      "}",                                     // 14
    ].join("\n"));

    const found = await discoverAlProcedureIdentities(project, ["Cust.Table.al"]);

    expect(found.unattributedCode).toMatchObject([{
      relativeFile: "Cust.Table.al",
      objectId: 50100,
      objectName: "MyCust",
    }]);
    // Punctuation-only lines (braces, stray parentheses) cannot change behaviour on their own.
    expect(found.unattributedCode[0]?.lines).toEqual([1, 5, 7]);
  });

  test("refuses discovery when the project has no app.json to pin the runtime", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-no-manifest-"));
    writeFileSync(join(project, "Worker.Codeunit.al"), "codeunit 50100 Worker\n{\n}\n");

    await expect(discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"])).rejects.toThrow(/app\.json/);
  });

  test("refuses discovery when app.json does not declare a runtime", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-no-runtime-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ name: "Missing Runtime" }));
    writeFileSync(join(project, "Worker.Codeunit.al"), "codeunit 50100 Worker\n{\n}\n");

    await expect(discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"])).rejects.toThrow(/runtime/);
  });

  test("fails closed on a comma-grouped parameter list that the AL compiler rejects", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-parameters-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "17.0" }));
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      "codeunit 50100 Worker",
      "{",
      "    procedure Work(First, Second: Integer)",
      "    begin",
      "    end;",
      "}",
    ].join("\n"));

    const found = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);

    expect(found.complete).toBe(false);
    expect(found.warnings.join(" ")).toContain("parameter");
    expect(found.procedures[0]?.methodId).toBeNull();
  });

  test("reports file-level code outside every AL object as unattributed", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-unattributed-file-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "17.0" }));
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      "namespace My.App;",       // 1
      "using Other.App;",        // 2
      "",                        // 3
      "codeunit 50100 Worker",   // 4
      "{",                       // 5
      "    procedure Helper()",  // 6
      "    begin",               // 7
      "    end;",                // 8
      "}",                       // 9
    ].join("\n"));

    const found = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);

    expect(found.unattributedCode.map((entry) => [entry.objectId, entry.lines])).toEqual([
      [null, [1, 2]],
      [50100, [4]],
    ]);
  });

  test("reports semantic preprocessor directives outside method spans as unattributed", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-unattributed-directives-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "17.0" }));
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      "#define FEATURE",          // 1
      "#if FEATURE",             // 2
      "codeunit 50100 Worker",   // 3
      "{",                       // 4
      "    procedure Helper()",  // 5
      "    begin",               // 6
      "    end;",                // 7
      "}",                       // 8
      "#endif",                  // 9
    ].join("\n"));

    const found = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);

    expect(found.complete).toBe(true);
    expect(found.unattributedCode.map((entry) => [entry.objectId, entry.lines])).toEqual([
      [null, [1, 2, 9]],
      [50100, [3]],
    ]);
  });

  test("keeps semantic preprocessor directives inside a procedure attributed to that procedure", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-method-directives-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "17.0" }));
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      "codeunit 50100 Worker",
      "{",
      "    procedure Helper()",
      "    begin",
      "#if FEATURE",
      "        Message('feature');",
      "#endif",
      "    end;",
      "}",
    ].join("\n"));

    const found = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);

    expect(found.complete).toBe(true);
    expect(found.procedures[0]).toMatchObject({ name: "Helper", startLine: 3, endLine: 8 });
    expect(found.unattributedCode.flatMap((entry) => entry.lines)).not.toContain(5);
    expect(found.unattributedCode.flatMap((entry) => entry.lines)).not.toContain(7);
  });

  test("excludes declaration-only interface procedures and marks unresolved subtypes unknown", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-procedures-"));
    mkdirSync(join(project, "src"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "16.0" }));
    writeFileSync(join(project, "src", "Types.al"), [
      "interface IFoo",
      "{",
      "    procedure DeclaredOnly();",
      "}",
      "codeunit 50121 Runner",
      "{",
      '    procedure UsesMissing(Customer: Record "Missing Table")',
      "    begin",
      "    end;",
      "    procedure UsesArray(Values: array[2] of Integer)",
      "    begin",
      "    end;",
      "    [EventSubscriber(ObjectType::Codeunit, Codeunit::Runner, 'Example', '', false, false)]",
      '    local procedure HandlesMissing(var Customer: Record "Missing Table")',
      "    begin",
      "    end;",
      "    procedure Overload(Value: Integer)",
      "    begin",
      "    end;",
      "    procedure Overload(Value: Text)",
      "    begin",
      "    end;",
      "}",
    ].join("\n"));
    const found = await discoverAlProcedureIdentities(project, ["src/Types.al"]);
    expect(found.procedures).toHaveLength(5);
    expect(found.procedures[0]).toMatchObject({ name: "UsesMissing", methodId: null });
    expect(found.procedures[0]?.identityWarning).toContain("Missing Table");
    expect(found.procedures[1]).toMatchObject({ name: "UsesArray", methodId: null });
    expect(found.procedures[1]?.identityWarning).toContain("array parameter");
    expect(found.procedures[2]).toMatchObject({ name: "HandlesMissing", methodId: 494526371 });
    expect(found.procedures[2]?.signature.eventLike).toBe(true);
    expect(found.procedures[3]?.name).toBe("Overload");
    expect(found.procedures[4]?.name).toBe("Overload");
    expect(found.procedures[3]?.methodId).not.toBe(found.procedures[4]?.methodId);
  });

  test("recognizes valid unnumbered interfaces while excluding their declaration-only methods", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-procedures-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "16.0" }));
    writeFileSync(join(project, "Interfaces.al"), [
      "namespace Demo.Contracts;",
      "interface IFoo",
      "{",
      "    procedure DeclaredOnly();",
      "}",
      "codeunit 50100 Worker",
      "{",
      "    procedure UsesInterface(Value: Interface IFoo)",
      "    begin",
      "    end;",
      "}",
    ].join("\n"));
    const found = await discoverAlProcedureIdentities(project, ["Interfaces.al"]);
    expect(found.complete).toBe(true);
    expect(found.procedures).toHaveLength(1);
    expect(found.procedures[0]).toMatchObject({ name: "UsesInterface" });
    expect(found.procedures[0]?.signature.parameters[0]?.type).toMatchObject({
      subtypeName: "IFoo",
      subtypeId: 0,
    });
    expect(found.procedures[0]?.methodId).toBeNumber();
  });

  test("resolves dependency subtypes from a preambled app package and reuses the package cache", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-procedures-"));
    const packages = join(project, ".alpackages");
    mkdirSync(packages);
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "17.0" }));
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      "codeunit 50100 Worker",
      "{",
      "    procedure ReadCustomer(Customer: Record Customer)",
      "    begin",
      "    end;",
      "}",
    ].join("\n"));
    const app = join(packages, "dependency.app");
    writeFileSync(app, symbolPackage({ Tables: [{ Id: 18, Name: "Customer" }] }));

    const cache = new AlProcedureDiscoveryCache();
    const first = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"], cache);
    expect(first.warnings).toEqual([]);
    expect(first.procedures[0]).toMatchObject({ name: "ReadCustomer" });
    expect(first.procedures[0]?.methodId).toBeNumber();
    expect(cache.packages.size).toBe(1);

    const metadata = statSync(app);
    writeFileSync(app, Buffer.alloc(metadata.size));
    const corruptedMetadata = statSync(app);
    const cachedPackage = cache.packages.get(app)!;
    cache.packages.set(app, {
      ...cachedPackage,
      mtimeMs: corruptedMetadata.mtimeMs,
      size: corruptedMetadata.size,
    });
    const cached = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"], cache);
    expect(cached.warnings).toEqual([]);
    expect(cached.procedures[0]?.methodId).toBe(first.procedures[0]?.methodId);

    const uncached = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);
    expect(uncached.warnings).toHaveLength(1);
    expect(uncached.procedures[0]).toMatchObject({ methodId: null });
  });

  test("does not treat a quoted keyword identifier as procedure control flow", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-procedures-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "16.0" }));
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      "codeunit 50100 Worker",
      "{",
      "    procedure UsesQuotedKeyword()",
      "    var",
      '        "end": Integer;',
      "    begin",
      '        "end" := 1;',
      '        "end" += 1;',
      "    end;",
      "}",
    ].join("\n"));
    const found = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);
    expect(found.complete).toBe(true);
    expect(found.warnings).toEqual([]);
    expect(found.procedures[0]).toMatchObject({ name: "UsesQuotedKeyword", startLine: 3, endLine: 9 });
  });

  test("evaluates app.json preprocessor symbols and excludes inactive procedures", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-procedures-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "16.0", preprocessorSymbols: ["ACTIVE"] }));
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      "#define LOCAL_ACTIVE",
      "codeunit 50100 Worker",
      "{",
      "#if ACTIVE and LOCAL_ACTIVE",
      "    procedure Active()",
      "    begin",
      "    end;",
      "#else",
      "    procedure Inactive()",
      "    begin",
      "    end;",
      "#endif",
      "}",
    ].join("\n"));
    const found = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);
    expect(found.complete).toBe(true);
    expect(found.procedures.map((procedure) => procedure.name)).toEqual(["Active"]);
    expect(found.procedures[0]).toMatchObject({ startLine: 5, endLine: 7 });
  });

  test("fails discovery closed for an unsupported preprocessor expression", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-procedures-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "16.0", preprocessorSymbols: ["ACTIVE"] }));
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      "codeunit 50100 Worker",
      "{",
      "#if ACTIVE = TRUE",
      "    procedure Conditional()",
      "    begin",
      "    end;",
      "#endif",
      "}",
    ].join("\n"));
    const found = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);
    expect(found.complete).toBe(false);
    expect(found.warnings.join(" ")).toContain("unsupported #if expression");
  });

  test("resolves an explicitly qualified dependency subtype without falling back to a local name collision", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-procedures-"));
    mkdirSync(join(project, ".alpackages"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "17.0" }));
    writeFileSync(join(project, "Setup.Table.al"), [
      "namespace Local.App;",
      "table 50140 Setup",
      "{",
      "}",
    ].join("\n"));
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      "namespace Local.App;",
      "codeunit 50100 Worker",
      "{",
      "    procedure ReadExternal(Value: Record Other.App.Setup)",
      "    begin",
      "    end;",
      "}",
    ].join("\n"));
    writeFileSync(
      join(project, ".alpackages", "dependency.app"),
      symbolPackage({
        Namespaces: [{ Name: "Other", Namespaces: [{ Name: "App", Tables: [{ Id: 18, Name: "Setup" }] }] }],
      }),
    );
    const found = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);
    expect(found.complete).toBe(true);
    expect(found.procedures[0]?.signature.parameters[0]?.type).toMatchObject({
      subtypeName: "Setup",
      subtypeId: 18,
    });
    expect(found.procedures[0]?.methodId).toBeNumber();
  });

  test("applies the compiler's reserved system-codeunit method-id adjustment", () => {
    const raw = calculateProcedureMethodId("SystemWork2", { navTypeKind: 0, symbolKind: 2 }, [], 17).methodId!;
    const adjusted = calculateProcedureMethodId(
      "SystemWork2",
      { navTypeKind: 0, symbolKind: 2 },
      [],
      17,
      false,
      { objectType: 5, objectId: 2_000_000_001 },
    ).methodId!;
    expect(raw).toBe(-816293482);
    expect(adjusted).toBe(816293482);
    expect(adjusted).toBe(Math.abs(raw) % 1_250_000_000);
    expect(adjusted).toBeGreaterThanOrEqual(0);
    expect(adjusted).toBeLessThan(1_250_000_000);
  });

  test("marks an unparseable changed procedure incomplete instead of silently omitting it", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-procedures-"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "16.0" }));
    writeFileSync(join(project, "Worker.Codeunit.al"), [
      "codeunit 50100 Worker",
      "{",
      "    procedure Broken(Value: Integer",
      "    begin",
      "    end;",
      "}",
    ].join("\n"));
    const found = await discoverAlProcedureIdentities(project, ["Worker.Codeunit.al"]);
    expect(found.complete).toBe(false);
    expect(found.procedures).toEqual([]);
    expect(found.warnings.join(" ")).toContain("unable to parse procedure 'Broken' parameter list");
  });

  test("reports an unreadable AL project as a typed configuration error", async () => {
    const missing = join(tmpdir(), `bcmcp-missing-${Date.now()}-${Math.random()}`);
    const error = await discoverAlProcedureIdentities(missing, ["Missing.al"]).catch((caught) => caught);
    expect(error).toMatchObject({ code: "CONFIGURATION_ERROR", category: "configuration" });
  });
});
