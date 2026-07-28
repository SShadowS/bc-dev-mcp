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
- [x] `TestRunCompleted` `Tests[].ApplicationObjectId/MethodId` identifies the executed test procedure itself, separately from `CoveredProcedures`. <!-- 2026-07-21 SaaS Sandbox: two selected public demo test methods matched their locally calculated codeunit/method identities; see scripts/e2e-coverage-gap-analysis-2026-07-21.md -->
- [x] `coverage: "line"`: dump raw payload to decide the v2 schema (spec flags this unproven). <!-- 2026-07-03: dumped against BC28 — structurally identical to "procedure" mode for the codeunit tested, no distinct line-level schema observed -->
- [x] DebuggerHub `Attach` + `DebugAdapterConfigurationDone` accepted (no hub exception). <!-- 2026-07-03 round 4 (fixes 38dc476 + 56f32de + 1f4a77d): Attach(SessionId:-1) accepted cleanly; ConfigurationDone is only accepted AFTER the debugger binds a session (HubConnected/at-break) and the deferred send on HubConnected now fires and returns OK on the wire — verified with an invoke-logging hubFactory proxy, and confirmed effective: breakOnError:false suppressed all break events on a run that breaks 12+ times under breakOnError:true. See "Round 4" in scripts/e2e-results-2026-07-03.md -->
- [x] `AddBreakpoint({ObjectType,ObjectNumber},{Line,Column},condition)` returns a `BreakpointId`. <!-- 2026-07-03 round 2: full BreakpointDefinition returned (raw probe, at-break); BreakpointId can be NEGATIVE (hash). Caveat: succeeds even for objects not deployed on the server, then poisons the session — mismatch #8 -->
- [x] `BreakpointDefinition.SourceSpan` uses 0-based debugger coordinates that become 1-based tool coordinates; an all-zero value-type span means unset, not line 1. `RelativeSourceSpan` is editor-relative metadata and is not reported. <!-- 2026-07-20 SaaS: real nonzero SourceSpan verified and converted; 2026-07-21: all-zero/unset path confirmed from the serialized BC contract and regression-tested as unverified -->
- [x] Break event fires when a bcdev_debug_run_tests run hits the breakpoint; stack frames carry `StatementSpan.From.Line`. <!-- 2026-07-03 round 2: Break validated via break-on-error during a debug-bound test run (not via a source breakpoint — no deployable test app available); frames carry statementSpan.from.line in BOTH camelCase and PascalCase (mismatch #7); Break arg0 objectId is PascalCase-only -->
- [x] Break stack frames carry the complete zero-based `StatementSpan.From/To` line and column positions needed to isolate a multiline write statement; the tool exposes a nondegenerate span as 1-based coordinates and retains the legacy `line`. <!-- full Pascal/camel normalization, multiline, missing, and all-zero paths unit-tested 2026-07-26; live SaaS record-write capture retained a usable full span in every exact writer group -->
- [x] `SetBreakpointResponse` 0-3 continue/step correctly. <!-- 2026-07-03 round 2: 0=Continue and 1=StepOver validated live (step break with errorMessage null at the caller frame); 2=StepInto / 3=StepOut not individually exercised (same call shape) -->
- [x] `GetVariables(0)` returns LocalNode array; note casing. <!-- 2026-07-03 round 2: validated at-break; nodes carry name/typeName/summary/hasChildren/children/changeState in BOTH casings (mismatch #7); ExpandGlobals(0) also validated -->
- [ ] `LocalNode.ChangeState` is the integer enum 0/1/2/3 (`unchanged`/`new`/`valueChanged`/`descendantChanged`); observe at least one nonzero value live. <!-- wire shape and all mappings unit-tested 2026-07-21; SaaS 2026-07-20 returned only 0 during the observed step, so the nonzero live case remains open -->
- [ ] IsAlive arrives during a long break; session survives (auto-ack works). <!-- not validated 2026-07-03 round 2: ZERO IsAlive heartbeats during a 65s held break on this server — cadence unknown, auto-ack path never exercised live -->
- [x] bcdev_debug_eval: GetWatchNode(frameId, expression, watchOption 0) returns a LocalNode; note casing. <!-- 2026-07-03 round 2: validated at-break; out-of-scope expression returns a graceful LocalNode (summary "<Out Of Scope>"); dual casing as mismatch #7 -->
- [x] Observe BreakOnRecordWriteBehaviour semantics for breakOnRecordWrite true/false. <!-- 2026-07-16 BC28: validated — All breaks on temp+real Insert, ExcludeTemporary skips temp; see power-controls v2 section -->
- [x] With record-write breaking active, the paused AL statement is one of `Insert`, `Modify`, `ModifyAll`, `Rename`, `Delete`, or `DeleteAll`, and evaluating its exact receiver with `GetWatchNode(0, receiver, AllowLargeStrings)` returns `TypeName: "Table <name> (<positive ID>)"` for both Record and runtime RecordRef values. <!-- all six operations plus Record and runtime RecordRef exact identities validated in the redacted SaaS capture 2026-07-26 -->

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
- [ ] tools/list shows title/annotations/outputSchema for all 20 tools; resources/list shows the three skill:// resources.

## Break-on-record-write triage (SaaS Sandbox)

Run only against a disposable app and Business Central Sandbox. Never record tenant, environment,
company, user, host, session, connection, token, authorization header, authenticated URL, record
field values, or raw source. Evidence belongs in
`scripts/e2e-break-on-record-write-triage-2026-07-25.md`.

- [x] `bcdev_record_writes_start` returns while arming, then the matching workload binds and status moves to `collecting` without manual debugger wait/continue calls. <!-- 2026-07-26: disposable API trigger started a Background session; collection and continuation were automatic -->
- [x] Default `includeTemporary:false` excludes a temporary target write while retaining real target writes; `includeTemporary:true` observes the temporary write. <!-- 2026-07-26: inclusive capture added exactly one matched write -->
- [x] One workload produces repeated exact target writes from one stack, an exact target write from a second stack, and an unrelated-table write; final counts and groups match. <!-- 2026-07-26: 13 observed, 10 matched in 9 groups, 3 unrelated, 0 unresolved -->
- [x] Every exact group uses deployed source plus a runtime receiver `tableId` equal to the requested numeric ID; unrelated and unresolved writes never enter `writers`. <!-- 2026-07-26: 10 exact deployed-source writes with 0 unresolved, including runtime RecordRef; the final report is deliberately incomplete after sessionDetached -->
- [x] The unasserted local-source fallback cannot produce an exact group; `changesDeployed:true` permits it only after the exact fixture has been published. <!-- 2026-07-26: unasserted produced 0 matches and incomplete evidence; asserted produced 3 localAsserted matches -->
- [x] `maxObservedWrites` classifies the cap event, sends `release`, and returns `truncated:true`, `complete:false` without leaving the workload paused. <!-- 2026-07-26: cap=1 returned one observed event and the background workload completed -->
- [x] Finish clears the triage owner and an immediate manual attach or second triage start can claim the debugger slot. <!-- 2026-07-26: immediate manual attach/detach succeeded after the capture sequence -->
- [x] An explicit `with Target` inside a different table's method resolves unqualified writes to `Target`, and valid parenthesis-free `Insert`, `Modify`, `Delete`, and `DeleteAll` calls classify exactly. <!-- 2026-07-26: republished disposable fixture produced receiver Target, all four operations, and 0 unresolved writes -->
- [x] The idiomatic `if not Record.Insert(false) then Record.Modify(true)` reports an individual write-call StatementSpan for each operation rather than one enclosing conditional span. <!-- 2026-07-26 SaaS: 5 observed, 5 matched, Insert and Modify both exact, 0 unresolved; multipleWriteCandidates remains a deterministic fail-closed fallback -->
- [x] A session detach before finish retains partial exact groups but forces `complete:false`, `stopReason:"sessionDetached"`, a warning, and cautious next steps; a detach caused by finish's own release barrier does not. <!-- SaaS Background completion exercised the fail-closed result 2026-07-26; external and finish-induced paths also deterministic-tested -->
- [x] Finish orders an in-flight asynchronous Break through a best-effort `ReleaseConnection` invocation before closing intake, classifies the callback, and releases exactly once whether the barrier is accepted or rejected. <!-- deterministic fake-hub fault injection 2026-07-26; the race was not induced live -->
- [x] Rejected debugger configuration and an unexpected clean hub close fail the retained report closed rather than returning a complete zero-write result. <!-- deterministic fake-hub fault injection 2026-07-26; these failures were not induced live -->
- [x] No Production or on-premises call is made during this feature's acceptance run. <!-- 2026-07-26: harness refused non-Sandbox configuration; only the disposable SaaS Sandbox fixture was published and called -->

## BC native MCP passthrough (SaaS Sandbox, BC28)

Run only against SaaS Sandbox. Never retain tenant, environment, company, user, host,
session, token, authorization, authenticated URL, returned business data, or raw server
payloads. Evidence belongs in `scripts/e2e-native-mcp-passthrough-2026-07-27.md`.

- [x] Azure CLI authorization resolves the configured Sandbox before native MCP validation. <!-- 2026-07-27 SaaS BC28; developer API 7.0 preflight -->
- [x] The business context initializes through the fixed cloud gateway with no `Dev` header,
  lists the native `bc_actions_*` catalog, and a read-only `bc_actions_search` call succeeds.
- [x] The runtime context sends `Dev: ALRuntime`, lists `run_tests`, and invokes it against a
  published disposable test fixture while respecting the shared test-run lock.
- [x] A manual debugger bind records NST session and host identity; before a break, native
  debugging fails with `DEBUG_SESSION_NOT_PAUSED`.
- [x] At a real break, the debugging context sends `Dev: Debugging` plus
  `mcp-troubleshooting-options`, lists `get_stack_frames`, `get_variables`,
  `get_source_code`, and `add_breakpoint`, and each tool can be called using its discovered
  schema.
- [x] Continuing the debug session makes the native debugging context unavailable again;
  detach leaves no active debugger.
- [x] Unit protocol coverage drives both `tools/list` and `tools/call` through the installed
  Streamable HTTP SDK and proves upstream `isError`, content, structured content, metadata,
  unknown fields, pagination, authorization/request timeout, and DELETE cleanup are preserved
  or handled without exposing authorization.
- [x] No native profiling context, `Dev: Profiling`, or `mcp-profiling-options` header exists
  in the implementation. <!-- exact header matrix and public input enum unit-tested 2026-07-27 -->
- [x] No Production or on-premises call is made during live acceptance. <!-- harness refused non-Sandbox configuration; see dated evidence -->

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

- [x] breakOnError:"unhandled" does not break on a [TryFunction]-caught error and still breaks on an uncaught one (BC28; Sandbox pending). <!-- 2026-07-16 BC28: "all" broke inside TryDivide (line 11) AND at the uncaught error; "unhandled" broke ONLY at the uncaught error (line 23). Evidence: scripts/e2e-power-controls-2026-07-16.md -->
- [x] breakOnRecordWrite:"nonTemporary" skips temporary-record writes and still breaks on real-table writes. <!-- 2026-07-16 BC28: "all" broke at temp Insert (line 32) + real Insert (line 42); "nonTemporary" only at line 42 -->
- [x] bcdev_source (REST) returns real AL for a published demo object (hello-bug codeunit 50130). <!-- 2026-07-16 BC28: 480 chars of AL, isAlContent true -->
- [x] bcdev_source (REST) for a base-app object (codeunit 1) returns empty content + isAlContent:false, not an error. <!-- 2026-07-16 BC28: server 404s for no-source objects; client maps 404 to the empty result -->
- [ ] bcdev_source cloud route works on the v2.0 base URL (Sandbox).
- [x] bcdev_source hub fallback (GetSourceContent) returns source at a live break when REST is unavailable. <!-- 2026-07-16 BC28: hub GetSourceContent at a break returned 1698 chars for codeunit 50132 -->
- [x] abort (SetBreakpointResponse 5) mid-debug-bound-test-run: record which events fire and whether the run reports runAborted. <!-- 2026-07-16 BC28: detached event follows; the run completes with the aborted test recorded as failed (a would-pass test fails); runAborted stays false -->
- [x] release (SetBreakpointResponse 4): released session runs unbroken afterward; record the debugger slot state. <!-- 2026-07-16 BC28: detached event follows; a would-pass test passes (operation continued undebugged); hub connection stays open but debugging is over — detach and re-attach to debug again -->
- [x] release: is the released session still a valid exact sessionId target afterward, or retired like SaaS StopDebugging? <!-- 2026-07-16 BC28: not reusable — the debug-bound test session ends with its run, exact re-attach rejected as unavailable -->
- [x] sqlInsight:true — `<Database Statistics>` node present in GetVariables at a break; absent with the option off (BC28). <!-- 2026-07-16: present with on (latency 0.4156 ms, 45 executes), absent with off -->
- [x] bcdev_debug_sql parses at least one SQLn child into {statement, executionTime, durationMs, approxRowsRead}. <!-- 2026-07-16 BC28: real SELECT statements parsed from the long-running list -->
- [x] longRunningSqlThresholdMs — long-running list populates when a statement exceeds the threshold. <!-- 2026-07-16 BC28: threshold 1 ms captured 3 entries; note <Last SQL Statements> was empty while long-running populated -->
- [ ] sqlInsight overhead: measure a test run with/without; note in the tool description if material.
- [x] bcdev_debug_eval with WatchOption AllowLargeStrings=1 returns a >1KB string un-truncated (BC28). <!-- 2026-07-16: 2000-char PadStr returned in full (2002 chars incl. quotes); truncation-with-0 comparison not re-run -->

## Agent-grade responses (SaaS Sandbox)

Run against Sandbox only; never retain tenant, environment, user, host, session, connection,
token, authorization header, or authenticated URL values. Evidence belongs in
`scripts/e2e-agent-grade-responses-2026-07-20.md`.

- [x] Every listed tool publishes `nextSteps` in its output schema; representative terminal and nonterminal successes return an array. <!-- 2026-07-20: 17/17 schema check plus live status/test/debug successes; see dated evidence -->
- [ ] A deliberately failing AL test returns a run `summary`, preserves raw `output`, parses the `AL Callstack`, and maps at least one frame to a local source file. <!-- 2026-07-20: real Sandbox passing summary verified. The installed intentional-failure probe did not fail on this tenant, so the parser/source-map negative and positive cases remain covered by unit tests using the exact live BC28 AL Callstack shape; no test-only app was published merely to force a failure. -->
- [x] The same enriched run result arrives through a debug-bound `testRunFinished` event. <!-- 2026-07-20 SaaS: real result row plus summary and nextSteps; sessionBound/detached also observed -->
- [x] A live breakpoint addition reports `verified` or `relocated` with the server-resolved 1-based span; legacy ID-only and all-zero value-type spans remain unit-tested as `unverified`. <!-- 2026-07-20 SaaS WebClient: verified with non-null span; 2026-07-21 zero-span regression test -->
- [x] At a live break, variables/watches expose normalized `changeState` and `changed`; record whether this Sandbox emits an observable changed state after stepping. <!-- 2026-07-20 SaaS WebClient: normalized nodes before/after a successful stepOver; no changed:true node was emitted for that step -->
- [x] A failing tool returns `isError:true`, no `structuredContent`, and parseable redacted JSON text with stable code, retryability, tool name, and recovery steps. <!-- 2026-07-20: real MCP server over in-memory transport, NO_DEBUG_SESSION path -->

### Agent-response review corrections

- [x] Next-session/user-filtered attach guidance tells the agent to trigger the matching session before waiting; exact-session guidance waits for confirmation; timeout guidance cannot form a wait-only loop. <!-- unit-tested 2026-07-20 -->
- [x] Exact launch-config and Azure CLI errors are typed at their source; active-profile, SQL-insight-disabled, and unsupported developer API states have stable codes. <!-- unit-tested with production messages 2026-07-20 -->
- [x] Passing test runs without coverage do not require a local AL index; mapping-needed runs retain server results when the project is missing/unreadable. <!-- unit-tested and passing-run metadata preflight rerun on SaaS 2026-07-20 -->
- [x] Error detail strings and sensitive detail keys are redacted. <!-- authenticated URL + authorization/accessToken/password details unit-tested 2026-07-20 -->
- [x] Profile guidance branches on unreachable, unsupported, and empty-capture results. <!-- unit-tested 2026-07-20 -->
- [x] If the private MCP SDK error-formatting seam is absent or cannot be replaced, startup emits a warning and keeps the SDK's default error formatting; the current SDK still routes validation errors through the replacement. <!-- missing/non-writable seam and live replacement integration unit-tested 2026-07-21 -->
- [x] Profile polling guidance distinguishes Initialized, Started, Finished, and Failed instead of treating every non-ready state as retryable. <!-- all four statuses unit-tested 2026-07-20 -->
- [x] Direct and debug-bound test entry points atomically claim the shared run slot before the typed unsupported-server preflight. <!-- deferred-metadata direct/direct, debug/debug, and direct/debug contention unit-tested 2026-07-20 -->
- [x] Specific timeout and not-found fallbacks take precedence over generic validation words, and the SDK's disabled-tool response receives a stable state code. <!-- exact mixed-message and disabled-tool cases unit-tested 2026-07-21 -->
- [x] MCP recovery guidance and error serialization live in the MCP layer; the core error type has no MCP tool-name or frontend dependency. <!-- architecture audit and typecheck 2026-07-21 -->
- [x] Local source indexes are scoped to one dependency/server composition; successful developer-metadata preflights expire, and the request has a bounded timeout that releases the test-run lock. <!-- TTL refresh, abort-aware timeout, and lock cleanup unit-tested 2026-07-21 -->
- [x] Source-mapping failures identify call-stack and/or coverage file fields precisely and do not partially map the result. <!-- missing-project procedure-coverage and call-stack cases unit-tested 2026-07-21 -->
- [x] The response decorator rejects non-object output schemas and replaces payload-supplied `nextSteps` with locally generated guidance. <!-- unit-tested 2026-07-21 -->
- [x] Error redaction removes URL userinfo as well as authentication query/header material; passing test rows omit the optional `failure` key. <!-- unit-tested 2026-07-21 -->

## Coverage gap analysis (SaaS Sandbox)

Run against Sandbox only. Use a disposable Git project and never record tenant, environment,
company, user, token, authorization header, authenticated URL, or raw server payload values.
Evidence belongs in `scripts/e2e-coverage-gap-analysis-2026-07-21.md`.

- [x] `coverageAgainst` without `coverage` sends procedure coverage and returns schema-valid `coverageGaps`. <!-- 2026-07-21 SaaS Sandbox -->
- [x] The Git comparison covers the base merge commit through the working tree, including committed, staged, unstaged, and nonignored untracked AL files; `.al` matching is case-insensitive, pure deletions anchor to the surviving line below, and scoped paths fail closed instead of being dropped. <!-- deterministic temporary-repository tests 2026-07-24 -->
- [x] Without `changesDeployed`, matching server method IDs remain retained evidence but every changed procedure is `unknown` and `complete:false`. <!-- deterministic handler test + SaaS Sandbox rerun 2026-07-22; one passing test, one retained covering identity -->
- [x] Publish the exact changed fixture to Sandbox, pass `changesDeployed:true`, and validate narrow one-covered/one-uncovered then broad two-covered transitions. <!-- 2026-07-25 SaaS Sandbox; exact working-tree app published, narrow 2/1/1 and broad 2/2/0 with complete:true -->
- [x] Every live `covered` classification matches the raw `ApplicationObjectId/MethodId` returned for its selected test; no name-only join is used. <!-- 2026-07-21 SaaS Sandbox -->
- [x] The calculated ID for the public demo's parameterized, Decimal-returning procedure matches its raw nested `CoveredProcedures` identity. <!-- 2026-07-21 SaaS Sandbox -->
- [x] Compiler-grounded vectors cover `[TryFunction]`'s implicit Boolean return and length-preserving invariant casing for quoted identifiers. <!-- 2026-07-24: alc 18/runtime 17 fixture; see tests/fixtures/coverage-gap/ -->
- [x] A missing procedure-coverage payload retains positive evidence but makes absent identities `unknown`; it never infers `uncovered`. An empty `Tests` collection for a group that did execute tests is treated the same way. <!-- deterministic hub/core/MCP tests 2026-07-25 -->
- [x] Changed code lines carrying no method identity (properties, field/control declarations, global variables, object headers, namespace/using, and semantic preprocessor directives outside method spans) are counted, warned with their exact lines, and force `complete:false`. <!-- deterministic discovery/analysis/MCP tests 2026-07-25 -->
- [x] `coverageAgainst` refuses a project without `app.json` or without an explicit `runtime` instead of assuming the newest runtime. <!-- deterministic tests 2026-07-25 -->
- [x] Probe empty coverage evidence live: every group that executed a test returned a nonempty `Tests` collection; a nonexistent method produced only the blank codeunit-rollup row and omitted `Tests` entirely, which correctly yielded `coverageComplete:false`. <!-- 2026-07-25 SaaS Sandbox; an executed group returning `Tests:[]` was not observed -->
- [x] Quoted keyword identifiers, fail-closed parser errors, conditional compilation, nested SymbolReference namespaces, system-codeunit IDs, forced Git prefixes, deployment assertions, cache reuse, aborted-run conservatism, unknown signatures, and incompatible coverage modes are deterministic tests. <!-- 2026-07-22 -->
- [x] Validate trigger method identities in live `CoveredProcedures`: codeunit `OnRun`, table `OnInsert`, report `OnPreReport`, and page `OnOpenPage` were attributed to their owning objects and matched the compiler's trigger-specific hash exactly. Local discovery remains conservative for trigger scopes and forces `complete:false`. <!-- 2026-07-25 SaaS Sandbox -->
- [x] Validate whether `CoveredProcedures` attributes tableextension/pageextension/reportextension methods to the extension object type/ID used by local discovery. <!-- 2026-07-25 SaaS Sandbox: object types 15/14/22 and all three local method IDs matched exactly -->
- [x] No Production call was made. The exact disposable fixture and current trigger-zoo demo were published only to Sandbox for the 2026-07-25 validation. <!-- tenant/environment/company/user/token/authorization/authenticated URL values not retained -->

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
- `dev/sourcecontent` returns **404** for objects without deployed source (base application) on BC28 — not an empty SourceContent body. The client maps 404 to the empty no-source result (live E2E 2026-07-16).
- `SetBreakpointResponse` abort (5) and release (4) both end debugging with a `detached` event and the workload's test run still completes: abort records the test as failed, release lets it pass. Neither leaves a reusable exact-attach target — a debug-bound test session ends with its run (live E2E 2026-07-16).
- With `EnableLongRunningSqlStatements` on, `<Last SQL Statements>` was observed empty while `<Last Long Running SQL Statements>` populated — don't treat an empty last-statements list as "no SQL" (live E2E 2026-07-16).
- On a memory-tight container (8.5 GB cap, ~190 apps incl. the full Microsoft test suite), every session-open path OOMs once the NST working set nears the cap: TestRunnerHub `Initialize` (`NavSession.Open` in `TestRunnerRuntime.InitializeRuntime`), debugger-bound company open (`CompanyOpen`/`InvokeOnCompanyOpenCompleted`, event-subscription + global-trigger array rebuild), and license XML validation. The same calls succeed on a fresh NST — restart reclaims it; give such containers 16 GB. NOT a wire/product defect and not correlated with any specific client call (observed 2026-07-16; an earlier note here blamed an interrupted publish leaving the app half-installed — disproven: Sync/Install-NAVApp were no-ops and the memory restart alone fixed Initialize).
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
