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
5. When a test fails only in the full run, call
   `bcdev_test_orchestrate { codeunits: [...], mode: "order", seeds: [1, 2, 3], pollutionTableId: 18 }`.
   It runs each method alone, then the selection recorded, reversed and once per seed, classifies
   `odVictim` (passes alone, fails after others), bisects each victim to its polluter, and (with
   `pollutionTableId`) attributes the polluter's writes to that table. Keep the selection narrow:
   every run and every bisection probe is one Initialize (cap 50 methods). With al-sem installed,
   `order.staticPrediction.pairs[]` holds statically predicted polluter -> victim pairs (probed
   first) with `dynamic` confirmed/refuted/unresolved; treat them as hints, the bisection decides.
6. To check changed-code coverage, publish the current changed objects, then add
   `coverageAgainst: "origin/main"` and `changesDeployed: true`. The latter is your explicit
   confirmation that this working tree is deployed. This implies `coverage: "procedure"` and
   adds `coverageGaps` to the same result.
6. To run only what a diff can affect, call `bcdev_test_select { baseRef: "origin/main" }`
   before the run (local only: git plus `altool graph`; set `BC_DEV_ALTOOL` if altool is not on
   PATH). Pass each `shards[].codeunits` to `bcdev_test_run` as `codeunits`, unchanged. Add
   `coverageMapFile` from an earlier full run made with `bcdev_test_run { coverageMapFile }` so
   coverage history joins the static call graph.

## Selecting tests from a diff

- **`fallbackToAll: true` means run everything.** The diff touched something selection cannot
  see (non-AL files such as app.json, deleted AL files, triggers, properties or globals, a
  procedure missing from the graph); `fallbackReasons` says what. `shards` then covers every test,
  while `selection` still shows the ranked part.
- **`uncoverable`** lists changed procedures no test reaches; selection cannot prove them.
- **`reason`/`confidence`:** `new-test` (1) is a changed test method; history and the graph
  agreeing scores 0.95; `direct` 0.9; `coverage-history` 0.8; `event` 0.5 is any path through an
  Event/Interface/Run/Trigger edge, which over-approximates fan-out.
- A coverage map recorded against another merge base still counts but is flagged stale in
  `warnings`. Confirm with `coverageAgainst` on the selected run.

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
- **Order mode reads the server's real rules.** Data is rolled back after every codeunit group
  (even after `Commit()`), but not between methods of one codeunit, so committed-row pollution
  only flows from a method declared *above* the victim in the same codeunit. Reversed and shuffled
  orders only permute codeunit groups (they reach SingleInstance/session state); with one codeunit
  selected they equal the recorded order and victims come from isolation versus the full group.
  Each `order.tests[]` row carries its `transactionModel` (AutoCommit when absent; AutoCommit/None
  methods can commit rows). `order.runners[]` lists the project's TestRunner codeunits and whether
  they set TestIsolation; the hub does not run them, see `order.runnerNote`.
- **Read order evidence conservatively.** `bisection.victims[].outcome` is `found` only when a
  `[polluter, victim]` probe reproduced the failure; `compound`, `capped`, `notReproduced` and
  `inconclusive` keep `remainingCandidates`. `writeAttribution[].suspects[].evidence` is
  `writeObserved`, `noWriteObserved`, or `unknown` (capture truncated or failed). A write break
  does not prove the row committed. Order mode needs the test codeunits in the local `project`.
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
