# test-selection-alsem-deps fixture

A workspace over two dependencies, for selection with the al-sem engine across apps (al-sem spec
2026-10-13 §6). `tests/fixtures/alsem-deps-packages.ts` writes the dependency `.app` files at test
time; none is committed.

- `XDep` ships its source: `Dep Worker.Work` raises `Dep Events.OnWorked`, and the table `Dep Item`'s
  `OnInsert` raises it too. A workspace subscriber handles it.
- `SymLib` is symbol-only: `Sym Api.Compute` and the publisher `OnComputed`. A workspace subscriber
  handles it; its test reaches the subscriber only through SymLib's callbacks hub (`dynamic`).
- The workspace subscribes to `Dep Item`'s `OnAfterInsertEvent` (no record operation raises a
  platform event yet: `unraisedPublisher`) and extends `Dep Item` with an `OnAfterInsert` trigger
  (not routed yet: `unmodeledRecordTrigger`). Changes behind either fall back to the whole suite.

`call-graph.al-sem.jsonl` is `alsem graph` output on a copy of this folder plus those packages
(al-sem `issue-63` at `40613433`, `ALCH_DRIVER_VERSION_OVERRIDE="al-sem issue-63 (40613433)"`).
`tests/core/test-selection-alsem-deps.test.ts` replays it, and re-runs alsem live when
`BC_DEV_ALSEM` or `alsem` on PATH is available. The same shapes are al-sem's own cross-app test.
