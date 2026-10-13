# record-writes fixture

A one-table AL workspace for the al-sem static writer cross-check (`src/core/alsem-writes.ts`,
`tests/core/alsem-writes.test.ts`). Table `RW Ledger` (50170) is written by codeunit `RW Ledger Writer`
(50171): direct Insert/Modify/DeleteAll/Rename, a temporary-record Insert, a read-only routine, a
routine that writes through a helper, and a `RecordRef.Insert` (al-sem's unknown bucket).

`recorded/` holds real `alsem` output, recorded with al-sem 1.5.0 (master `2c48e56f`):

```
alsem query touches <this dir> --table 3c1b8a52-7d4e-4f0a-9b6e-2a5d9c7e1f43/table/50170 --format json --deterministic
alsem query touches <this dir> --table unknown   --format json --deterministic
alsem query touches <this dir> --table Nope      --format json --deterministic   # exit 2, resolution "unmatched"
alsem query effects <this dir> --routine <stableId> --format json --deterministic   # once per routine listed above
```

Re-record by running those commands; `effects.<routine>.json` is named after the routine's display name.
