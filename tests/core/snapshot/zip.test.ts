// tests/core/snapshot/zip.test.ts
import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { extractEntry, listEntryNames } from "../../../src/core/snapshot/zip";

interface EntrySpec {
  name: string;
  content: Buffer;
  method?: number; // 0 = STORE, 8 = DEFLATE (default); anything else emitted raw for negative tests
}

// Build a minimal but valid multi-entry ZIP. Local sections are laid out in order,
// so the second+ entries land at a nonzero local-header offset (exercises CD lookup).
function buildZip(specs: EntrySpec[]): Uint8Array {
  const localSections: Buffer[] = [];
  const cdRecords: Buffer[] = [];
  let localCursor = 0;

  for (const spec of specs) {
    const method = spec.method ?? 8;
    const nameBuf = Buffer.from(spec.name, "utf8");
    const comp = method === 8 ? deflateRawSync(spec.content) : spec.content;
    const crc = crc32(spec.content);
    const offset = localCursor;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8); // compression method
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(spec.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localHeader = Buffer.concat([local, nameBuf, comp]);
    localSections.push(localHeader);
    localCursor += localHeader.length;

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(spec.content.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42); // local header offset
    cdRecords.push(Buffer.concat([cd, nameBuf]));
  }

  const localAll = Buffer.concat(localSections);
  const cdAll = Buffer.concat(cdRecords);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(specs.length, 8); // entries this disk
  eocd.writeUInt16LE(specs.length, 10); // total entries
  eocd.writeUInt32LE(cdAll.length, 12); // cd size
  eocd.writeUInt32LE(localAll.length, 16); // cd offset
  eocd.writeUInt16LE(0, 20);

  return Uint8Array.from(Buffer.concat([localAll, cdAll, eocd]));
}

// Single-entry convenience wrapper (deflate).
function makeZip(name: string, content: Buffer): Uint8Array {
  return buildZip([{ name, content }]);
}

// Minimal CRC32 for the fixture.
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

describe("zip reader", () => {
  test("extracts a named entry from a multi-name archive", () => {
    const zip = makeZip("ctx-123.alcpuprofile", Buffer.from('{"hello":"world"}'));
    expect(listEntryNames(zip)).toEqual(["ctx-123.alcpuprofile"]);
    const out = extractEntry(zip, "ctx-123.alcpuprofile");
    expect(out).not.toBeNull();
    expect(JSON.parse(out!.toString("utf8"))).toEqual({ hello: "world" });
  });

  test("returns null for a missing entry", () => {
    const zip = makeZip("a.txt", Buffer.from("x"));
    expect(extractEntry(zip, "b.txt")).toBeNull();
  });

  test("extracts a STORE (method 0) entry byte-for-byte", () => {
    const content = Buffer.from("stored-uncompressed payload æøå", "utf8");
    const zip = buildZip([{ name: "stored.bin", content, method: 0 }]);
    const out = extractEntry(zip, "stored.bin");
    expect(out).not.toBeNull();
    expect(out!.equals(content)).toBe(true);
  });

  test("extracts entries when an application-package preamble precedes the ZIP", () => {
    const zip = Buffer.from(buildZip([{ name: "SymbolReference.json", content: Buffer.from('{"Codeunits":[]}') }]));
    const withPreamble = Buffer.concat([Buffer.alloc(40, 0x5a), zip]);
    expect(listEntryNames(withPreamble)).toEqual(["SymbolReference.json"]);
    expect(extractEntry(withPreamble, "SymbolReference.json")?.toString("utf8")).toBe('{"Codeunits":[]}');
  });

  test("throws on an unsupported compression method", () => {
    const zip = buildZip([{ name: "weird.bin", content: Buffer.from("payload"), method: 12 }]);
    expect(() => extractEntry(zip, "weird.bin")).toThrow(/unsupported zip compression method/);
  });

  test("throws instead of returning truncated data when compressedSize exceeds the archive", () => {
    const zip = buildZip([{ name: "trunc.bin", content: Buffer.from("payload"), method: 0 }]);
    const buf = Buffer.from(zip);
    // corrupt the central-directory compressedSize field (CD offset lives at EOCD+16)
    const cdOff = buf.readUInt32LE(buf.length - 22 + 16);
    buf.writeUInt32LE(0x7fffffff, cdOff + 20);
    expect(() => extractEntry(Uint8Array.from(buf), "trunc.bin")).toThrow(/corrupt zip/);
  });

  test("bounds DEFLATE output even when the archive understates its uncompressed size", () => {
    const zip = Buffer.from(buildZip([{
      name: "large.txt",
      content: Buffer.alloc(4096, 0x41),
      method: 8,
    }]));
    const cdOff = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt32LE(1, cdOff + 24);
    expect(() => extractEntry(zip, "large.txt", 128)).toThrow();
  });

  test("extracts each member of a genuine multi-entry archive by name", () => {
    const a = Buffer.from('{"which":"a"}');
    const b = Buffer.from('{"which":"b","pad":"xxxxxxxxxxxxxxxx"}');
    const zip = buildZip([
      { name: "a.alcpuprofile", content: a },
      { name: "b.alcpuprofile", content: b },
    ]);

    expect(listEntryNames(zip)).toEqual(["a.alcpuprofile", "b.alcpuprofile"]);

    const outA = extractEntry(zip, "a.alcpuprofile");
    const outB = extractEntry(zip, "b.alcpuprofile");
    expect(outA).not.toBeNull();
    expect(outB).not.toBeNull();
    // Second entry lives at a nonzero local-header offset, so this exercises the CD lookup.
    expect(JSON.parse(outA!.toString("utf8"))).toEqual({ which: "a" });
    expect(JSON.parse(outB!.toString("utf8"))).toEqual({ which: "b", pad: "xxxxxxxxxxxxxxxx" });
  });
});
