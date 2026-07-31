---
name: bc-al-testing
description: Run AL tests against a Business Central dev endpoint with the bc-dev-mcp tools — discover test codeunits, run them with structured per-method results, optionally collect code coverage. Use when asked to run, re-run, or triage AL tests on a BC server.
---

# Running AL tests against Business Central

## Workflow

1. `bcdev_status` — preflight. Confirms the dev endpoint is reachable, credentials work,
   and `supportsTestRunning` is true (requires dev API `WebApiVersion >= 7.0`, i.e. BC28+).
   Call this first whenever anything else fails.
2. `bcdev_test_discover` — pure filesystem scan of the AL project for test codeunits
   (`Subtype = Test`) and their `[Test]` methods. No server involved. Use the returned
   `codeunitId` values in the next step.
3. `bcdev_test_run { codeunits: [{ id: <codeunitId> }] }` — runs on the server, returns
   a run `summary` plus per-method `passed | failed | skipped`, duration, and failure output.
   Restrict with `methods: ["Name"]`; pick the company with `company`.
4. To investigate repeatability, call
   `bcdev_test_orchestrate { codeunits: [...], runs: 3 }`. It executes the same selection
   sequentially, retains every enriched run, diffs adjacent passed/failed sets, and classifies
   each method.
5. To check changed-code coverage, publish the current changed objects, then add
   `coverageAgainst: "origin/main"` and `changesDeployed: true`. The latter is your explicit
   confirmation that this working tree is deployed. This implies `coverage: "procedure"` and
   adds `coverageGaps` to the same result.

## Facts that save you time

- **One run at a time.** A second `bcdev_test_run` while one is active fails with
  "already running" — wait and retry. One orchestration owns that same slot for its entire
  repeat sequence, so direct, debug-bound, native-runtime, and other orchestration runs cannot
  overlap it.
- **Orchestration is bounded and evidence-preserving.** `runs` defaults to 3 and accepts 2–20.
  `runs[]` retains every enriched per-method attempt and raw failure output. `diffs[]` reports
  exact adjacent passed/failed set additions and removals plus every changed observation.
- **Flaky means observed pass and fail.** A method is `flaky` only when at least one run passed
  and another failed. Passed/skipped or failed/skipped mixtures are `inconsistent`. A missing
  result, duplicate result, aborted run, or synthetic-only run forces the aggregate
  `complete: false`; inspect `warnings` and `tests[].observations` before trusting stability.
  After an aborted attempt, orchestration retains it but does not start later attempts while
  the prior server-side run may still be active; their observations are `missing`. A thrown setup
  or authorization failure becomes a final aborted attempt instead of discarding earlier evidence.
  Client cancellation is observed between attempts and never cancels an active Business Central
  run. Overlapping codeunit/method selections are rejected, but disjoint method groups for the same
  codeunit remain valid. Non-rolled-back test side effects repeat on every attempted run.
- **Read orchestration identities and skips conservatively.** `tests[].method` keeps the first
  requested or observed spelling, so casing can differ from raw server rows. If every selected test
  is skipped, the existing outcome convention remains `passed`, but `warnings` states that there was
  no passing execution evidence.
- **Orchestration does not collect coverage.** Use `bcdev_test_run` separately for procedure
  coverage or `coverageAgainst`; repeated coverage is deliberately not merged into a stability
  result.
- **Coverage:** pass `coverage: "procedure"` (validated against real BC). `"line"` is
  unproven — do not trust it without independent verification. Covered procedures map
  back to local source files when the object IDs exist in the project.
- **Changed-procedure gaps:** `coverageAgainst` resolves the ref's merge base with `HEAD` and
  compares it with the working tree, including committed branch changes, staged/unstaged edits,
  and nonignored untracked `.al` files. Each current executable procedure intersecting changed
  lines is `covered`, `uncovered`, or `unknown` in `coverageGaps`.
- **Deployment is not inferred.** TestRunnerHub provides method identities but no artifact hash.
  Without `changesDeployed: true`, changed procedures remain `unknown` and `complete` is false even
  when server coverage contains the same method ID. Set it only after publishing the current objects;
  inspect `coverageGaps.deployment` to distinguish the assertion from tool verification.
- **Read gap states conservatively.** `uncovered` means an exact compiler method identity was
  absent from procedure coverage returned for every requested test group. An unresolved signature,
  missing coverage payload, or aborted run is `unknown`, never a proven gap. Changed trigger spans
  are detected and force `complete: false` because local discovery does not yet classify trigger
  identities, including nested trigger scopes. Follow `warnings` before using the result as a gate.
  Broaden the selected tests and rerun with the same `coverageAgainst` ref to close gaps.
- **Changed lines without a procedure identity block the gate.** Properties, field and control
  declarations, global variables, object headers, and `namespace`/`using` lines are counted in
  `coverageGaps.summary.unattributedChanges`, as are semantic preprocessor directives outside
  method spans. They are listed with their exact lines in `warnings` and set `complete: false`.
  Review them yourself; procedure coverage cannot speak about them.
- **`coverageAgainst` requires an `app.json` with an explicit `runtime`** in the AL project — the
  runtime selects the method-ID hash variant, so the analysis refuses to guess.
- **Tests run in codeunit declaration order**, not the order of your `methods` array.
- **Synthetic results:** the run summary can contain an extra entry with an empty
  method name (a server-side quirk, e.g. after watch evaluations). `summary` excludes
  these from totals and reports their count as `syntheticResults`; raw rows remain available.
- **Failed rows are parsed without losing evidence.** Read `failure.message` and
  `failure.callStack`; parsed frames use 1-based `line` and include local `file` when the
  object maps to this project. `failure.parsed: false` means the server format was opaque or
  localized — use the unchanged `output` text. Every frame also retains `raw`.
- **Local mapping is best-effort.** Passing runs without coverage do not scan the AL tree. When
  mapping is needed, the project index is reused within that MCP server; if the directory is
  missing or unreadable, the server evidence still returns with `sourceMappingWarning`.
  The warning identifies whether call-stack files remain `null`, coverage files remain unset, or
  both mappings were unavailable.
- **Follow the response, not a memorized script.** Every success includes `nextSteps`; an empty
  array is valid when the run is complete. An MCP error's text is JSON with stable
  `error.code`, `retryable`, and recovery `nextSteps` (and no `structuredContent`).
- The tests must already be published to the server (publish via the dev endpoint or
  VS Code AL extension); this server runs tests, it does not publish apps.
- Connection defaults come from the project's `.vscode/launch.json`. On-premises UserPassword
  credentials come from `BC_DEV_USER` / `BC_DEV_PASSWORD`; SaaS uses the current Azure CLI login.
  Auth failures name the relevant env vars or Azure CLI/tenant settings to check.

## Debugging a failing test

Switch to the bc-al-debugging skill (skill://bc-al-debugging/SKILL.md): attach the
debugger with break-on-error, run the same codeunit via `bcdev_debug_run_tests`, and
inspect live state at the failure line.
