import { deflateRawSync } from "node:zlib";

interface ZipEntry {
  name: string;
  content: Buffer;
}

export interface AppPackageFixture {
  publisher: string;
  name: string;
  appId: string;
  version: string;
  extra?: string;
  bom?: boolean;
  preamble?: boolean;
  /** Extra top-level SymbolReference.json members (Codeunits, Namespaces, ...), merged over the defaults. */
  symbols?: Record<string, unknown>;
  /** Trailing NUL bytes after the JSON, as in Microsoft's BC29 "Agent Samples Tests" package. */
  nulPadding?: number;
  /** NavxManifest.xml <Dependency> elements. */
  dependencies?: Array<{ id: string; name: string; publisher: string; minVersion: string }>;
  propagateDependencies?: boolean;
}

function xmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** NavxManifest.xml in the shape BC29 packages carry (live Cronus29 2026-10-15). */
export function buildNavxManifest(fixture: AppPackageFixture): string {
  const propagate = fixture.propagateDependencies ? ' PropagateDependencies="True"' : "";
  const deps = (fixture.dependencies ?? [])
    .map((d) => `    <Dependency Id="${d.id}" Name="${xmlAttr(d.name)}" Publisher="${xmlAttr(d.publisher)}" MinVersion="${d.minVersion}" CompatibilityId="0.0.0.0" />`)
    .join("\n");
  return `<Package xmlns="http://schemas.microsoft.com/navx/2015/manifest">
  <App Id="${fixture.appId}" Name="${xmlAttr(fixture.name)}" Publisher="${xmlAttr(fixture.publisher)}" Brief="" Version="${fixture.version}" CompatibilityId="0.0.0.0"${propagate} />
  <Dependencies>
${deps}
  </Dependencies>
  <InternalsVisibleTo>
    <Module Id="00000000-0000-0000-0000-0000000000ff" Name="Not A Dependency" Publisher="Microsoft" />
  </InternalsVisibleTo>
</Package>`;
}

function buildZip(entries: ZipEntry[], method: 0 | 8): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = method === 8 ? deflateRawSync(entry.content) : entry.content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(entry.content.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + compressed.length;
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

export function buildStoredZip(entries: ZipEntry[]): Buffer {
  return buildZip(entries, 0);
}

export function buildDeflatedZip(entries: ZipEntry[]): Buffer {
  return buildZip(entries, 8);
}

export function buildAppPackage(fixture: AppPackageFixture): Buffer {
  const symbols = {
    RuntimeVersion: "17.0",
    Publisher: fixture.publisher,
    Name: fixture.name,
    AppId: fixture.appId,
    Version: fixture.version,
    Codeunits: [],
    Extra: fixture.extra ?? "",
    ...fixture.symbols,
  };
  const prefix = fixture.bom === false ? "" : "\uFEFF";
  const zip = buildStoredZip([
    { name: "NavxManifest.xml", content: Buffer.from(buildNavxManifest(fixture)) },
    { name: "SymbolReference.json", content: Buffer.from(`${prefix}${JSON.stringify(symbols)}${"\u0000".repeat(fixture.nulPadding ?? 0)}`) },
  ]);
  return fixture.preamble === false
    ? zip
    : Buffer.concat([Buffer.from("NAVX"), Buffer.alloc(36), zip]);
}
