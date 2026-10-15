# Testing

## Repeat runs (`bcdev_test_orchestrate`)

Use `bcdev_test_orchestrate` when repeatability is the question. It claims the same singleton
test-run slot for the entire sequence, executes 2–20 ordinary TestRunnerHub runs sequentially,
retains each enriched attempt, and returns exact adjacent additions/removals for the passed and failed
sets. A method is `flaky` only with positive pass-and-fail evidence. Missing or duplicate
observations, an aborted run, or a run with no real methods forces `complete: false`; mixed
passed/skipped or failed/skipped observations are `inconsistent`, not mislabeled as flaky.
If an attempt cannot start, earlier evidence and a final aborted attempt remain in `runs[]`.
After an aborted attempt, later requested runs are left as missing rather than started while
the prior server-side run may still be active. Client cancellation is observed between attempts;
it does not cancel an active Business Central run. `tests[].method` keeps the first requested or
observed spelling, so its casing can differ from raw server rows. An all-skipped selection retains
the existing `passed` outcome convention but warns that it contains no passing execution evidence.
Overlapping codeunit/method selections are rejected, while disjoint method groups for one codeunit
remain valid. Non-rolled-back test side effects repeat on every attempt.
Orchestration intentionally does not aggregate coverage — use `bcdev_test_run` for coverage and
changed-procedure analysis.

## Order-dependent tests (`mode: "order"`)

`mode: "order"` answers "does this test fail only because of another test?". It runs every
selected method alone, then the selection in recorded order, reversed, and once per shuffle `seeds`
entry (default `[1, 2, 3]`; the same seeds replay the same orders). A method that passes alone but
fails after others is an `odVictim`; pairwise bisection (`maxProbes`, default 50) narrows it to a
single polluter, verified by a `[polluter, victim]` run. With `pollutionTableId`, one extra
debugger-bound recorded run captures writes to that table and attributes them to each polluter as
`writeObserved`, `noWriteObserved`, or `unknown` (an observed write break, not proof of commit).
Every row carries the method's `transactionModel`, and `order.runners` lists the project's
TestRunner codeunits with their TestIsolation. Business Central rolls data back after each codeunit
group even after `Commit()`, but not between methods of one codeunit, so committed rows only leak
from a method declared above the victim in the same codeunit; reversing and shuffling move whole
codeunit groups. Order mode reads declaration order from local source, so the codeunits must be in
`project`, and it caps the selection at 50 methods because each run and probe is one Initialize.
See `demos/ORDER-POLLUTION.md`.

## Coverage gaps (`coverageAgainst`)

Pass `coverageAgainst` to `bcdev_test_run` for roadmap item 5's coverage-gap analysis. The tool
resolves the ref's merge base with `HEAD`, compares that commit with the current working tree
(committed branch changes, staged and unstaged edits, plus nonignored untracked AL files), and
automatically selects procedure coverage. `coverageGaps` reports each current executable procedure
intersecting those changed lines as `covered`, `uncovered`, or `unknown`, including the exact source
span, changed ranges, compiler method ID, and covering test identities. An `uncovered` result is only
emitted when the compiler identity is exact, the caller explicitly confirms the current changes are
deployed with `changesDeployed: true`, and every requested test group returned procedure coverage
that omitted it. TestRunnerHub does not return an artifact or source hash, so
`coverageGaps.deployment` distinguishes that caller assertion from tool verification. Without the
assertion, with unresolved signatures, incomplete parsing or coverage, or an aborted run, the
affected result remains `unknown` and `complete` is false. Trigger spans are detected but their
coverage identities are not yet classified by local discovery, so a changed trigger also forces an
explicit incomplete result instead of disappearing from the gate. SaaS validation confirmed that
Business Central reports codeunit `OnRun`, table `OnInsert`, report `OnPreReport`, and page
`OnOpenPage` under their owning object identities with the compiler's trigger-specific method-ID
hash; nested trigger scopes still need separate identity handling. Changed code that carries no
method identity at all — object and field properties, field and control declarations, global
variables, object headers, `namespace`/`using` declarations, and semantic preprocessor directives
outside method spans — is counted in
`summary.unattributedChanges`, listed in `warnings` with its exact lines, and also forces
`complete: false`: procedure coverage can never prove those lines were exercised. Conditional
compilation follows `app.json` preprocessor symbols (the manifest and its explicit `runtime` are
required because the runtime selects method-ID hash variants), and dependency identities preserve
namespace qualification from `.alpackages`. Use the same base ref when rerunning a broader test
selection to close reported gaps.

[Back to README](../README.md)
