# CPU-profile capture live E2E — Cronus28 (PAYOFF: real `.alcpuprofile` captured)

Date: 2026-07-04. Container: BC28 `Cronus28`. Snapshot endpoint `http://Cronus28:7083/BC/`,
WebClient session via bc-mcp against `http://Cronus28/BC` (`ws://Cronus28/BC/csh`). Basic
`<user>:<pass>`, tenant `default`, company `CRONUS Danmark A/S`.

## Verdict: FULL END-TO-END SUCCESS
The prior "workload-availability wall" (snapshot-sampling-findings.md) is **broken**. Combining the
snapshot sampler with a **bc-mcp WebClient session** produced a real V8 CPU profile.
`src/` of bc-dev-mcp untouched.

Harness (untracked, in `scratch/`):
- `bcmcp-client.mjs` — MCP-SDK stdio client wrapper around bc-mcp's compiled `dist/stdio-server.js`.
- `capture-profile.mjs` — orchestrator: arm sampler → spawn bc-mcp session → AL burst → poll → finish → unzip.
- Wire log: `capture-profile.log`. Artifacts: `profile.zip`, `profile-extract/<ctx>.alcpuprofile`.

## A. bc-mcp connected to Cronus28
- Ran bc-mcp (`business-central-mcp` @ `U:\Git\bc-mcp`) via its compiled `dist/stdio-server.js`
  (had to `npm run build` first — dist was stale; tsx ESM loader chokes on Windows drive-letter paths).
- Driven as an MCP client using bc-dev-mcp's `@modelcontextprotocol/sdk` (`StdioClientTransport`,
  `command=node`, `args=[dist/stdio-server.js]`, cwd = bc-mcp).
- **Working env: `BC_CLIENT_VERSION=28.0.0.0`, `BC_SERVER_MAJOR=28`, `BC_APPLICATION_ID=FIN`**
  (FIN worked first try — no `NavCancelCredentialPromptException`, no need for NAV).
- Companies listed: `CRONUS Danmark A/S` (current) + `My Company`. Session id string
  `DEFAULTCRONUS Danmark A/SSR...FIN`. bc-mcp's BC session is **lazy** (created on first tools/call),
  which is exactly what lets us attach the sampler BEFORE the bindable session exists.

## B. attach — WebClient(1), NextSessionOnTenant
`POST snapshotdebugger/attach?debuggingcontext=<ctx>&tenant=default` → **200**, body `"NextSessionOnTenant"`.
Payload = PascalCase + int enums (as proven before):
`{"DebuggingContext":<ctx>,"ClientType":1,"UserId":null,"SnapshotVerbosity":0,"SessionId":-1,"ExecutionContext":2,"Kind":1,"SamplingInterval":100}`.
`ClientType=WebClient=1` matched on the FIRST attempt — no fallback to ClientService(3) needed.
UserId=null was sufficient (single-user idle container). Status right after attach = `Initialized`.

## C. AL actually ran (real WebClient session)
After arming, the first bc-mcp tool call spawned a fresh WebClient session; the burst opened/read/closed
pages **22 (Customers), 31 (Items), 16 (Chart of Accounts), 27 (Vendors)** + two `bc_search_pages`
(Tell Me indexing). Every call `isError=false`. This is real AL: `OnOpenPage`, `OnCustomerListOpen`,
`LoadItemAttributesData`, FactBox roots, etc.

## D. status reached Started
Sequence: `Initialized` (post-attach) → after the AL burst, first poll already returned **`Started`(2)**.
No stalling. (Prior runs never left `Initialized` because no bindable session existed.)

## E. finish — got the ZIP, extracted a valid V8 profile
`POST snapshotdebugger/finish` → **200, `ETag: "Sampling"`, 8401-byte body, magic `50 4b 03 04` (PK/ZIP)** —
exactly as the decompiled `ExtractProfileFile` predicted. `Expand-Archive` yields
**`<ctx>.alcpuprofile` (71,491 bytes)** — a single member, NOT the raw body (must unzip, don't rename).

Parsed as JSON — genuine V8 CPU profile (+ AL extensions):
- top-level keys: `nodes, startTime, endTime, samples, timeDeltas, kind, serverSessionId,`
  `startTimeUtc, endTimeUtc, activityDescription, firstTraceId`
- **nodes: 109 · samples: 79 · timeDeltas: 79** (samples == timeDeltas, well-formed).
- node.callFrame is standard V8 shape: `{functionName, scriptId, url, lineNumber, columnNumber}`,
  e.g. `OnOpenPage` @ `al-preview://allang/Page/1990/Page_1990.dal:375:8`. Plus AL extras per node:
  `declaringApplication, applicationDefinition, frameIdentifier`.
- 79 distinct AL function names across 22 distinct `al-preview://` object URLs
  (Page 22/31/16/27, Codeunit 1802/701/9560/9561, FactBox pages 9080/9082, …) — i.e. the profile
  captured the exact AL the bc-mcp burst triggered.

## Winning recipe (for a future `bcdev_profile` feature)
1. Metadata gate: `webApiVersion 3.0` ⇒ SampleProfiling OK.
2. attach (`ClientType=WebClient=1`, `SessionId=-1`, `ExecutionContext=2`, `Kind=1`, `SamplingInterval=100`) — records ctx.
3. Create the WebClient session AFTER attach (bc-mcp's lazy session = ideal; open a page/action).
4. Poll `status` → `Started` (one AL burst was enough; reached on first poll).
5. `finish` → when `ETag=="Sampling"` the body is a ZIP; unzip to get `<ctx>.alcpuprofile` (V8 JSON).

## Key lever that unlocked it
The blocker in the earlier session was purely "no bindable session on an idle headless container."
bc-mcp's native-WebSocket WebClient session IS a bindable target (ClientType=WebClient matches the
sampler's next-session bind). Dev-hub test runs / OData were never eligible; a WebClient session is.

git status (bc-dev-mcp): only `scratch/` untracked, `src/` untouched.
(bc-mcp: `dist/` rebuilt — expected, it's the user's other repo; building there was sanctioned.)
