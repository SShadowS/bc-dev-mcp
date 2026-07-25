# Coverage gap analysis — SaaS Sandbox evidence (2026-07-21)

## Compiler-backed review corrections (2026-07-24)

An independent review compared the method-ID engine with Microsoft AL compiler 18 at runtime 17
across the three repository demo apps and a purpose-built adversarial app compiled against BC28
symbols. Forty-nine of 52 checked signatures matched. The correction captures the compiler-emitted
IDs for the misses in `tests/fixtures/coverage-gap/compiler-method-ids.json` and adds deterministic
coverage for:

- `[TryFunction]` methods using their implicit Boolean return (`TryDivide` = `1393946970`);
- length-preserving .NET invariant casing for legal quoted identifiers
  (`"Größe"` = `-1116888289`);
- changed trigger spans forcing `complete: false` until trigger coverage identities are validated;
- pure-deletion hunks anchoring the surviving line below the deletion;
- scoped Git paths failing closed instead of being dropped, plus case-insensitive `.al` extensions;
- missing procedure-coverage payloads producing `unknown`, never `uncovered`.

This was a compiler-backed and deterministic correction pass, not a new SaaS run. The existing live
deployment-assertion and extension-object attribution checks remain explicitly open in
`scripts/e2e.md`.

> **2026-07-22 correction:** this run validated the Git-to-compiler-identity-to-TestRunnerHub join,
> but it did not validate that the edited local bodies were deployed. Because no app was published,
> the historical `covered`/`complete` labels below are not evidence that the local changed code ran.
> The corrected contract retains those method-ID matches but reports changed procedures `unknown`
> and `complete: false` unless the caller explicitly confirms the current objects are deployed with
> `changesDeployed: true`. A replacement live run using the exact published fixture remains open in
> `scripts/e2e.md`.

## Correction rerun (2026-07-22)

The corrected handler was rerun against the same SaaS Sandbox class of target without publishing or
changing an app. One selected test passed and Business Central returned one matching method identity.
The tool retained that positive evidence in `coveredBy` but returned:

- `deployment: { status: "unverified", verified: false }`;
- the changed procedure as `unknown`;
- `complete: false` and `summary.unknown: 1`;
- a next step requiring publication confirmation before using `changesDeployed: true`.

This closes the stale-deployment false-positive: matching wire identity alone can no longer produce a
green changed-code gate. The separate asserted-deployment live scenario remains open because this
correction rerun deliberately made no external app change. No Production endpoint was called, and
tenant, environment, company, user, token, authorization, authenticated URL, session, and raw payload
values were not retained.

Roadmap item 5 was validated through the real `bcdev_test_run` handler and TestRunnerHub against a
Business Central SaaS Sandbox. No Production endpoint was called and no app was published or
changed. Tenant, environment, company, user, tokens, authorization values, authenticated URLs, and
raw payloads were not retained.

## Fixture

The harness created a disposable local Git repository containing two executable public demo test
procedure identities. It committed a baseline, edited a line inside both procedure bodies, and
called `bcdev_test_run` with `coverageAgainst: "HEAD"` while omitting `coverage`. The tool therefore
had to collect the working-tree diff, discover the changed procedures, calculate their compiler
method IDs, request procedure coverage, and produce one schema-valid result. The temporary project
was removed in a `finally` block.

## Historical pre-correction results

| Scenario | Changed | Covered | Uncovered | Unknown | Complete |
|---|---:|---:|---:|---:|---|
| Narrow selection (one of the two methods) | 2 | 1 | 1 | 0 | yes |
| Broader selection (both methods) | 2 | 2 | 0 | 0 | yes |

For both runs, every procedure historically marked `covered` was cross-checked in memory against the raw
`Tests[].ApplicationObjectId/MethodId` identity returned by Business Central. The procedure absent
from the narrow selection was the sole `uncovered` result; it moved to `covered` in the broader run.
No names, source-text matching, or inferred object ownership were used for that join.

The harness also calculated the compiler method ID for the public demo's parameterized,
Decimal-returning production procedure and matched it against that procedure's raw nested
`CoveredProcedures` identity. This exercises return-type and parameter hashing in addition to the
parameterless test-method identities used for the two gap transitions.

## Local gates covered by deterministic tests

- merge-base comparison through committed, staged, unstaged, and nonignored untracked AL files;
- nested projects, spaces in paths, pure deletion anchors, and rejected option-shaped refs;
- executable procedure parsing, multiline signatures, quoted identifiers, local-variable sections,
  interface-declaration exclusion, and unresolved subtype warnings;
- `.app` package preambles, `SymbolReference.json` subtype resolution, and package cache reuse;
- exact covered/uncovered/unknown classification, including aborted-run conservatism;
- incompatible coverage modes and Git failures release the singleton test-run lock before any
  remote `RunTests` call.

The 2026-07-22 correction adds deterministic coverage for deployment assertions, quoted keyword
identifiers, fail-closed parser errors, `app.json` conditional compilation, nested dependency
namespaces, reserved system-codeunit method IDs, and Git mnemonic-prefix configuration.

The full suite, typecheck, build, and embedded-skill drift results are recorded in the branch commit
and pull-request validation summary when the branch is proposed.
