# Test orchestration — SaaS evidence

Validated on 2026-07-29 against a Business Central 28 SaaS Sandbox through the
real `bcdev_test_orchestrate` handler. The harness accepted only
`environmentType: "Sandbox"` and made no Production or on-premises call.

Tenant, environment, company, user, token, authorization, authenticated URL,
raw server payloads, failure text, call-stack text, durations for individual
methods, and source paths were not retained. The fixture object and method
names are also omitted from this evidence; stable role labels identify the two
selections.

## Stable passing selection

- The default repeat count requested and completed three runs.
- The retained run numbers were exactly 1, 2, and 3.
- Every raw run summary reported `passed`, and every run retained at least one
  real result row.
- The aggregate returned `complete: true`, `outcome: "passed"`,
  `tests: 1`, `stablePassed: 1`, and zero stable failures, flakes,
  inconsistencies, or incomplete identities.
- Both adjacent diffs had no passed/failed additions or removals and no changed
  observation.

## Stable failing selection

- An explicit repeat count requested and completed two runs.
- The retained run numbers were exactly 1 and 2.
- Every raw run summary reported `failed`.
- Every raw run retained nonempty failure output plus a parsed call stack whose
  frames retained raw evidence and used only null or string local file fields.
  No output, frame text, or path was written to this evidence.
- The aggregate returned `complete: true`, `outcome: "failed"`,
  `tests: 1`, `stableFailed: 1`, and zero stable passes, flakes,
  inconsistencies, or incomplete identities.
- The adjacent diff had no passed/failed additions or removals and no changed
  observation.

## Lifecycle and exclusions

- The shared singleton test-run slot was released after both orchestration
  calls.
- Runs were issued through the existing TestRunnerHub client; no new wire
  format or endpoint was introduced.
- No deliberately flaky server test was added or claimed live. Pass/fail flaky
  classification, skipped inconsistency, missing/duplicate observations,
  safe stop after an aborted attempt, missing later observations, mixed
  flaky/inconsistent guidance, and exact adjacent set diffs are covered by
  deterministic core and fake-hub tests. The abort path was not induced during
  this initial run; see the expanded rerun below.
- No coverage, debugger, native runtime, profiling, record-write, Production,
  or on-premises call was made during this acceptance run.

## Expanded post-review rerun

The corrected branch was exercised again through a real MCP `Client` and
`buildServer`, with the production SignalR and Azure CLI authorization
implementations. The harness refused Production-like environment names and
printed only role labels, counts, classifications, and stable error codes.

### Surface and retained evidence

- `tools/list` exposed the orchestration annotations, the 2–20 run bounds, all
  stability states, ambiguous observations, and additive `nextSteps`.
- Four invalid inputs (below-minimum, above-maximum, fractional runs, and an
  empty selection) returned `INVALID_ARGUMENT`, no `structuredContent`, and
  input-schema recovery guidance without claiming the test-run slot.
- The default stable-pass case completed three attempts. Deterministic failure,
  mixed pass/fail, whole-codeunit, case-insensitive method, and two-codeunit
  selections each completed two attempts with the expected stable
  classifications and empty adjacent diffs.
- The maximum accepted count completed all 20 attempts, retained 20 passing
  observations, produced exactly 19 empty adjacent diffs, and returned no
  warning.
- Every returned text payload matched its `structuredContent`. Aggregate
  duration equalled the retained real-row durations. Orchestration returned no
  coverage payload or coverage-gap analysis.
- Deterministic failures retained nonempty raw output, parsed frames, raw frame
  evidence, and at least one local source mapping. Stable failure guidance
  named the `stableFailed` classification; completed passing runs returned no
  unnecessary next step.

### Live fail-closed paths

- A nonexistent selected method completed two server attempts. Each retained
  the server's synthetic row, while the explicitly requested method received
  two `missing` observations and the aggregate returned `complete: false`,
  `outcome: "incomplete"`, warnings, and cautious guidance.
- A nonexistent codeunit returned three non-aborted, empty attempt envelopes.
  The tool invented no method identity and returned an incomplete aggregate
  with warnings.
- Repeating the same codeunit group twice in one plan produced a useful live
  abort: the Sandbox returned one passing result, then aborted that attempt
  before a duplicate row arrived. The orchestration retained that attempted
  run, did not start the second requested attempt, represented the identity as
  `passed, missing`, returned `complete: false`, and warned that server-side
  cancellation could not be confirmed. A clean orchestration immediately
  afterward succeeded, confirming lock release.

This live duplicate-group result remains historical server evidence. The
post-review correction now rejects overlapping codeunit/method selections at
the MCP boundary while continuing to accept disjoint method groups for one
codeunit; deterministic tests cover both shapes. No additional server call was
needed for that input-only correction.

The post-review correction also retains a synthetic aborted attempt when a
later setup or authorization call rejects, observes client cancellation between
attempts without claiming to cancel the active server run, aggregates duplicate
row warnings per run, and warns on an all-skipped selection. These lifecycle
and analysis paths are deterministic tests; they were not induced against the
Sandbox.

### Live singleton contention

- While one five-attempt orchestration held the shared slot, one direct
  `bcdev_test_run` and a second `bcdev_test_orchestrate` both returned
  `TEST_RUN_ACTIVE` plus wait guidance.
- The owning orchestration completed all five attempts, released the slot, and
  a subsequent two-attempt orchestration succeeded.

No deliberately flaky or skipped Sandbox fixture was introduced. Their
classifications, mixed flaky/inconsistent guidance, duplicate-row ambiguity,
and the debug-bound/native-runtime contention variants remain deterministic
tests. No Production, on-premises, debugger, native MCP, profiling,
record-write, source-download, package-download, or coverage call was made in
this rerun.
