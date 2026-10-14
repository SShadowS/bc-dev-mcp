/** Hard ceilings for snapshot debugging (zip, converter, JSON, and the per-response shaping of variables/source). */
export const SNAPSHOT_LIMITS = {
  zipBytes: 256 * 2 ** 20,
  converterMs: 120_000,
  stderrBytes: 4096,
  jsonBytes: 64 * 2 ** 20,
  points: 50,
  depth: 3,
  children: 50,
  valueChars: 500,
  variableNodes: 2000,
  sourceRadius: 5,
  sourceLineChars: 300,
  sourceEntryBytes: 2 ** 20,
} as const;
