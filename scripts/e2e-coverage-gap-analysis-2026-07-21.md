# Coverage gap analysis — SaaS Sandbox evidence (2026-07-21)

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

## Results

| Scenario | Changed | Covered | Uncovered | Unknown | Complete |
|---|---:|---:|---:|---:|---|
| Narrow selection (one of the two methods) | 2 | 1 | 1 | 0 | yes |
| Broader selection (both methods) | 2 | 2 | 0 | 0 | yes |

For both runs, every procedure marked `covered` was cross-checked in memory against the raw
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

The full suite, typecheck, build, and embedded-skill drift results are recorded in the branch commit
and pull-request validation summary when the branch is proposed.
