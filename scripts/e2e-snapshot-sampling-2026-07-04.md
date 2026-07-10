# Snapshot-debugger SAMPLING (CPU profiling) live E2E — Cronus28

Date: 2026-07-04. Container: BC28 `Cronus28`, snapshot endpoint `http://Cronus28:7083/BC/`,
Basic `<user>:<pass>`, tenant `default`, company `CRONUS Danmark A/S`.
Harness (untracked): `scratch/snapshot-sampling-probe.ts`, `snapshot-sampling-round2.ts`,
`snapshot-sampling-round3.ts`. Wire logs: `snapshot-sampling-wire.log`, `-round2.log`, `-round3.log`.
`src/` untouched (imported `TestRunnerClient` + `signalrHubFactory` read-only).

## Verdict
Attach → status → finish are proven **end-to-end at the HTTP layer** (all 200s), but on this
**idle single-node container no recordable session can be triggered headlessly**, so status never
leaves `Initialized` and `finish` always returns an empty body. **Not** a protocol defect — a
workload-availability wall. No real `.alcpuprofile` was produced.

## Metadata (feature gate)
`GET snapshotdebugger/snapshotendpointmetadata?tenant=default` → 200
`{"runtimeVersion":"17.0","webApiVersion":"3.0","webEndpoint":"http://Cronus28/BC/"}`.
webApiVersion **3.0 ⇒ SnapshotApiFeature.SampleProfiling supported.** Port 7083 is the snapshot
default (confirmed in decompiled `SnapshotDebuggerAttachInitializeRequestHandler` — sets 7083 when
no port), distinct from dev 7049.

## Attach — WORKS
`POST snapshotdebugger/attach?tenant=default&debuggingcontext=<guid>` → **HTTP 200**.
Working payload = **PascalCase field names + INTEGER enum values** (Newtonsoft default), accepted
first try; string-enum / camelCase variants never needed:
```json
{"DebuggingContext":"<guid>","ClientType":2,"UserId":null,"SourceBreakpointLocations":null,
 "SnapshotVerbosity":0,"SessionId":-1,"ExecutionContext":2,"Kind":1,"SamplingInterval":100}
```
- Auth: **Basic `Authorization` header alone is accepted** — no 401, `Authentication` query param
  NOT required (unlike the SignalR hubs). `Content-Type: application/json`.
- Response body = bare quoted enum string: `"NextSessionOnTenant"` (no UserId) vs
  `"NextSessionForUserOnTenant"` (UserId=<user>). UserId plumbing works and flips the bind kind
  (kind 3 → kind 2). `ExecutionContext=Profiling(2)`, `Kind=Sampling(1)`, `SamplingInterval=100`
  all accepted.
- **Affinity cookie: ABSENT.** No `Set-Cookie` on any attach response (single-node docker, no App
  Gateway). Resolves spec open-Q#4: cookie round-trip is a **no-op** here; status/finish succeed
  with only `tenant` + `debuggingcontext` query params. (A multi-node/cloud gateway would still
  send it — keep the cookie plumbing, just don't require it.)

## Status — only ever `Initialized`
`POST snapshotdebugger/status?tenant=default&debuggingcontext=<guid>`, body `{"DebuggingContext":"<guid>"}`
→ 200, body = bare quoted enum string `"Initialized"`. **Never reached `Started`/`Finished`** in any
trial — the recording bound a "next matching session" slot but no matching session ever ran.

## Finish — always empty
`POST snapshotdebugger/finish?...` → **HTTP 200, `Content-Length: 0`, no ETag.** Per decompiled
`FinishAttachAsync`, an empty stream = "finished with no files" (success, nothing recorded). No
`.zip` / `.alcpuprofile`. Both saved `scratch/sample-finish-*.bin` are 0 bytes.

## Workloads tried to make it record (all failed to bind)
1. **Dev-endpoint test run** (codeunit 50131, 3 test methods actually executed) with
   ClientType ∈ {Background=2, WebServiceClient=0, ClientService=3}, ±UserId=<user>, polling
   concurrently: status stayed `Initialized`, finish empty every time. → A dev-endpoint hub
   test-run session is **not eligible** for snapshot capture, regardless of ClientType.
2. **OData/SOAP** (the canonical WebServiceClient session): OData 7048 → 401
   `Authentication_InvalidCredentials`; SOAP 7047 → 401 `FailedAuthentication`. The container's
   web-service endpoints reject `<user>:<pass>` (dev endpoint accepts them; web services need a
   Web Service Access Key / different ServicesCredentialType). No AL ran → nothing to record.
3. **Shared debuggingContext** (round 3): forwarding the snapshot's `debuggingContext` into the
   test runner's `Initialize(company, debuggingContext, coverage)` **BREAKS the snapshot session** —
   status immediately returns
   `{"Message":"The snapshot debugger status could not be retrieved for context '...'. The server
   may have been removed, or the debugging session may have timed out."}`, and the test run then
   **hangs** (shared context makes the test runner wait for an interactive debugger to attach).
   Actively harmful — snapshot binding is by session-match, NOT by shared debuggingContext.

## Why (from decompiled sources)
Snapshot recording binds via **ClientType + UserId + SessionId(-1) = "next matching session"**, not
via debuggingContext (the context only keys status/finish). VS Code's own snapshot flow triggers the
workload by opening a **browser / WebClient session** (`DebugAdapterLaunchBrowserRequestHandler` →
`OpenStartupObject`). Dev-endpoint hub sessions aren't the target session type, and the web-service
endpoints that would spawn a WebServiceClient session reject our creds. Hence: proven wire, no capture.

## Biggest blocker
**No headless way to start a session the profiler will bind to on this idle container.** To reach
`Started` a future live E2E needs one of: (a) OData/SOAP access for the test user (web-service access key)
hitting a page/query-backed entity → WebServiceClient session; (b) a real browser WebClient session
against `http://Cronus28/BC/` while attach is armed; (c) a job-queue / `StartSession` background task
(Background client type) kicked from AL. Test runs over the dev hub will not work.

## De-risking notes for a future `bcdev_profile` feature
- Separate port 7083; Basic header only; no Authentication query param; `tenant=default` on query.
- Attach payload: PascalCase + integer enums (verified accepted). Response enums = bare quoted
  strings → parse via trim + strip-quotes (matches decompiled `Enum.TryParse`).
- Affinity cookie may be absent (single-node) — treat as optional, resend both ways when present.
- **finish returns a `.zip`; when `ETag == "Sampling"` the `<ctx>.alcpuprofile` is a member INSIDE
  that zip** (decompiled `ExtractProfileFile`), NOT the raw body — the finish handler must unzip and
  extract, not just rename. (Could not verify live: no recording produced.)
- Empty finish body (`Content-Length: 0`) = "no snapshot captured" → report as success-with-no-files,
  not an error, and hint "was the target session actually run?".
- The tool surface must own the "now go trigger the session" gap explicitly; auto-driving it via a
  dev-endpoint test run does NOT work.

git status: only `scratch/` untracked (src/ untouched).
