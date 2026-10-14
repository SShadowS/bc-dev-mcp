import { describe, expect, test } from "bun:test";
import { readSymbolReference } from "../../src/core/symbol-reference";
import { buildAppPackage, buildStoredZip } from "../fixtures/app-package";

const identity = { publisher: "Microsoft", name: "Agent Samples Tests", appId: "7a1c0001-0000-4000-8000-0000000000b1", version: "29.0.0.0" };

describe("readSymbolReference", () => {
  test("parses a BOM-prefixed, NUL-padded SymbolReference.json", () => {
    const symbols = readSymbolReference(buildAppPackage({ ...identity, nulPadding: 7412 }));
    expect(symbols).toMatchObject({ Name: "Agent Samples Tests", Publisher: "Microsoft" });
  });

  test("returns null when the package has no SymbolReference.json", () => {
    expect(readSymbolReference(buildStoredZip([{ name: "NavxManifest.xml", content: Buffer.from("<Package />") }]))).toBeNull();
  });

  test("throws on bytes that are not a zip", () => {
    expect(() => readSymbolReference(Buffer.from("not a zip"))).toThrow();
  });

  test("throws when the JSON is not an object", () => {
    expect(() => readSymbolReference(buildStoredZip([{ name: "SymbolReference.json", content: Buffer.from("[1]") }]))).toThrow();
    expect(() => readSymbolReference(buildStoredZip([{ name: "SymbolReference.json", content: Buffer.from("{oops") }]))).toThrow();
  });
});
