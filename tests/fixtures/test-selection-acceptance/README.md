# test-selection acceptance fixture

The forty-codeunit live acceptance app for diff-scoped test selection (epic #17, issue #26).
ID range 50900-50949. It follows the conventions of `tests/fixtures/test-selection`.

## Shape

32 production codeunits and 8 test codeunits, with 5 `[Test]` methods each (40 tests). All tests are
pure computation and write no data.

| Module | Production codeunits | Test codeunit |
| --- | --- | --- |
| Shared | 50900 `Acc Math` (called by most modules) | none |
| Customer | 50901 Core, 50902 Rules, 50903 Validation | 50940 `Acc Customer Tests` |
| Item | 50904 Core, 50905 Rules, 50906 Validation | 50941 `Acc Item Tests` |
| Price | 50907 Core, 50908 Rules, 50909 Validation | 50942 `Acc Price Tests` |
| Discount | 50910 Core, 50911 Rules, 50912 Validation | 50943 `Acc Discount Tests` |
| Tax (interface) | 50913 `Acc Tax Core` dispatches `Acc Tax Rate` through enum 50900 `Acc Region` to 50914 DK, 50915 DE, 50916 Exempt | 50944 `Acc Tax Tests` |
| Shipping | 50917 Core, 50918 Rules, 50919 Validation | 50945 `Acc Shipping Tests` |
| Invoice (event) | 50920 `Acc Invoice Core` composes item, price, discount and tax, then raises `OnAfterInvoiceTotal`; 50921 Rules adds shipping and currency; 50922 `Acc Cash Rounding Subscriber` is reached only through the event | 50946 `Acc Invoice Tests` |
| Currency | 50929 Core, 50930 Rules (reached only from the invoice tests) | none |
| Loyalty (event + Run) | 50923 `Acc Loyalty Core` raises `OnAfterCalcPoints`, which 50924 `Acc Loyalty Bonus Subscriber` handles; 50925 Rules calls `Codeunit.Run` on 50926 `Acc Nightly Recalc` (OnRun trigger), which reports through the SingleInstance 50927 `Acc Run State` | 50947 `Acc Loyalty Tests` |
| Untested | 50928 `Acc Legacy Export` and 50931 `Acc Report Formatter`, which no test reaches | none |

## Recorded coverage map and call graph

`coverage-map.json` was recorded on 2026-10-13 against the local BC28 container (on-prem, AL
compiler 30.0, runtime 17.0) with one full run:

```
bcdev_test_run codeunits=[50940..50947] coverageMapFile=coverage-map.json coverageAgainst=HEAD
```

All 40 tests passed and the map is `complete: true`. BC attributed the event subscribers, the
interface implementations and the `Codeunit.Run` target (`Acc Nightly Recalc.OnRun` and
`ApplyDecay`) to the test that reached them. Every identity resolves to a local procedure except
the `OnRun` trigger: local discovery has no trigger identities.

`call-graph.jsonl` is `altool graph extract` + `stitch` output (AL 30.0.2863738, 2026-10-13), trimmed
the same way as the test-selection fixture's. It has 2 `Event` edges and 6 `Interface` edges, and
**no `Run` edge**. altool records `Codeunit.Run(Codeunit::"Acc Nightly Recalc")` as a `Direct` edge
to the built-in `Codeunit # Run`, so `Acc Nightly Recalc` is reachable only through coverage history.

`call-graph.al-sem.jsonl` is `alsem graph` output (schema `al-sem.callgraph` v1; al-sem branch
`issue-63` at `40613433`, release build, 2026-10-13), recorded with
`ALCH_DRIVER_VERSION_OVERRIDE="al-sem issue-63 (40613433)"` so a re-record does not churn the engine
field. 92 nodes and 94 edges: 3 `Interface` edges from `TaxAmount`, 2 `Event` edges, and the D4 chain
`RecalcNightly -Run-> Acc Nightly Recalc (object) -Trigger(lifecycle)-> OnRun -Direct-> ApplyDecay`.
No `.alpackages` here, so `meta.apps` lists the Microsoft apps as `missing`; nothing in the fixture
calls them.

## al-sem engine results (offline, 2026-10-13)

Selection only (`tests/core/test-selection-acceptance.test.ts` replays it), with the al-sem graph:

| Diff | No map: selected | reasons | uncoverable | fallback | With map | reasons |
| --- | --- | --- | --- | --- | --- | --- |
| D1 discount | 9 / 40 | direct | - | no | 9 / 40 | direct + coverage-history |
| D2 interface | 10 / 40 | event | - | no | 10 / 40 | coverage-history + event, event |
| D3 event | 5 / 40 | event | - | no | 5 / 40 | coverage-history + event |
| D4 Codeunit.Run | 1 / 40 (`NightlyRecalcDecays`) | event | - | no | 1 / 40 | coverage-history + event |
| D5 OnRun trigger | 1 / 40 (`NightlyRecalcDecays`) | event | - | **no** | 1 / 40 | event |
| D6 multi-file | 5 / 40 | direct | `ExportLine` | no | 5 / 40 | direct + coverage-history |
| D7 app.json only | all 40 | - | - | yes (non-AL file) | all 40 | - |

Compared with altool: D4 no longer needs the coverage map, D5 no longer falls back, and
`ExportLine` being `uncoverable` is now a statement about the graph (no test can reach it under
al-sem's stated assumptions), not only an absence of evidence. The live rerun is below.

## Live al-sem acceptance (2026-10-13, Cronus28)

Same procedure as the altool run below, through the MCP tools with `BC_DEV_CALLGRAPH_ENGINE=al-sem`
(`alsem graph` engine 1.5.0, al-sem master `4a2abdbb`; alc 30.0.2863738). For each planted bug the
working tree was edited (uncommitted), `bcdev_test_select baseRef=HEAD` ran without and with
`coverageMapFile=coverage-map.json`, the buggy app was compiled and published, and both the full suite
and the selected shards ran with `coverageAgainst=HEAD changesDeployed=true`. "Coverage identical"
compares the changed objects' procedures (by BC method identity, `OnRun` included) covered by each run.

| Diff | Planted bug | No map: selected | reasons | With map: selected | reasons | uncoverable | Failed (full) | Failed (selected) | Missed | Coverage identical |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 discount | `ApplyDiscount` result `+ 1` | 9 / 40 | direct | 9 / 40 | direct + coverage-history | - | 8 | 8 | 0 | yes |
| D2 interface | `Acc Tax DE.RatePct` 19 -> 16 | 10 / 40 | event | 10 / 40 | coverage-history + event, event | - | 2 | 2 | 0 | yes |
| D3 event | `RoundToNickel` precision 0.05 -> 0.1 | 5 / 40 | event | 5 / 40 | coverage-history + event | - | 1 | 1 | 0 | yes |
| D4 Codeunit.Run | `ApplyDecay` 90 -> 80 | 1 / 40 | event | 1 / 40 | coverage-history + event | - | 1 | 1 | 0 | yes |
| D5 OnRun trigger | `OnRun` `PointsFor(2500)` -> 2400 | 1 / 40 | event | 1 / 40 | event | - | 1 | 1 | 0 | yes (`OnRun` covered in both) |
| D6 multi-file | threshold 500 -> 580, `ExportLine` `;` -> `\|` | 5 / 40 | direct | 5 / 40 | direct + coverage-history | `ExportLine` | 1 | 1 | 0 | yes (`ExportLine` uncovered in both) |
| D7 app.json only | version 1.0.0.0 -> 1.0.0.1 | fallbackToAll, 40 / 40 (engine `none`) | - | fallbackToAll, 40 / 40 | - | - | 0 | 0 | n/a | yes |

The failing tests per diff are exactly `liveDiffs` in `tests/core/test-selection-acceptance.test.ts`.
No fallback except D7, and the map never changed a selection (it only added `coverage-history` to the
reasons). D1-D6 ran 31 of 240 test executions (13%) and missed nothing; D5, which fell back to all 40
with altool, now runs 1. A first D6 attempt with threshold 400 failed no test at all (the invoice
order is 570, above both thresholds), so the bug was replanted at 580.

With BC28 symbols in `.alpackages` (removed afterwards), `alsem graph` reports `meta.apps` source
`embedded` for Base Application, Business Foundation, System and System Application and `symbolOnly`
for Application (versions 28.0.46665.50383 / System 28.0.50283.0) instead of `missing`; nodes go from
92 to 180, edges stay 94, and the D1-D6 selections (with and without the map) are identical.

## Live acceptance results (2026-10-13, Cronus28)

For each planted bug: edit the working tree, run `bcdev_test_select baseRef=HEAD
coverageMapFile=coverage-map.json`, compile and publish the modified app, then run both the full
suite and the selected shards with `coverageAgainst=HEAD changesDeployed=true`. "Failed (full)" is
what the whole suite caught. "Coverage identical" compares the changed procedures each run covered.

| Diff | Changed procedure | Selected | Reason | Failed (full) | Missed | Coverage identical |
| --- | --- | --- | --- | --- | --- | --- |
| D1 discount | `Acc Discount Rules.ApplyDiscount` | 9 / 40 | direct | 8 | 0 | yes |
| D2 interface | `Acc Tax DE.RatePct` | 10 / 40 | coverage-history + event | 2 | 0 | yes |
| D3 event | `Acc Cash Rounding Subscriber.RoundToNickel` | 5 / 40 | coverage-history + event | 1 | 0 | yes |
| D4 Codeunit.Run | `Acc Nightly Recalc.ApplyDecay` | 1 / 40 | coverage-history | 1 | 0 | yes |
| D5 OnRun trigger | `Acc Nightly Recalc.OnRun` | fallbackToAll, 40 / 40 | none | 1 | 0 | yes |
| D6 multi-file | `Acc Shipping Rules.FreeShippingThreshold` + `Acc Legacy Export.ExportLine` | 5 / 40, ExportLine `uncoverable` | direct | 1 | 0 | yes (ExportLine uncovered in both) |
| D7 app.json only | none | fallbackToAll, 40 / 40 | none | not run | n/a | n/a |

Across the five non-fallback diffs, selection ran 30 of 200 test executions (15%) and missed no
test the full run failed. This meets the epic's bar: identical changed-procedure coverage while
executing fewer than 25% of the test methods.

What this shows:

- **Interface dispatch over-selects statically.** For D2 the graph links `Acc Tax Core.TaxAmount` to
  all three implementations, so every caller of `TaxAmount` (5 tax and 5 invoice tests) is selected.
  Only 2 tests reach the DE implementation.
- **Codeunit.Run depends on history.** D4 was selected only because of the coverage map. Without a
  map, `ApplyDecay` is reported `uncoverable` (see `tests/core/test-selection-acceptance.test.ts`).
- **Trigger changes fall back.** D5 sets `fallbackToAll` because the changed `OnRun` has no local
  procedure identity, even though the map holds its BC identity.

Every selection carried the expected stale-map warning, because the map was committed after the
merge base it records.

## Rebuild

Copy BC28 symbols into `.alpackages/` (git-ignored, for example from `demos/hello-bug/.alpackages`),
compile with `alc.exe /project:<this dir> /packagecachepath:<this dir>/.alpackages /out:<scratch>.app`,
publish with `bcdev_app_publish`, then rerun the command above. Do not commit the `.app` or
`.alpackages`. Afterwards, uninstall with `bcdev_app_uninstall deleteData=true` and run
`bcdev_app_unpublish`. Regenerate `call-graph.jsonl` and update the counts in
`tests/core/test-selection-acceptance.test.ts` whenever the source changes.
