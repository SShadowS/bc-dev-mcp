# bc-dev-mcp — Live wire-probe evidence — Cronus28 BC28

Captured 2026-07-04 against the Cronus28 container (dev API 7.0). Raw payloads
backing the agent-grade-responses and debugger-power-controls specs. Harness was
a throwaway Bun driver (scratch/, not committed); this file is the durable record.

---

## Part A — DebuggerHub wire probes

# DebuggerHub RAW wire probe — findings (BC28 / Cronus28, 2026-07-04)

Harness: `scratch/wire-probe.ts` (raw @microsoft/signalr, bypasses normalizeKeys/field-mapping).
Full raw log: `scratch/wire-probe.out.txt`. Debug-a-test run of codeunit 50131 (Hello Bug Demo);
3 breaks: #1 div-by-zero error (FailsOnZeroPayments), #2 file/line bp @wire line 9 (SplitsEvenly),
#3 one step past it. DebugOptions with SQL flags ON fired via `HubConnected` (BC28), not inline.

Payloads arrive **dual-cased** (both camelCase + PascalCase keys on every object) — `normalizeKeys`
remains necessary. `changeState` enum serializes as an **integer** (Newtonsoft default), not a string.

---

## Probe 1 — SQL info scope → CONFIRMED

With `EnableSqlInformationDebugger:true` (+ `EnableLongRunningSqlStatements:true`,
`LongRunningSqlStatementsThreshold:1`, `NumberOfSqlStatements:100`), `GetVariables(frameId)` returns
a **second top-level node `<Database Statistics>`** immediately after `<Globals>` (i.e. `list[1]`) —
absent when the flag is false (cf. demos/DEMO.md, which shows only `<Globals>` + locals). No new
callback; it rides inside the normal `GetVariables` array. Matches decompile
`DebugAdapterVariablesRequestHandler` (`list[1].Name.StartsWith("<Database Statistics>")`).

Decisive raw (children of the `<Database Statistics>` node):
```json
{ "name": "<Database Statistics>", "hasChildren": true, "typeName": "", "summary": "",
  "children": [
    { "name": "Current SQL Latency (ms)", "typeName": "Decimal",    "summary": "1.6392" },
    { "name": "Number of SQL Executes",   "typeName": "BigInteger", "summary": "41" },
    { "name": "Number of SQL Row Reads",  "typeName": "BigInteger", "summary": "33" },
    { "name": "Locks", "hasChildren": true },
    { "name": "<Last SQL Statements>", "hasChildren": true, "children": [
        { "name": "SQL0", "children": [
            { "name": "Statement",           "typeName": "Text",       "summary": "SET ANSI_NULLS ON ... SELECT @@SPID" },
            { "name": "Execution Time (UTC)","typeName": "DateTime",   "summary": "7/3/2026 10:12:05 PM" },
            { "name": "Duration (ms)",       "typeName": "Decimal",    "summary": "1" },
            { "name": "Approx. Rows Read",   "typeName": "BigInteger", "summary": "0" } ] } ] },
    { "name": "<Last Long Running SQL Statements>", "hasChildren": true, "children": [ /* same SQLn shape */ ] }
  ] }
```
Implication: SQL diagnostics are a `DebugOptions` opt-in surfaced through `GetVariables` — expose the
four SQL flags and present `list[1]` (when named `<Database Statistics>`) as a "database statistics"
scope: live latency/exec/row-read counters plus recent + long-running SQL statement text.

---

## Probe 2 — AddBreakpoint full response → CONFIRMED

Returns the entire `BreakpointDefinition`, not just an id. Carries `condition`, `methodName`,
`internalMethodName`, `objectId`, `sourceSpan` (object-absolute, from/to line+column, **0-based** wire),
and `relativeSourceSpan` (method-relative). Requested wire line 9 → `sourceSpan` line 9 → **no
relocation** on this build.

Decisive raw:
```json
{ "breakpointId": 2847748271424667600, "condition": "",
  "methodName": "SplitAmount", "internalMethodName": "SplitAmount",
  "objectId": { "ObjectType": 5, "ObjectNumber": 50130 },
  "sourceSpan":         { "from": { "line": 9, "column": 8 }, "to": { "line": 9, "column": 53 } },
  "relativeSourceSpan": { "from": { "line": 7, "column": 8 }, "to": { "line": 7, "column": 53 } } }
```
Implication: we can report the verified method name + resolved source span (and detect
relocation/rejection when the returned span ≠ requested), instead of surfacing an opaque id.

---

## Probe 3 — LocalNode.ChangeState → CONFIRMED

Every `LocalNode` carries `changeState` (int enum: `Unchanged=0, New=1, ValueChanged=2,
DescendantChanged=3`). Same `SplitAmount` frame across a step:

