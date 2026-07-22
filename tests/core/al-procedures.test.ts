import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("matches fixed method-ID vectors for public demo procedure signatures", () => {
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
      { navTypeKind: 0, symbolKind: 2 },
      [
        { isVar: false, type: { navTypeKind: 12451847, symbolKind: 2 } },
        { isVar: false, type: { navTypeKind: 12451847, symbolKind: 2 } },
      ],
      17,
    ).methodId).toBe(-463051059);
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
    expect(found.procedures[1]).toMatchObject({ name: "Published", startLine: 15, endLine: 18 });
    expect(found.procedures[1]?.methodId).toBeNumber();
    expect(found.procedures[2]).toMatchObject({ name: "NoReturnWithLocals", startLine: 20, endLine: 25 });
    expect(found.procedures[2]?.signature.returnType.navTypeKind).toBe(0);
  });

  test("excludes declaration-only interface procedures and marks unresolved subtypes unknown", async () => {
    const project = mkdtempSync(join(tmpdir(), "bcmcp-procedures-"));
    mkdirSync(join(project, "src"));
    writeFileSync(join(project, "app.json"), JSON.stringify({ runtime: "16.0" }));
    writeFileSync(join(project, "src", "Types.al"), [
      "interface 50120 IFoo",
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

  test("reports an unreadable AL project as a typed configuration error", async () => {
    const missing = join(tmpdir(), `bcmcp-missing-${Date.now()}-${Math.random()}`);
    const error = await discoverAlProcedureIdentities(missing, ["Missing.al"]).catch((caught) => caught);
    expect(error).toMatchObject({ code: "CONFIGURATION_ERROR", category: "configuration" });
  });
});
