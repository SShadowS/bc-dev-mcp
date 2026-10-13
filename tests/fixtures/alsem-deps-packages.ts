import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** CRC-32 (IEEE): al-sem's zip reader checks it, unlike app-package.ts's minimal zips. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A stored (uncompressed) zip with real CRCs. */
function storedZip(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.content);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(entry.content.length, 20);
    cd.writeUInt32LE(entry.content.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + entry.content.length;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

/*
 * The two dependencies of tests/fixtures/test-selection-alsem-deps, as `.app` packages (NAVX
 * header + zip): `XDep` ships its source (embedded `src/*.al`), `SymLib` is symbol-only. Written
 * at test time into a workspace's `.alpackages`, so no binary is committed. The same shapes as
 * al-sem's own cross-app test (tests/cli/cli_graph_export.rs, `cross_app_workspace`).
 */

export const DEP_GUID = "bbbb2222-0000-0000-0000-000000000063";
export const SYM_GUID = "cccc3333-0000-0000-0000-000000000063";

const DEP_SOURCES: Record<string, string> = {
  "src/Worker.al": [
    'codeunit 50100 "Dep Worker"',
    "{",
    "    procedure Work()",
    "    var",
    '        E: Codeunit "Dep Events";',
    "    begin",
    "        E.OnWorked();",
    "    end;",
    "}",
    "",
  ].join("\n"),
  "src/Events.al": [
    'codeunit 50101 "Dep Events"',
    "{",
    "    [IntegrationEvent(false, false)]",
    "    procedure OnWorked()",
    "    begin",
    "    end;",
    "}",
    "",
  ].join("\n"),
  "src/Item.al": [
    'table 50110 "Dep Item"',
    "{",
    "    fields",
    "    {",
    '        field(1; "No."; Code[20])',
    "        {",
    "        }",
    "    }",
    "",
    "    trigger OnInsert()",
    "    var",
    '        E: Codeunit "Dep Events";',
    "    begin",
    "        E.OnWorked();",
    "    end;",
    "}",
    "",
  ].join("\n"),
};

function appPackage(guid: string, name: string, symbols: unknown, sources: Record<string, string>): Buffer {
  const manifest = `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${guid}" Name="${name}" Publisher="probe" Version="1.0.0.0" Runtime="13.0" /></Package>`;
  const zip = storedZip([
    { name: "NavxManifest.xml", content: Buffer.from(manifest) },
    { name: "SymbolReference.json", content: Buffer.from(JSON.stringify(symbols)) },
    ...Object.entries(sources).map(([entry, text]) => ({ name: entry, content: Buffer.from(text) })),
  ]);
  return Buffer.concat([Buffer.alloc(40), zip]);
}

/** Writes both dependency packages into `<workspace>/.alpackages`. */
export function writeDependencyPackages(workspace: string): void {
  const dir = join(workspace, ".alpackages");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "probe_XDep_1.0.0.0.app"), appPackage(DEP_GUID, "XDep", {
    RuntimeVersion: "13.0",
    Codeunits: [
      { Id: 50100, Name: "Dep Worker", Methods: [{ Name: "Work", Parameters: [] }] },
      { Id: 50101, Name: "Dep Events", Methods: [] },
    ],
    AppId: DEP_GUID, Name: "XDep", Publisher: "probe", Version: "1.0.0.0",
  }, DEP_SOURCES));
  writeFileSync(join(dir, "probe_SymLib_1.0.0.0.app"), appPackage(SYM_GUID, "SymLib", {
    RuntimeVersion: "13.0",
    Codeunits: [{
      Id: 50300,
      Name: "Sym Api",
      Methods: [
        { Name: "Compute", Parameters: [] },
        { Name: "OnComputed", Parameters: [], Attributes: [{ Name: "IntegrationEvent", Arguments: [{ Value: "false" }, { Value: "false" }] }] },
      ],
    }],
    AppId: SYM_GUID, Name: "SymLib", Publisher: "probe", Version: "1.0.0.0",
  }, {}));
}
