import { inflateRawSync } from "node:zlib";

// Minimal ZIP reader: central-directory scan + extract-by-name. node:zlib only, no dependency.
// Supports STORE (0) and DEFLATE (8), the only methods BC's snapshot archive uses.
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEocd(buf: Buffer): number {
  // EOCD is at the end; scan backward over the (usually empty) comment.
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("not a zip archive (no end-of-central-directory record)");
}

function readCentralDirectory(buf: Buffer): CentralEntry[] {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const storedCentralOffset = buf.readUInt32LE(eocd + 16);
  const actualCentralOffset = eocd - centralSize;
  // WIRE: AL compiler .app packages (AL Development Tools 17.0.34.45391) carry a NAVX
  // preamble before their ZIP payload. ZIP offsets remain relative to that payload, so derive
  // and retain the preamble length from the actual end-of-central-directory position.
  const archiveBase = actualCentralOffset - storedCentralOffset;
  let off = actualCentralOffset;
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CD_SIG) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = archiveBase + buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function listEntryNames(zip: Uint8Array): string[] {
  return readCentralDirectory(Buffer.from(zip)).map((e) => e.name);
}

export function extractEntry(zip: Uint8Array, name: string, maxOutputLength?: number): Buffer | null {
  if (maxOutputLength !== undefined && (!Number.isSafeInteger(maxOutputLength) || maxOutputLength <= 0)) {
    throw new RangeError("zip entry output limit must be a positive safe integer");
  }
  const buf = Buffer.from(zip);
  const entry = readCentralDirectory(buf).find((e) => e.name === name);
  if (!entry) return null;
  if (maxOutputLength !== undefined && entry.uncompressedSize > maxOutputLength) {
    throw new Error(`zip entry exceeds the ${maxOutputLength}-byte output limit`);
  }
  const lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== LOCAL_SIG) throw new Error("corrupt zip local header");
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  if (dataStart + entry.compressedSize > buf.length) {
    throw new Error("corrupt zip: entry data exceeds archive"); // subarray would silently truncate
  }
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) {
    if (maxOutputLength !== undefined && data.length > maxOutputLength) {
      throw new Error(`zip entry exceeds the ${maxOutputLength}-byte output limit`);
    }
    return Buffer.from(data); // STORE
  }
  if (entry.method === 8) {
    // The central-directory size is untrusted. maxOutputLength remains the authoritative
    // allocation bound when a hostile archive understates its uncompressed size.
    return maxOutputLength === undefined
      ? inflateRawSync(data)
      : inflateRawSync(data, { maxOutputLength });
  }
  throw new Error(`unsupported zip compression method ${entry.method}`);
}
