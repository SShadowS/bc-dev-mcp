# test-selection fixture

Fixture app for diff-scoped test selection (epic #17, issue #25). ID range 50980-50989.

| Object | Role |
| --- | --- |
| codeunit 50980 `Sel Pricing` | Production code. `FinalizeAmount` raises the `OnAfterFinalizeAmount` integration event; `ShippingCost` dispatches through the `Sel Shipping Rate` interface; `LegacyTaxAmount` is reached by no test (the "uncoverable" procedure). |
| codeunit 50981 `Sel Surcharge Subscriber` | Subscribes to `OnAfterFinalizeAmount`. No test names it; it is reachable only through the event. |
| interface `Sel Shipping Rate`, enum 50980 `Sel Carrier` | `Standard` -> codeunit 50982 `Sel Standard Rate`, `Express` -> codeunit 50983 `Sel Express Rate`. `Sel Express Rate` is reachable only through the interface dispatch. |
| codeunits 50985-50987 | 3 test codeunits, 12 `[Test]` methods (`Sel Pricing Tests`, `Sel Event Tests`, `Sel Shipping Tests`). |

## Recorded coverage map

`coverage-map.json` was recorded on 2026-10-13 against the local BC28 container (on-prem,
AL compiler 30.0, runtime 17.0) with one full run:

```
bcdev_test_run codeunits=[50985, 50986, 50987] coverageMapFile=coverage-map.json coverageAgainst=HEAD
```

All 12 tests passed and the map is `complete: true`. Its `mergeBase` is the commit that added
the fixture source. The app was uninstalled and unpublished afterwards. Every procedure
identity in the map resolves to a local procedure (`tests/core/test-selection-fixture.test.ts`
checks this).

### Edge attribution

BC's procedure coverage attributed **both** indirect edges to the calling test:

- **Event:** the three `FinalizeAmount` tests list `Sel Surcharge Subscriber.AddSurchargeOnFinalize`
  and its callee `SurchargeFor`. The empty publisher `Sel Pricing.OnAfterFinalizeAmount` is
  listed as well. `CalcLineAmountRaisesNoEvent` lists neither.
- **Interface:** `ShippingCostExpressDispatch` and `ShippingCostExpressZeroWeight` list
  `Sel Express Rate.Rate`; `ShippingCostStandardDispatch` lists `Sel Standard Rate.Rate`.
  Coverage reports the concrete implementation; the interface itself has no entry.
- **Not attributed:** `Sel Pricing.LegacyTaxAmount` appears under no test, as intended.

The two `Rate` implementations share the same methodId (-1779255304) because the methodId is
derived from the signature; only the objectId tells them apart.

## Rebuild

Copy BC28 symbols into `.alpackages/` (git-ignored, for example from `demos/hello-bug/.alpackages`),
compile with `alc.exe /project:<this dir> /packagecachepath:<this dir>/.alpackages /out:<scratch>.app`,
publish with `bcdev_app_publish`, then rerun the command above. Do not commit the `.app` or `.alpackages`.

## Recorded call graph

`call-graph.jsonl` is `altool graph extract` + `stitch` output (AL 30.0.2863738, 2026-10-13) for
this folder, trimmed to node `id/kind/objectName/objectId/memberName/line` and edge
`caller/callee/kind/confidence` (absolute `sourcePath` dropped). `tests/core/test-selection.test.ts`
runs the selection core against it and `coverage-map.json`. Regenerate it whenever the source changes.
