# Order-pollution demo (epic #15, c13.8)

`demos/order-pollution/` is a fixture for order-dependence (polluter/victim) detection:
one test codeunit, **50161 "Order Pollution Tests"**, with eight methods and two genuine
polluter/victim pairs, plus one helper table, **50160 "Order Pollution Flag"**. ID range
50160-50169. Built with alc against BC28 symbols and run live on Cronus28 (2026-10-13,
`scripts/e2e.md` #15): every outcome below was observed.

`tests/fakes/order-pollution-hub.ts` replays the TestRunnerHub wire behaviour for this app,
and `tests/core/order-pollution-fake.test.ts` pins the outcomes below, plus the planner +
analysis + bisect chain end to end. Failure texts match the live run (minus the
`AL Callstack:` tail).

## Where pollution can happen in BC

From #33 (`scripts/e2e.md`, live BC28):

- Every `RunTests` group is rolled back when it completes, even after explicit `Commit()`.
  Nothing a test commits reaches the next group or the next `Initialize`.
- Inside one group, methods run in **declaration order**; the `testMethods[]` order is
  ignored. There is no rollback between methods of a group, so an `AutoCommit` method's
  committed rows are visible to every method declared below it.
- A codeunit can run only once per `Initialize`; a second `RunTests` for it runs its methods
  and then kills the hub.

From #15 (live BC28): the rollback also covers IsolatedStorage and newly created number
sequences, but not non-transactional state. All groups of one `Initialize` share one session,
so SingleInstance codeunit globals reach later groups; `NumberSequence.Next` increments and
server files persist across groups and `Initialize`s.

So committed-row pollution (what this demo has) is only possible **within one group**, from a
committing method declared **above** the victim. "Order" for this codeunit therefore means
which methods share a group, not the sequence in `testMethods[]`. That is why order mode
plans one group per codeunit in one `Initialize`, calls a method an od-victim when it passes
alone but fails in its group, and bisects over the methods declared above it. Reversing or
shuffling only moves codeunit groups, which matters for session and global state only.

## The eight methods (declaration order)

A `[Test]` method with no `[TransactionModel]` attribute defaults to **AutoCommit** (BC docs;
`discoverTests` reports it that way). So every non-polluter below carries an explicit
`[TransactionModel(TransactionModel::AutoRollback)]`; without it, 6 would commit `ODPOLL-C6`
and become a polluter, and the victims' own writes would persist for the rest of the group.

| # | Method | TransactionModel | Role |
|---|--------|------------------|------|
| 1 | `PolluterCommitsCustomer` | AutoCommit | Inserts Customer `ODPOLL-C1`, `Commit()` |
| 2 | `IndependentArithmetic` | AutoRollback | Clean |
| 3 | `VictimInsertsSameCustomer` | AutoRollback | Inserts Customer `ODPOLL-C1`, checks the return value; **od-victim of 1** |
| 4 | `IndependentCompanyName` | AutoRollback | Clean |
| 5 | `PolluterCommitsFlag` | AutoCommit | Inserts flag `DEMO`, `Commit()` |
| 6 | `IndependentRolledBackWrite` | AutoRollback | Writes Customer `ODPOLL-C6`, rolled back at method end; writes but does **not** pollute |
| 7 | `VictimExpectsNoFlag` | AutoRollback | Asserts the flag table is empty; **od-victim of 5** |
| 8 | `IndependentLast` | AutoRollback | Clean |

## Expected outcomes

| Selection in one group | Fails |
|------------------------|-------|
| all 8 | 3 (`Customer ODPOLL-C1 already exists`), 7 (`found 1`) |
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

Why 3 checks `Insert()`'s return value: a bare `Customer.Insert()` is buffered (bulk insert)
until something forces a flush. In an AutoRollback method nothing does, so the rollback
discards the buffered row and the duplicate key never raises. The first live run showed exactly
that: 3 passed after 1 although `Customer.Get('ODPOLL-C1')` saw the committed row. Real
suites have the same blind spot, so a victim that only does an unchecked insert can hide.

Live order mode (isolation + recorded + reversed + 3 shuffle seeds, then bisect) on all 8
reports 2 od-victims, polluters 1 and 5; on {2, 4, 6, 8} it reports none (30 `Initialize`s,
about 3 s on Cronus28).

Through the MCP tool (with `project` pointing at an AL project that contains codeunit 50161):

```json
{ "codeunits": [{ "id": 50161 }], "mode": "order", "seeds": [1, 2, 3], "pollutionTableId": 18 }
```

`tests/mcp/test-order-tool.test.ts` runs that call against the FakeHub script.

## Building

```bash
alc.exe /project:demos/order-pollution /packagecachepath:<BC28 symbols> /out:<somewhere outside git>
```

Symbols come from the server (same as `demos/hello-bug`); `.alpackages/` and `*.app` are
git-ignored.