- break#2 baseline: `{ "name": "PerPayment", "summary": "0",   "changeState": 0 }`
- break#3 (post-stepOver): `{ "name": "PerPayment", "summary": "300", "changeState": 2 }`  ← flipped to ValueChanged; siblings stayed `0`.

Implication: we can surface "changed since last stop" markers on variables. Caveat: the diff is
computed **server-side per frame, relative to the previous `GetVariables` call for that frame** — on
the first `GetVariables` of a frame everything reads `New=1` (seen on the fresh `<Globals>`/SQL nodes),
so a client must GetVariables once to establish a baseline before change highlighting is meaningful.

---

## Probe 4 — AllowLargeStrings → CONFIRMED (accepted); un-truncation UNPROVEN

The 3-arg `GetWatchNode(frameId, expr, watchOption)` with `watchOption=1` (`AllowLargeStrings`) is
**accepted** by BC28 (no error; the decompile only sends arg3 when client `Version.Major>=4`, but the
server takes it regardless). Summary was identical for `0` and `1`:
```json
// GetWatchNode(0,"CustomerName",0) and (...,1) both:
{ "name": "CustomerName", "typeName": "Text[100]", "summary": "'Kontorcentralen A/S'", "changeState": 0 }
```
Implication: safe to always send `watchOption=1` on BC28. The un-truncation *effect* is unproven here
because `CustomerName` (19 chars) is well below any truncation threshold — proving it needs a large
(>~ hundreds of chars) string in scope.

---

## Probe 5 — GetNstSessionInfo → CONFIRMED

No-arg call returns `{SessionId, HostId}`:
```json
{ "SessionId": 93274, "HostId": "5c7d9348-7700-4e55-a9d2-1f7752d0dcdc" }
```
`HostId` is a GUID. Implication: we can report the live NST session id + host id at a break — useful
to correlate a debug session with server-side telemetry/event-log entries.

---

## Probe 6 — GetSourceContent → CONFIRMED (app objects); empty for base/system objects

Returns `{Content, IsALContent}`. For the demo app object the `Content` is the **real AL source**;
for a base-app object it comes back empty.
```json
// GetSourceContent({ObjectType:5, ObjectNumber:50130})  (demo codeunit)
{ "IsALContent": true,  "Content": "codeunit 50130 \"Demo Payment Split\"\r\n{\r\n    procedure SplitAmount(... )\r\n ... PerPayment := TotalAmount / NumberOfPayments; ...\r\n}" }  // 480 chars, full source
// GetSourceContent({ObjectType:5, ObjectNumber:1})       (base-app codeunit)
{ "IsALContent": false, "Content": "" }                                                       // empty
```
Implication: `GetSourceContent` yields real AL for objects whose source is available on the server
(published apps with source), enabling "show source at this frame" without a local file — but
base/system objects return empty `IsALContent:false`, so it's a best-effort fallback, not universal.

---

## Part B — dev-endpoint REST + native MCP probes

# Live REST probe findings — BC28 `Cronus28` (2026-07-03)

Auth on all requests: `Authorization: Basic <b64>` header + `Authentication=<b64>` query param (both required per existing wire assumptions). `tenant=default` query param included.

## 1. `dev/sourcecontent` — EXISTS, confirmed

- `GET /BC/dev/sourcecontent?type=5&id=50130&tenant=default` → **200 OK**, `Content-Type: application/json; charset=utf-8`.
  Body: `{"Content":"codeunit 50130 \"Demo Payment Split\"\r\n{\r\n    procedure SplitAmount(...","IsALContent":true}`.
  This is **real, well-formed AL source text** (matches the `hello-bug` demo app codeunit), wrapped in a JSON envelope with an `IsALContent` flag.
- `GET ...type=5&id=1` (base-app codeunit) → **404 Not Found**, `application/problem+json` (RFC9110 15.5.5 body incl. `traceId`). Base-app object source isn't available at this id/type on this container (compiled-only, no source deployed) — a valid negative result, not a route failure.

## 2. `dev/packages` — EXISTS, confirmed

- `GET /BC/dev/packages?publisher=Microsoft&appName=Base%20Application&tenant=default` (no `versionText` needed — server resolved the installed version) → **200 OK**.
  `Content-Type: application/octet-stream`, `Content-Length: 46328125` (~46.3 MB), `Content-Disposition: attachment; filename="Microsoft_Base Application_28.0.46665.50383.app"`.
  Body starts with the `NAVX` magic header (real BC `.app` package format). Confirmed streams the actual app file; body not saved.

## 3. BC native MCP endpoint — see the authoritative result below (§3b)

