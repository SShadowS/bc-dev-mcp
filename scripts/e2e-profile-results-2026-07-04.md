# Live E2E: `bcdev_profile_*` CPU profiling vs Cronus28 (2026-07-04)

Validation of the four shipped profiling tools end-to-end against a live BC28 container.
Driver: `scratch/profile-e2e.mjs` (untracked) — calls `createProfileTools(state, deps)`
directly (the exact factory `buildServer` registers), so this exercises the shipped tool
surface, not raw HTTP. The session **trigger** is the user's `business-central-mcp`
(`U:\Git\bc-mcp`) driven over stdio: a real WebClient session running AL is the profiling
target. This confirms, through the tools, the raw capture chain first proven in
`scratch/profile-capture-findings.md` (2026-07-04, ctx `ae1505ca-…`).

## Environment

- Container: BC28 `Cronus28`. Snapshot endpoint `http://Cronus28:7083/BC` (separate port
  from the dev endpoint `:7049`). Tenant `default`, company `CRONUS Danmark A/S`,
  Basic `<user>:<pass>` (throwaway container).
- Trigger: `bc-mcp` env `BC_BASE_URL=http://Cronus28/BC`, `BC_CLIENT_VERSION=28.0.0.0`,
  `BC_SERVER_MAJOR=28`, `BC_APPLICATION_ID=FIN` → native WebSocket WebClient session
  (`ws://Cronus28/BC/csh`).
- Verdict: **FULL END-TO-END SUCCESS** — `captured:true`, a valid `.alcpuprofile` with real
  AL frames on disk. `src/` untouched (driver + docs only). Run log: `scratch/profile-e2e.log`.

## Order (why it works)

`bcdev_profile_start` attaches with `SessionId=-1`, which binds the **next** matching session.
So the tool sequence must arm the sampler **before** the WebClient session is created:

```
status  →  start (arm sampler)  →  [bc-mcp spawns WebClient + AL burst]  →  poll (Started)  →  finish
```

bc-mcp's BC session is lazy (created on the first `tools/call`), which is exactly the window
the `-1` next-session bind needs.

## The four-tool sequence (live results)

### 1. `bcdev_profile_status { server, serverInstance:"BC", tenant:"default" }`
```json
{ "reachable": true, "snapshotApiVersion": "3.0",
  "sampleProfilingSupported": true, "webEndpoint": "http://Cronus28/BC/" }
```
`webApiVersion 3.0` on the snapshot port ⇒ major ≥ 3 ⇒ `sampleProfilingSupported:true`.

### 2. `bcdev_profile_start { clientType:"WebClient", samplingIntervalMs:100 }`
```json
{ "debuggingContext": "b37a1fed-98d0-4ed0-aead-2477f1e6db2d",
  "attachKind": "NextSessionOnTenant",
  "hint": "Sampler armed. Now trigger the session to profile …" }
```
- **attachKind `NextSessionOnTenant`** — the server confirms it will bind the next session on
  the tenant. `WebClient(1)` matched first try; `userId` omitted (single-user idle container);
  no affinity cookie (single-node), as expected.

### Trigger (bc-mcp WebClient burst — the caller's job, not the profiler's)
After `start`, the first bc-mcp call spawned a fresh WebClient session
(`DEFAULTCRONUS Danmark A/SSR…FIN`). AL burst = open/read/close pages **22 (Customers),
31 (Items), 16 (Chart of Accounts), 27 (Vendors)** + two `bc_search_pages` (Tell Me indexing).
Every call `isError=false` — real AL: `OnOpenPage`, FactBox flowfield SQL, checklist/approval logic.

### 3. `bcdev_profile_poll {}`
```
[poll #0] → { "status": "Started", "ready": true }
```
Reached `Started` / `ready:true` on the **first** poll — the sampler bound the WebClient session
and recorded it. (Poll progression here was a single step; the loop is built to keep feeding AL
and retry up to 30× if a run only reaches `Initialized`.)

