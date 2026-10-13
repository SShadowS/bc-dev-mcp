# alsem-risk fixture

Source for the risk-annotation tests (`tests/core/risk.test.ts`). `digest.json` is the real
output of `alsem digest . --file src/RiskOps.Codeunit.al --deterministic --out digest.json`,
recorded 2026-10-13 with al-sem 1.5.0 (al-call-hierarchy commit 2c48e56f, digest schemaVersion 1.3.0).
Regenerate it whenever `src/` changes.

| Routine | Expected risk |
| --- | --- |
| `PostOrder` | commits; writes Risk Order |
| `ResetAmount` | writes Risk Order |
| `CheckAmount` | can throw an error |
| `Double` | no digest entry (al-sem lists only routines with effects) |

al-sem 1.5.0 resolves a `--diff` hunk to a routine only when the changed line carries a call/effect
site, so bc-dev-mcp digests whole changed files (`--file`) and joins to the changed procedures itself.