> The original §3 text (kept for history) went through two wrong reads. The
> authoritative finding is in **§3b**: the management MCP IS live on port 7048
> (OData); the dev/profiling MCP is enabled but its `dev/mcp` route 404s.

## 3a. Original (superseded) read

Initial read of the 405 as "listener exists" was **wrong**. A follow-up full
MCP-handshake probe (2026-07-04, `scratch/native-mcp-probe.ts`) established:

- **7047 on Cronus28 is the SOAP services port**, not an MCP listener. SOAP
  answers every non-`/WS/` `/BC/*` path — including `/mcp` — with a bare
  **405, empty body** (`GET /BC/WS/.../Codeunit/` returns a proper SOAP `401
  FailedAuthentication` fault, proving SOAP owns the port). So the earlier 405
  was SOAP rejecting the path, not an MCP route.
- A real Streamable-HTTP MCP `initialize` was attempted for all three Dev
  contexts (`Dev: Debugging` / `ALRuntime` / `Profiling`); all returned 405,
  empty body. Ports swept 7045–7052, 7085, 8080/1, 9090 — none answered an MCP
  `initialize`.
- Conclusion: BC's native MCP server is **absent or config-gated-off** on this
  BC28 build. The 7047-native-MCP passthrough (roadmap #8) **cannot be
  validated on Cronus28** — it needs a BC instance with the MCP feature bound.

Source-confirmed for when such an instance is available:
- `Dev` header value is the enum **name** (`Debugging`/`ALRuntime`/`Profiling`),
  not the int — `McpClientProvider.cs:23` uses `context.ToString()`.
- Endpoint `<base>/mcp/?tenant=`, StreamableHttp transport, plus
  `mcp-troubleshooting-options` / `mcp-profiling-options` JSON headers.
- `scratch/native-mcp-probe.ts` is reusable as-is against a bound instance.

**Conclusion:** `/mcp` is exposed **only on port 7047**, not 7049 — consistent with the decompiled `DeploymentConstants.McpServerPort = 7047` / `McpRequestHandlerBase` default. Route existence confirmed; exact accepted verb/negotiation not determined (out of scope for this probe).

## 3b. BC native MCP — AUTHORITATIVE (Cronus28, BC 28.0.50283, 2026-07-04)

NST config: both `McpServicesEnabled=true` and `EnableDevMcpServer=true`. Two
distinct MCP servers; no dedicated MCP port key exists.

- **Management MCP — LIVE** at `http://Cronus28:7048/BC/mcp` (OData services
  port). Real MCP handshake succeeds: `initialize` → 200,
  `serverInfo{name:"Microsoft Dynamics 365 Business Central", version
  "28.0.50283.0", description:"Microsoft Dynamics 365 Business Central MCP
  Server"}`, caps `{tools,prompts,resources:{subscribe},completions,logging}`,
  `protocolVersion 2025-06-18`, `Mcp-Session-Id` header returned. **Requires
  `Company` header** (event log `McpBadRequestException: The company name must
  be specified in the header Company` at `NavMcpApiProxyServer.
  InitializeSessionAsync`). `tools/list` **hangs ≥180s** even after a valid
  init (server-side hang on this build) — no catalog obtained. This is the
  business/management MCP; it does not carry profiling/troubleshooting tools.
- **Dev/profiling MCP — ENABLED, NOT BOUND.** Event log `Category: Development —
  Failed request Method:POST Url:http://cronus28:7049/BC/dev/mcp?tenant=default
  StatusCode:404`. The real dev-MCP path is `7049/BC/dev/mcp`; it 404s despite
  the flag — handler not registered in this on-prem image. `schedule_profiling`
  et al. are unreachable via native MCP here.
- **SSE handshake that works** (management MCP): raw Streamable-HTTP — POST
  `initialize` (read inline `text/event-stream` frame, capture `Mcp-Session-Id`),
  POST `notifications/initialized`, read each response inline off the POST SSE
  stream. Only `tools/list` never emits a frame (server hang).

## 4. Snapshot debugger endpoint (7083) — LIVE (the reachable profiling path)

- `GET http://Cronus28:7083/BC/snapshotdebugger/snapshotendpointmetadata?tenant=default`
  (Basic auth) → **200** `{"runtimeVersion":"17.0","webApiVersion":"3.0",
  "webEndpoint":"http://Cronus28/BC/"}`. The `snapshotdebugger/attach|status|
  finish` REST flow (mapped in `2026-07-03-snapshot-capture-design.md`) returns
  an `.alcpuprofile` when `Kind = Sampling` — CPU profiling over plain REST,
  reachable today, independent of the (unbound) native dev MCP.
- `7049/BC/snapshotdebugger/...` → 503 (not the snapshot port; use 7083).
