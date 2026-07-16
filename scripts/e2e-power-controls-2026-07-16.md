# Debugger power controls v2 — BC28 live evidence — 2026-07-16

## Build under test

- Branch: `feat/debugger-power-controls-v2` (v0.3.0), base `main` at `77379c3`
- Target: local BC28 docker container (on-prem, UserPassword), runtime 28.0, dev API 7.0
- Probe app: `demos/hello-bug` v1.1.0.0 — adds codeunit 50132 "Power Controls Probe",
  test codeunit 50133 "Power Controls Tests", table 50134 "Power Probe Log"
- All probes ran through the shipped core (`DebuggerClient` / `TestRunnerClient` /
  `fetchSourceContent` / `parseDatabaseStatistics`), not raw wire calls

## Automated gates

| Gate | Result |
| --- | --- |
| Full tests | PASS — 462 tests, 0 failures |
| Typecheck (`tsc --noEmit`) | PASS |
| Build | PASS |

## Observations

| Feature | Probe | Redacted observation | Result |
| --- | --- | --- | --- |
| breakOnError "all" | 50133 `ErrorAfterCaught` | Broke INSIDE the try function at the caught divide-by-zero (50132 line 11) | PASS (baseline) |
| breakOnError "unhandled" | same | Exactly one break, at the uncaught error (line 23); try-caught error skipped | PASS |
| breakOnRecordWrite "all" | 50133 `TempThenRealWrite` | Breaks at temp `Insert` (line 32) AND real `Insert` (line 42) | PASS — also first-ever validation of record-write break semantics |
| breakOnRecordWrite "nonTemporary" | same | Only the real-table write broke (line 42) | PASS |
| bcdev_source REST, published object | codeunit 50130 | 480 chars of real AL, `isAlContent: true` | PASS |
| bcdev_source REST, base-app object | codeunit 1 | Server returned **404** (not empty JSON) — client now maps 404 to the empty no-source result | PASS after fix (DISCOVERY) |
| bcdev_source hub fallback | `GetSourceContent(5, 50132)` at a live break | 1698 chars of real AL | PASS |
| abort (wire 5) | break, then abort on a would-pass test | `detached` event followed; run completed with the test recorded FAILED; `runAborted` stayed false | PASS |
| release (wire 4) | break, then release on a would-pass test | `detached` event followed; test PASSED (ran on undebugged) | PASS |
| release → exact re-attach | captured `sessionBound.sessionId`, re-attach after release | Rejected as unavailable — debug-bound test session ends with its run | PASS (expected lifecycle) |
| sqlInsight on | 50133 `SqlThenError`, threshold 1 ms | `<Database Statistics>` present: latency 0.4156 ms, 45 executes, 3 long-running entries; real SELECT statements parsed into `{statement, executionTime, durationMs, approxRowsRead}` | PASS |
| sqlInsight off | same | Statistics node absent; tool errors actionably | PASS |
| AllowLargeStrings watch | 50133 `BigStringBreak`, watch `BigString` | 2000-char string returned in full (2002 chars incl. quotes) | PASS |

## Incidents during validation (environment, not product)

- The memory-tight container (8.5 GB limit, ~190 apps incl. the full Microsoft test
  suite) OOM'd its NST repeatedly during validation. Event-log analysis pinned every
  OOM to the session-open path (license XML validation, `NavSession.Open` inside
  `TestRunnerRuntime.InitializeRuntime`, company-open event-subscription rebuild) —
  environment resource exhaustion, not correlated with any specific client call, and
  none of the new v2 wire calls appear in any OOM stack. A container restart (memory
  reclaim) restored everything; `Sync-NAVApp`/`Install-NAVApp` were verified no-ops
  (an initial half-installed-app theory was disproven). Recorded as a known server
  behaviour in `scripts/e2e.md`.
- sqlInsight overhead was NOT measured (container memory variance made timing
  meaningless); the e2e.md line stays open.

## Pending

- SaaS Sandbox re-run of the platform-sensitive subset (cloud `dev/sourcecontent`
  route, "unhandled" behaviour, abort/release, SQL insight availability) — no SaaS
  credentials available in this environment.
