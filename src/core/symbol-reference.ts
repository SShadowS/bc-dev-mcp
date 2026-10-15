import { extractEntry, MAX_TEXT_ENTRY_BYTES } from "./snapshot/zip";

/** Inflation cap for SymbolReference.json (Base Application is ~58 MB of JSON). */
export const DEFAULT_SYMBOL_REFERENCE_BYTES = Math.min(512 * 1024 * 1024, MAX_TEXT_ENTRY_BYTES);

/**
 * SymbolReference.json of an AL `.app` package as a plain object; null when the entry is absent.
 * Throws SyntaxError when the entry is not a JSON object; any other error means an unreadable archive.
 */
export function readSymbolReference(appBytes: Uint8Array, maxBytes: number = DEFAULT_SYMBOL_REFERENCE_BYTES): Record<string, unknown> | null {
  const entry = extractEntry(appBytes, "SymbolReference.json", maxBytes);
  if (!entry) return null;
  // WIRE: Microsoft "Agent Samples Tests" 29.0.54011.56136 SymbolReference.json is NUL-padded after
  // the JSON (16432 bytes, JSON ends at char 9020); others carry a BOM (live Cronus29 2026-10-15).
  const text = entry.toString("utf8").replace(/^﻿/, "").replace(/\0+$/, "");
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("SymbolReference.json is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}
