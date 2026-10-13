# Order-pollution demo (epic #15, c13.8)

`demos/order-pollution/` is a fixture for order-dependence (polluter/victim) detection:
one test codeunit, **50161 "Order Pollution Tests"**, with eight methods and two genuine
polluter/victim pairs, plus one helper table, **50160 "Order Pollution Flag"**. ID range
50160-50169. Built with alc against BC28 symbols; not yet published to a live server.

`tests/fakes/order-pollution-hub.ts` replays the expected TestRunnerHub wire behaviour for
this app, and `tests/core/order-pollution-fake.test.ts` pins the expected outcomes below.
The failure texts in the fake are expected, not live-captured.

## Where pollution can happen in BC

From #33 (`scripts/e2e.md`, live BC28):

- Every `RunTests` group is rolled back when it completes, even after explicit `Commit()`.
  Nothing a test commits reaches the next group or the next `Initialize`.
- Inside one group, methods run in **declaration order**; the `testMethods[]` order is
  ignored. There is no rollback between methods of a group, so an `AutoCommit` method's
  committed rows are visible to every method declared below it.
- A codeunit can run only once per `Initialize`; a second `RunTests` for it kills the hub.

So pollution is only possible **within one group**, from a committing method declared
**above** the victim. "Order" for this codeunit therefore means which methods share a group,
not the sequence in `testMethods[]`. Across groups and across codeunits there is none.

## The eight methods (declaration order)

A `[Test]` method with no `[TransactionModel]` attribute defaults to **AutoCommit** (BC docs;
`discoverTests` reports it that way). So every non-polluter below carries an explicit
`[TransactionModel(TransactionModel::AutoRollback)]`; without it, 6 would commit `ODPOLL-C6`
and become a polluter, and the victims' own writes would persist for the rest of the group.

| # | Method | TransactionModel | Role |
|---|--------|------------------|------|
| 1 | `PolluterCommitsCustomer` | AutoCommit | Inserts Customer `ODPOLL-C1`, `Commit()` |
| 2 | `IndependentArithmetic` | AutoRollback | Clean |
| 3 | `VictimInsertsSameCustomer` | AutoRollback | Inserts Customer `ODPOLL-C1`; **od-victim of 1** |
| 4 | `IndependentCompanyName` | AutoRollback | Clean |
| 5 | `PolluterCommitsFlag` | AutoCommit | Inserts flag `DEMO`, `Commit()` |
| 6 | `IndependentRolledBackWrite` | AutoRollback | Writes Customer `ODPOLL-C6`, rolled back at method end; writes but does **not** pollute |
| 7 | `VictimExpectsNoFlag` | AutoRollback | Asserts the flag table is empty; **od-victim of 5** |
| 8 | `IndependentLast` | AutoRollback | Clean |

## Expected outcomes

| Selection in one group | Fails |
|------------------------|-------|
| all 8 | 3 (`already exists`), 7 (`found 1`) |
| 3 alone, or 7 alone | none |
| {1, 3} | 3 |
| {5, 7} | 7 |
| {1, 7}, {5, 3} | none |
| {2, 4, 6, 8} (no-pollution fixture) | none |
| `[3, 1]` as `testMethods[]` | 3 (runs as 1, 3) |

Expected od-victims: **3** (polluter 1, write to table Customer) and **7** (polluter 5,
write to table 50160 "Order Pollution Flag"). Both pass in isolation, fail only after their
polluter in the same group, and the minimal polluter is a single method. 6 is the
"writes, but does not leak" control for write attribution: its explicit AutoRollback undoes it
(drop the attribute and it defaults to AutoCommit and leaks).

## Building

```bash
alc.exe /project:demos/order-pollution /packagecachepath:<BC28 symbols> /out:<somewhere outside git>
```

Symbols come from the server (same as `demos/hello-bug`); `.alpackages/` and `*.app` are
git-ignored.
