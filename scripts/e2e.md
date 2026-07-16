# E2E verification against a real BC server

Run once per AL major version, against a docker BC with `WebApiVersion >= 7.0`
(check with the `bcdev_status` tool). Set `BC_DEV_USER` / `BC_DEV_PASSWORD`. There
is no server flag: pass `project` as a tool parameter, or start the server
with its working directory set to the AL project.

## Wire assumptions to verify (grep `// WIRE:` in src/)

- [x] `dev/metadata` returns JSON with a `WebApiVersion` field (note actual casing). <!-- 2026-07-03: camelCase confirmed against BC28 (Cronus28), see scripts/e2e-results-2026-07-03.md -->
- [x] TestRunnerHub `Initialize(company, debuggingContext, coverageMode:int)` accepted. <!-- 2026-07-03: confirmed against BC28 -->
- [x] `TestCompleted` args arrive as (int, string, int status, string, long ms) — statuses 0/1/2 map to passed/failed/skipped. <!-- 2026-07-03: 0 (passed) and 1 (failed) confirmed live with real data against BC28; 2 (skipped) not observed (no skipped tests encountered) -->
- [x] `TestRunCompleted` coverage payload for `coverage: "procedure"`: record actual JSON, confirm `Tests[].CoveredProcedures[].{ObjectType,ObjectId,MethodId}` casing. <!-- 2026-07-03: confirmed against BC28; wire also carries an unused `OwningApp` GUID field -->
- [x] `coverage: "line"`: dump raw payload to decide the v2 schema (spec flags this unproven). <!-- 2026-07-03: dumped against BC28 — structurally identical to "procedure" mode for the codeunit tested, no distinct line-level schema observed -->
- [x] DebuggerHub `Attach` + `DebugAdapterConfigurationDone` accepted (no hub exception). <!-- 2026-07-03 round 4 (fixes 38dc476 + 56f32de + 1f4a77d): Attach(SessionId:-1) accepted cleanly; ConfigurationDone is only accepted AFTER the debugger binds a session (HubConnected/at-break) and the deferred send on HubConnected now fires and returns OK on the wire — verified with an invoke-logging hubFactory proxy, and confirmed effective: breakOnError:false suppressed all break events on a run that breaks 12+ times under breakOnError:true. See "Round 4" in scripts/e2e-results-2026-07-03.md -->
- [x] `AddBreakpoint({ObjectType,ObjectNumber},{Line,Column},condition)` returns a `BreakpointId`. <!-- 2026-07-03 round 2: full BreakpointDefinition returned (raw probe, at-break); BreakpointId can be NEGATIVE (hash). Caveat: succeeds even for objects not deployed on the server, then poisons the session — mismatch #8 -->
- [x] Break event fires when a bcdev_debug_run_tests run hits the breakpoint; stack frames carry `StatementSpan.From.Line`. <!-- 2026-07-03 round 2: Break validated via break-on-error during a debug-bound test run (not via a source breakpoint — no deployable test app available); frames carry statementSpan.from.line in BOTH camelCase and PascalCase (mismatch #7); Break arg0 objectId is PascalCase-only -->
- [x] `SetBreakpointResponse` 0-3 continue/step correctly. <!-- 2026-07-03 round 2: 0=Continue and 1=StepOver validated live (step break with errorMessage null at the caller frame); 2=StepInto / 3=StepOut not individually exercised (same call shape) -->
- [x] `GetVariables(0)` returns LocalNode array; note casing. <!-- 2026-07-03 round 2: validated at-break; nodes carry name/typeName/summary/hasChildren/children/changeState in BOTH casings (mismatch #7); ExpandGlobals(0) also validated -->
- [ ] IsAlive arrives during a long break; session survives (auto-ack works). <!-- not validated 2026-07-03 round 2: ZERO IsAlive heartbeats during a 65s held break on this server — cadence unknown, auto-ack path never exercised live -->
- [x] bcdev_debug_eval: GetWatchNode(frameId, expression, watchOption 0) returns a LocalNode; note casing. <!-- 2026-07-03 round 2: validated at-break; out-of-scope expression returns a graceful LocalNode (summary "<Out Of Scope>"); dual casing as mismatch #7 -->
- [ ] Observe BreakOnRecordWriteBehaviour semantics for breakOnRecordWrite true/false. <!-- not validated 2026-07-03 round 4: options delivery now works (BreakOnError proven effective both ways), but record-write break semantics themselves were not exercised — needs a test that writes records under breakOnRecordWrite:true -->

### SaaS / Entra wire assumptions

Run these once per AL major against a Business Central SaaS Sandbox while signed in with Azure CLI.
Never record access tokens, Authorization headers, authenticated URLs, or unredacted CLI output.

- [x] The cloud developer-service base is `https://api.businesscentral.dynamics.com/v2.0/<environment>/dev`, with the environment path segment URL-encoded and `tenant` on metadata/query requests. <!-- 2026-07-10: confirmed against a live SaaS Sandbox; sensitive transcript was not retained -->
- [x] The SaaS snapshot-debugger base is `https://api.businesscentral.dynamics.com/v2.0/<environment>/snapshotdebugger` on the standard HTTPS origin, not the on-prem snapshot port. <!-- 2026-07-10: snapshot metadata confirmed against a live SaaS Sandbox; sensitive transcript was not retained -->
- [x] SaaS SignalR negotiation accepts the same authorization value in the HTTP `Authorization` header and the `Authentication` query parameter. <!-- 2026-07-10: live negotiation confirmed against a SaaS Sandbox; token and authenticated URL were intentionally not retained -->

## Scenarios

- [x] bcdev_status against stopped server → "unreachable" message. <!-- 2026-07-03: confirmed against port 7099 (nothing listening) on Cronus28 -->
- [ ] bcdev_status with wrong password → "auth" message. <!-- not validated 2026-07-03: this container's dev/metadata route is not auth-gated at all (200 for right/wrong/no credentials) — untestable against this server config; see wire mismatch #2 -->
- [x] bcdev_test_run: one passing + one failing method; failure output text present. <!-- 2026-07-03: confirmed against BC28, codeunit 132536 "Assert Test" (IsTrueTest pass, ErrorHasNotBeenThrown fail w/ full stack trace output) -->
- [x] bcdev_test_run with two codeunits: results for both, sequential execution. <!-- 2026-07-03: confirmed against BC28, codeunits 132536 + 132606 -->
- [x] bcdev_debug_attach + bcdev_debug_run_tests + bcdev_debug_wait → break → bcdev_debug_variables → bcdev_debug_continue → testRunFinished. <!-- 2026-07-03 round 3 (fix 56f32de): full tool-level flow validated end-to-end against BC28 — attach (no fatal queued), started:true, break-on-error event w/ 2-frame stack, variables + eval at frame 0, stepOver → step break, continue → testRunFinished with results attached; detach + immediate re-attach both clean. See "Round 3" in scripts/e2e-results-2026-07-03.md -->
- [x] bcdev_debug_detach mid-break: BC session released (check server). <!-- 2026-07-03 round 2: raw StopDebugging+disconnect while held at a break released the session immediately; test completed as failed with "The debugger stopped the current activity."; Get-NAVServerSession shows no leftovers -->
- [ ] tools/list shows title/annotations/outputSchema for all 15 tools; resources/list shows the three skill:// resources.

## Targeted debugger attach (Sandbox)

Run only against a Business Central Sandbox, using two WebClient sessions A and B for the available account. Production is out of scope. With only one Sandbox identity, negative cross-user isolation remains unit-tested rather than claimed live. Record redacted results in `scripts/e2e-targeted-debugger-attach-2026-07-12.md`.

- [x] Default WebClient attach binds deliberately triggered session A and reports a successful `sessionBound` identity. <!-- 2026-07-12 SaaS Sandbox: successful identity + Item-write break; see scripts/e2e-targeted-debugger-attach-2026-07-12.md -->
- [x] Exact attach to an independently active A session; the same Item-write operation in B produces no `break` during the documented wait window. <!-- 2026-07-12: 15-second negative window passed. StopDebugging retires the previously debugged WebClient NST request on this build, so the positive target was selected read-only from active Sandbox sessions; no enumeration was added to the feature. -->
- [x] The operation in A then produces a `break`, proving exact-session targeting. <!-- 2026-07-12: positive break observed after B's negative window; one duplicate record-write stop continued -->
- [x] The exact attach's `sessionBound.sessionId` equals the selected active A ID. <!-- 2026-07-12: equality asserted in memory; neither ID nor host value retained -->
- [x] `userId` targeting for the available account binds a matching WebClient and produces a break. <!-- 2026-07-12: successful identity + Item-write break with same Sandbox account -->
- [x] Detach completes after each scenario and no debugger remains active. <!-- 2026-07-12: harness detached and exited cleanly -->
- [x] Unknown `userId` on SaaS emits a fatal before `sessionBound`, tears down the debugger, and produces no break. <!-- 2026-07-14 SaaS Sandbox: rejected during Attach with redacted actionable error; no sessionBound/break and debugger state was clean. See scripts/e2e-targeted-debugger-attach-2026-07-12.md -->

Never record tenant, environment, user, host, session, connection, token, authorization header, or authenticated URL values. Use stable role labels such as `SESSION_A` and `[REDACTED]`, not reversible hashes.

### On-premises BC28 (live, single identity)

Complements the Sandbox checklist above — the feature's live evidence was SaaS-only, so these confirm the same behaviour on the on-prem wire (local Cronus28 container). The fatal/rejection timing differs by platform, so both rollback branches are only fully exercised across the two.

- [x] Default attach (no selector) reports a real `sessionBound` identity, breaks, and detaches; the unconditional `GetNstSessionInfo` call works on BC28 and does not degrade the on-prem attach into a permanent warning. <!-- 2026-07-13 BC28: sessionBound with real sessionId+hostId, then break at codeunit 50130 line 10, then detached -->
- [x] Exact attach to a nonexistent `sessionId` rejects fast (~84 ms) with the actionable message, no hang. On BC28 this arrives as an `Attach` invocation rejection ("The specified session with id ... for debugging cannot be found"), whereas SaaS signalled it as a fatal during attach — both rollback branches covered, one per platform. <!-- 2026-07-13 BC28 -->
- [x] `userId` targeting for the correct account binds a matching WebClient and breaks. <!-- 2026-07-13 BC28 -->
- [x] Unknown `userId` throws an actionable redacted attach error and produces no `sessionBound`/`break`. On BC28 the "user cannot be found" fatal arrives AFTER `Attach` resolves (during bind), not during the invocation as on SaaS — verifying the post-Attach `failUserAttach` teardown path specifically. <!-- 2026-07-15 BC28: PR #4 fix reverified; deterministic across repeated rounds, no leak into another user's session -->

## Debugger power controls v2

- [ ] breakOnError:"unhandled" does not break on a [TryFunction]-caught error and still breaks on an uncaught one (BC28 + Sandbox).
- [ ] breakOnRecordWrite:"nonTemporary" skips temporary-record writes and still breaks on real-table writes.

## Profiling (snapshot Sampling)

Runs against the **snapshot-debugger port** (`DEFAULT_SNAPSHOT_PORT = 7083`), separate from the dev
port. Requires a bindable **WebClient session** running AL as the profiling target — a headless
dev-hub test run or OData call is not eligible. Trigger it from a browser or a WebSocket client
(e.g. `business-central-mcp`). `grep // WIRE:` in `src/core/snapshot/` and `src/core/urls.ts`.

- [x] `bcdev_profile_status`: snapshot metadata reachable on `:7083`, returns `webApiVersion` (≥3.0 ⇒ `sampleProfilingSupported:true`). <!-- 2026-07-04: BC28 (Cronus28) returned {runtimeVersion:17.0, webApiVersion:3.0, webEndpoint:http://Cronus28/BC/}; tool reported sampleProfilingSupported:true. See scripts/e2e-profile-results-2026-07-04.md -->
- [x] `bcdev_profile_start`: `POST snapshotdebugger/attach` with `SessionId=-1`, `ExecutionContext=2` (Profiling), `Kind=1` (Sampling), `ClientType=WebClient(1)`, `SamplingInterval∈{50,100,150}` → 200, body is the attach kind. <!-- 2026-07-04: attachKind "NextSessionOnTenant"; WebClient(1) matched first try; no affinity cookie (single-node); slot claimed before the await (concurrent-start guard) -->
- [x] Order: `start` must precede session creation — `SessionId=-1` binds the NEXT matching session. <!-- 2026-07-04: arm sampler, then bc-mcp's lazy WebClient session (created on first tools/call) is the bound target; AL burst = open/read pages 22/31/16/27 + Tell Me indexing -->
- [x] `bcdev_profile_poll`: `POST snapshotdebugger/status` → `Initialized` post-attach, `Started` once a session was recorded (`ready:true`). <!-- 2026-07-04: reached Started on the first poll after the AL burst -->
- [x] `bcdev_profile_finish`: `POST snapshotdebugger/finish` → ZIP with `ETag: "Sampling"`; extract the `<ctx>.alcpuprofile` member (must unzip, not rename the body); parses as a V8 CPU profile with AL call frames. <!-- 2026-07-04: 200, ETag "Sampling"; extracted profile has nodes=85 samples=61 timeDeltas=61, callFrame e.g. OnOpenPage @ al-preview://allang/Page/22/Page_22.dal:1674; hotspot summary ranked by self-time -->
- [ ] `finish` with an empty body / non-`Sampling` ETag reports `captured:false` (unit-tested; not re-observed live — the live path always produced a Sampling ZIP).

## Instrumentation profiling

`bcdev_profile_start` with `kind: "instrumentation"` uses the same snapshot-debugger port/attach
flow as sampling, but attaches `Kind=0` (Instrumentation) / `SnapshotVerbosity=1` (Full) /
`ExecutionContext=2` (Profiling) instead of sampling's `Kind=1`/`SnapshotVerbosity=0` — every call is
recorded, not periodically sampled. `grep // WIRE:` in `src/core/snapshot/snapshot-client.ts` and
`src/core/snapshot/snapshot-types.ts`.

- [x] `bcdev_profile_start` (`kind: "instrumentation"`): `POST snapshotdebugger/attach` with
  `Kind=0`, `SnapshotVerbosity=1` (Full), `ExecutionContext=2` → 200, same attach-kind response
  shape as sampling (unit-tested against `snapshot-client.test.ts`). <!-- validated 2026-07-05, see scripts/e2e-instrumentation-results-2026-07-04.md: live against BC28 (Cronus28), attachKind "NextSessionOnTenant", converterAvailable:true -->
- [x] `bcdev_profile_finish` on an instrumentation capture: `POST snapshotdebugger/finish` returns a
  `.zip` with an **empty `ETag`** (unlike sampling's `ETag: "Sampling"`), containing one or more
  `.mdc` FlatBuffers method-context members — must unzip, not rename the body. <!-- validated 2026-07-05, see scripts/e2e-instrumentation-results-2026-07-04.md: RUN A/B zips unzipped to 708 / 11,243 .mdc members respectively -->
- [x] Headless conversion: the `.mdc` zip is converted to a valid `.alcpuprofile` via
  [`bc-mdc-converter`](https://github.com/SShadowS/bc-mdc-converter) (standalone Rust binary,
  discovered via `BC_MDC_CONVERTER` or `PATH`), whose output is byte-identical to the official AL
  tooling's. <!-- validated 2026-07-10 with the Rust converter through the BUILT server, see scripts/e2e-rust-converter-2026-07-10.md: BC_MDC_CONVERTER discovery converted a live BC28 finish response to a 708-node .alcpuprofile (validV8=true), and PATH-scan discovery reported converterAvailable:true. Earlier shim-based validation (2026-07-05): scripts/e2e-instrumentation-results-2026-07-04.md -->
- [x] Graceful fallback: when `bc-mdc-converter` isn't found (or the converter process
  exits non-zero), `bcdev_profile_finish` still saves the raw `.mdc` `.zip` to disk
  (`captured:true`, `kind:"instrumentation-raw"`) and hints to convert manually or open it in VS
  Code, instead of failing the call. <!-- validated 2026-07-05, see scripts/e2e-instrumentation-results-2026-07-04.md RUN B: converterOverride forced unavailable, kind:"instrumentation-raw", 6.48MB zip w/ 11,243 .mdc, converter spawn never invoked -->

## Known server behaviours

- AddBreakpoint for an object not deployed on the server succeeds but poisons the debuggee session with "metadata object ... was not found" errors — only set breakpoints in deployed objects (live E2E 2026-07-03).
- The debugger slot is released asynchronously after StopDebugging; an immediate re-attach can fail transiently — retry after a short delay (live E2E 2026-07-03).
- BC28 never sends `OnAttachedToConnection`; session-bind is signalled by `HubConnected` on the DebuggerHub instead (live E2E 2026-07-03, round 3 residual #10). Fixed in 1f4a77d by keying the deferred DebugAdapterConfigurationDone on first of HubConnected/OnAttachedToConnection — delivery and effect verified live in round 4 (breakOnError:false suppresses breaks; true produces them).
- AddBreakpoint / DebugAdapterConfigurationDone fail with "tenant '' was not found" until the debug session has paused at least once — attach with breakOnError, let the first break bring the session live, then register breakpoints (live E2E 2026-07-03).
- Wire line numbers are 0-based; the tools convert to/from 1-based editor lines (live E2E 2026-07-03).
- bcdev_debug_eval resolves simple identifier/member paths only; compound expressions return <Out Of Scope> and leave a synthetic empty-method entry in the test-run summary (live E2E 2026-07-03).
- `StopDebugging` retires the WebClient NST request that was being debugged on the validated SaaS Sandbox; its captured ID is unavailable for a later exact attach. Validate exact targeting with a separate session that is still active (live E2E 2026-07-12).
- An unavailable exact `sessionId` is reported differently by platform: BC28 rejects the `Attach` invocation ("The specified session with id ... cannot be found"), while SaaS Sandbox raises `OnFatalDebuggerException` during attach. The client converts both into the same rollback (live E2E: BC28 2026-07-13, SaaS 2026-07-12).
- The server does NOT hard-enforce the `userId` attach filter: an unknown user is reported out of band (BC28 fatal after `Attach` resolves, during bind; SaaS fatal during `Attach`), and without teardown the debugger would bind and break in another user's session. The client must fail the attach on that fatal (live E2E: BC28 2026-07-13, fix reverified 2026-07-15).
- Snapshot sampling needs a live WebClient session as the bind target; an idle headless container yields no profile (`Initialized` never advances to `Started`). A `business-central-mcp` WebClient session running AL is a valid target; dev-hub test runs and OData are not (live E2E 2026-07-04).
- `finish` returns a ZIP (magic `50 4b 03 04`) when `ETag=="Sampling"`, NOT the raw `.alcpuprofile` — the profile is the single `<ctx>.alcpuprofile` member inside; unzip, don't rename the body (live E2E 2026-07-04).
- On a lightly-loaded session the top self-time hotspot is `IdleTime` (`al-preview://allang/Undefined:-1`); real AL frames rank below it — expected, not a capture defect (live E2E 2026-07-04).

## capture-and-ship recipe (manual, live — not CI)

Full-cycle validation against a live BC container + a local al-perf server.
Record results in `scripts/e2e-capture-ship-<date>.md`.

1. Start al-perf locally (`bun run web` in U:\Git\al-perf, `AL_PERF_POC_SECRET` set), register a test tenant, export `AL_PERF_URL/TENANT/TOKEN`.
2. `bun scripts/capture-and-ship.ts --server http://<container> --instance BC --duration 60 --dry-run --out-dir scratch/` while driving a WebClient session (business-central-mcp) — expect a manifest print + artifacts.
3. Re-run without `--dry-run`, adding `--keep-artifacts` (needed for step 4 — without it, the `.snapshot.zip`/`.ir.json`/`.manifest.json` are deleted on a successful ship) — expect `shipped`, then verify `storage/<tenant>/profiles/<activityId>/metrics.json` on the server has `captureKind: "instrumentation"` and a `healthScore`.
4. Re-POST the retained `scratch/<activityId>.ir.json` + `scratch/<activityId>.manifest.json` from step 3 with the manual curl recipe and the same activityId — expect `202 duplicate`.
5. Run once against an idle container — expect `0 sessions captured`, exit 0, no POST.
