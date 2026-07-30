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
  aborted continuation, and exact adjacent set diffs are covered by
  deterministic core and fake-hub tests.
- No coverage, debugger, native runtime, profiling, record-write, Production,
  or on-premises call was made during this acceptance run.
