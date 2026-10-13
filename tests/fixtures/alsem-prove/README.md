# alsem-prove fixture

Tiny workspace app (ID range 50990-50999) for the break-effects enrichment (`src/core/break-effects.ts`).

`recorded/*.json` are real `alsem ... --deterministic` outputs, recorded 2026-10-13 with
**al-sem 1.5.0 (commit 2c48e56f)** from this folder (`query effects` schema 1.0.0, `prove` schema 1.2.0):

- `effects.<routine>.json`: `alsem query effects . --routine "Asp Work.<Routine>" --format json` (`post` resolved with one Insert, `validate` resolved with none, `overloaded` ambiguous, `nope` unmatched).
- `prove.<routine>.<question>.json`: `alsem prove . <stableId from effects> <question>`.

Regenerate whenever the source changes. `prove` only accepts a bare name or stable id, so the code resolves via `query effects` first.