### 4. `bcdev_profile_finish { outPath }`
```json
{ "captured": true, "kind": "sampling",
  "profilePath": "…/b37a1fed-…-2477f1e6db2d.alcpuprofile",
  "summary": { "durationMs": 17345.624, "sampleCount": 61, "nodeCount": 85, "hotspots": [ … ] },
  "nextSteps": ["… pass this .alcpuprofile to al-perf (github.com/SShadowS/al-perf)."] }
```
`finish` returned a ZIP with `ETag: "Sampling"`; the tool extracted the
`<ctx>.alcpuprofile` member and wrote it to disk.

**Hotspot summary (self-time, top of the ranked list):**

| self% | fn | url:line |
|------:|----|----------|
| 93.4% | `IdleTime` | `al-preview://allang/Undefined:-1` |
| 0.6% | `InitializeChecklistOnAfterLogIn` | `…/Codeunit/20419/Codeunit_20419.dal:70` |
| 0.6% | `HasOpenApprovalEntries` | `…/Codeunit/1535/Codeunit_1535.dal:2083` |
| 0.5% | `ShowNotification` | `…/Codeunit/1852/Codeunit_1852.dal:114` |
| 0.5% | `GetRecordOnce` | `…/Table/311/Table_311.dal:1032` |
| 0.5% | `SELECT SUM("Outstanding Amount (LCY)")…FROM …"Sales Line"…` | `…/Page/9082/Page_9082.dal:-1` |
| 0.3% | `Page 16 - Chart of Accounts_Root` | `…/Page/16/Page_16.dal:-1` |
| 0.3% | `Page 27 - Vendor List_Root` | `…/Page/27/Page_27.dal:-1` |

`IdleTime` dominating is expected for a lightly-loaded sampled session (the WebClient spends most
wall-clock waiting between actions); below it are genuine AL frames from exactly the objects the
burst exercised — FactBox SQL on Page 9082, the login checklist, approval checks, page roots.

## On-disk profile — valid V8 CPU profile

Parsing `b37a1fed-….alcpuprofile` (via the tool's `profilePath`) as JSON:

- Top-level keys: `nodes, startTime, endTime, samples, timeDeltas, kind, serverSessionId,`
  `startTimeUtc, endTimeUtc, activityDescription, firstTraceId` — standard V8 CPU-profile shape
  plus BC's server-session metadata.
- **nodes: 85 · samples: 61 · timeDeltas: 61** (samples == timeDeltas — well-formed).
- 15 distinct `al-preview://` object URLs, 66 distinct AL function names.
- `node.callFrame` is standard V8 shape, e.g.
  `{ functionName:"OnOpenPage", scriptId:"Page_22", url:"al-preview://allang/Page/22/Page_22.dal", lineNumber:1674, columnNumber:8 }`
  — i.e. the `OnOpenPage`/`Page_*.dal` frames the design anticipated.
- Per-node AL extras: `declaringApplication, applicationDefinition, frameIdentifier`.
- `kind:1` (Sampling); `activityDescription:"Calling entry function/trigger OnCompanyOpen on the application object of type CodeUnit with ID 2000000003 named Company Triggers."`

## Cross-check with the reference raw capture

Matches `scratch/profile-capture-findings.md` (raw HTTP, ctx `ae1505ca-…`): same `attachKind`
`NextSessionOnTenant`, same `ETag: "Sampling"` ZIP, same V8+AL profile shape, same
`<ctx>.alcpuprofile` member-name convention (must unzip, not rename). The tools reproduce the
hand-proven chain exactly.

## What this validates about the shipped tools

- `bcdev_profile_status` gates correctly on the snapshot port's `webApiVersion`.
- `bcdev_profile_start` arms the sampler, returns the `debuggingContext` + `attachKind`, and claims
  the single-capture slot (concurrent start already guarded in unit tests).
- `bcdev_profile_poll` surfaces `Started`/`ready` honestly.
- `bcdev_profile_finish` extracts by `ETag=="Sampling"`, writes the `.alcpuprofile`, and returns a
  ranked AL self-time summary — not a raw blob — plus the al-perf next-step hint.
