# Live debugger demo: Hello Bug Demo on BC28

> **Note (2026-07-03):** captured before the v0.1 tool rename and result envelopes.
> Current names: `bc_status` → `bcdev_status`, `discover_tests` → `bcdev_test_discover`,
> `run_tests` → `bcdev_test_run`, `debug_*` → `bcdev_debug_*`;
> `bcdev_test_discover` now returns `{ tests: [...] }`,
> `bcdev_debug_variables` `{ variables: [...] }`, `bcdev_debug_eval` `{ result: ... }`.
> Wire behaviour shown is unchanged.

This is a full, unedited walkthrough of `bc-dev-mcp`'s debugger tools running against a
**real** Business Central 28 container (`Cronus28`, dev endpoint `http://Cronus28:7049/BC`)
— not a mock, not a unit test double. Every request/response block below is the actual
JSON returned by the tool handlers in `src/mcp/tools.ts`, captured by a scratch driver
script that imports `createTools` directly and calls the handlers the same way an MCP
client would.

Why bother proving this against a live container? Because a debugger integration is
exactly the kind of thing that looks plausible in code review and then falls apart the
first time it touches a real server: SignalR handshake quirks, wire-format mismatches,
line-numbering conventions, session binding order. This walkthrough exists so a skeptical
reader can see the actual bytes, not a description of them.

## The bug

`demos/hello-bug/` is a tiny AL app with one deliberate bug:

```al
// src/DemoPayment.Codeunit.al
codeunit 50130 "Demo Payment Split"
{
    procedure SplitAmount(TotalAmount: Decimal; NumberOfPayments: Integer) PerPayment: Decimal
    var
        CustomerName: Text[100];
        Remainder: Decimal;
    begin
        CustomerName := 'Kontorcentralen A/S';
        Remainder := TotalAmount;
        PerPayment := TotalAmount / NumberOfPayments; // line 10 — divides by zero when NumberOfPayments = 0
        Remainder := TotalAmount - PerPayment * NumberOfPayments;
    end;
}
```

Two tests in `src/DemoPaymentTests.Codeunit.al` (codeunit 50131, `Subtype = Test`):

- `FailsOnZeroPayments` — calls `SplitAmount(2500.75, 0)` → runtime "Attempted to divide
  by zero."
- `SplitsEvenly` — calls `SplitAmount(1200, 4)` → 300, asserted correct → passes.

Published to Cronus28 as `Hello Bug Demo` by `SShadowS`, version `1.0.0.0`.

**Note on method order:** the tests run in codeunit declaration order (BC's test runner
ignores the order of the `methods` filter array — confirmed in the investigation below),
so `FailsOnZeroPayments` is declared *first* in the source. That's not arbitrary: its
break-on-error pause is what gives the debugger session a live tenant/company context,
which turns out to be required before a file/line breakpoint can be registered — see
"What we found the hard way" below.

## Environment

- Dev endpoint: `http://Cronus28:7049/BC`, Basic auth, tenant `default`, company
  `CRONUS Danmark A/S`
- BC28: `runtimeVersion 17.0`, `webApiVersion 7.0`
- Captured 2026-07-03

## Walkthrough

### 1. Discover tests

```json
// discover_tests { "project": "demos/hello-bug" }
```

```json
[
  {
    "codeunitId": 50131,
    "name": "Demo Payment Tests",
    "file": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug\\src\\DemoPaymentTests.Codeunit.al",
    "methods": [
      "FailsOnZeroPayments",
      "SplitsEvenly"
    ]
  }
]
```

Pure filesystem scan (no server call) — finds the `[Test]` codeunit and both methods.

### 2. Attach the debugger

```json
// debug_attach
{
  "server": "http://Cronus28",
  "serverInstance": "BC",
  "project": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug",
  "breakOnError": true,
  "breakpoints": []
}
```

```json
{
  "attached": true,
  "connectionId": "qNUW6VL4karH3sXBU3C5Ow",
  "breakpoints": []
}
```

Attaches to the DebuggerHub and arms break-on-error. No breakpoints yet — see the note
below on why they can't be set at this point.

### 3. Run both tests, debug-bound

```json
// debug_run_tests
{
  "server": "http://Cronus28",
  "serverInstance": "BC",
  "project": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug",
  "codeunits": [{ "id": 50131 }],
  "company": "CRONUS Danmark A/S"
}
```

```json
{
  "started": true,
  "hint": "Call debug_wait to receive break events; testRunFinished signals completion. Results in debug_wait's testRunFinished response."
}
```

The test run is bound to the debug session's `connectionId` internally — this is the
"debug-a-test" binding: breakpoints and break-on-error fire *during* this specific test
run, not for arbitrary unrelated sessions.

### 4. First break — the runtime error

```json
// debug_wait { "timeoutMs": 60000 }
```

```json
{
  "kind": "break",
  "objectType": 5,
  "objectId": 50130,
  "errorMessage": "Attempted to divide by zero.",
  "line": 9,
  "stack": [
    {
      "objectType": 5,
      "objectId": 50130,
      "objectName": "Demo Payment Split",
      "methodName": "SplitAmount",
      "line": 9,
      "file": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug\\src\\DemoPayment.Codeunit.al"
    },
    {
      "objectType": 5,
      "objectId": 50131,
      "objectName": "Demo Payment Tests",
      "methodName": "FailsOnZeroPayments",
      "line": 16,
      "file": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug\\src\\DemoPaymentTests.Codeunit.al"
    }
  ],
  "file": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug\\src\\DemoPayment.Codeunit.al"
}
```

`FailsOnZeroPayments` calls `SplitAmount(2500.75, 0)` and the debugger pauses right on
the division statement — **before** the test framework turns it into a "failed" result.
Both stack frames resolved to **local source file paths**, not server-internal paths:
`AlObjectIndex` mapped `CodeUnit 50130`/`50131` back to the actual `.al` files on disk by
parsing their object declarations. This is the file/line mapping the whole tool exists
to provide.

### 5. Inspect state at the error

```json
// debug_variables { "frameId": 0 }
```

```json
[
  { "name": "<Globals>", "typeName": "Codeunit Demo Payment Split (50130)", "summary": "Codeunit Demo Payment Split (50130)", "hasChildren": true },
  { "name": "TotalAmount", "typeName": "Decimal", "summary": "2500.75", "hasChildren": false },
  { "name": "NumberOfPayments", "typeName": "Integer", "summary": "0", "hasChildren": false },
  { "name": "CustomerName", "typeName": "Text[100]", "summary": "'Kontorcentralen A/S'", "hasChildren": false },
  { "name": "Remainder", "typeName": "Decimal", "summary": "2500.75", "hasChildren": false },
  { "name": "PerPayment", "typeName": "Decimal", "summary": "0", "hasChildren": false }
]
```

Live locals at the exact moment of the error: `NumberOfPayments` really is `0`, the
smoking gun, right there in the variable list.

```json
// debug_eval { "frameId": 0, "expression": "CustomerName" }
```
```json
{ "name": "CustomerName", "typeName": "Text[100]", "summary": "'Kontorcentralen A/S'", "hasChildren": false }
```

```json
// debug_eval { "frameId": 0, "expression": "NumberOfPayments" }
```
```json
{ "name": "NumberOfPayments", "typeName": "Integer", "summary": "0", "hasChildren": false }
```

Watch evaluation confirms both directly, no need to hunt through the variable tree.

### 6. Register the file/line breakpoint — now that the session is live

```json
// debug_breakpoints { "add": [{ "file": "src/DemoPayment.Codeunit.al", "line": 9 }] }
```

```json
{
  "added": [
    { "breakpointId": 2847748271424667600, "file": "src/DemoPayment.Codeunit.al", "line": 9 }
  ],
  "removed": []
}
```

`line: 9`, not `10` — see "What we found the hard way" below for why.

### 7. Continue — the breakpoint fires cleanly on the second test

```json
// debug_continue { "action": "continue" }
```
```json
{ "ok": true }
```

```json
// debug_wait { "timeoutMs": 60000 }
```

```json
{
  "kind": "break",
  "objectType": 5,
  "objectId": 50130,
  "line": 9,
  "stack": [
    {
      "objectType": 5,
      "objectId": 50130,
      "objectName": "Demo Payment Split",
      "methodName": "SplitAmount",
      "line": 9,
      "file": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug\\src\\DemoPayment.Codeunit.al"
    },
    {
      "objectType": 5,
      "objectId": 50131,
      "objectName": "Demo Payment Tests",
      "methodName": "SplitsEvenly",
      "line": 25,
      "file": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug\\src\\DemoPaymentTests.Codeunit.al"
    }
  ],
  "file": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug\\src\\DemoPayment.Codeunit.al"
}
```

No `errorMessage` this time — this is a genuine file/line breakpoint hit, not an error
pause. `SplitsEvenly` called `SplitAmount(1200, 4)` and execution stopped **before** the
division ran.

### 8. Live state, a watch eval edge case, and single-stepping

```json
// debug_variables { "frameId": 0 }
```
```json
[
  { "name": "<Globals>", "typeName": "Codeunit Demo Payment Split (50130)", "summary": "Codeunit Demo Payment Split (50130)", "hasChildren": true },
  { "name": "TotalAmount", "typeName": "Decimal", "summary": "1200", "hasChildren": false },
  { "name": "NumberOfPayments", "typeName": "Integer", "summary": "4", "hasChildren": false },
  { "name": "CustomerName", "typeName": "Text[100]", "summary": "'Kontorcentralen A/S'", "hasChildren": false },
  { "name": "Remainder", "typeName": "Decimal", "summary": "1200", "hasChildren": false },
  { "name": "PerPayment", "typeName": "Decimal", "summary": "0", "hasChildren": false }
]
```

`PerPayment` is still `0` — the assignment on this line hasn't executed yet.

```json
// debug_eval { "frameId": 0, "expression": "TotalAmount / NumberOfPayments" }
```
```json
{ "name": "TotalAmount / NumberOfPayments", "typeName": "", "summary": "<Out Of Scope>", "hasChildren": false }
```

Recorded honestly: the watch evaluator only resolves simple identifier / member-path
expressions (like `CustomerName` above), not arbitrary AL expressions with operators —
`TotalAmount / NumberOfPayments` comes back `<Out Of Scope>` rather than `300`. (It also
left a footprint: the eventual test-run summary contains a synthetic third result with an
empty method name and the message `Element '/' is not a member of 'TotalAmount'.` — the
server parsed `/` as a member-access token. Harmless, but worth knowing if you script
around `debug_eval`.)

```json
// debug_continue { "action": "stepOver" }
```
```json
{ "ok": true }
```

```json
// debug_wait { "timeoutMs": 60000 }
```
```json
{
  "kind": "break",
  "objectType": 5,
  "objectId": 50130,
  "line": 10,
  "stack": [
    {
      "objectType": 5,
      "objectId": 50130,
      "objectName": "Demo Payment Split",
      "methodName": "SplitAmount",
      "line": 10,
      "file": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug\\src\\DemoPayment.Codeunit.al"
    },
    {
      "objectType": 5,
      "objectId": 50131,
      "objectName": "Demo Payment Tests",
      "methodName": "SplitsEvenly",
      "line": 25,
      "file": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug\\src\\DemoPaymentTests.Codeunit.al"
    }
  ],
  "file": "U:\\Git\\bc-dev-mcp\\demos\\hello-bug\\src\\DemoPayment.Codeunit.al"
}
```

One line further (wire line `10` = file line 11, `Remainder := TotalAmount -
PerPayment * NumberOfPayments;`) — `stepOver` genuinely single-steps the live session.

```json
// debug_continue { "action": "continue" }
```
```json
{ "ok": true }
```

### 9. Test run finishes

```json
// debug_wait { "timeoutMs": 60000 }
```

```json
{
  "kind": "testRunFinished",
  "results": {
    "results": [
      {
        "codeunitId": 50131,
        "method": "FailsOnZeroPayments",
        "status": "failed",
        "durationMs": 6,
        "output": "Attempted to divide by zero.\r\nAL Callstack:\r\n\"Demo Payment Split\"(CodeUnit 50130).SplitAmount line 7 - Hello Bug Demo by SShadowS version 1.0.0.0\r\n\"Demo Payment Tests\"(CodeUnit 50131).FailsOnZeroPayments line 8 - Hello Bug Demo by SShadowS version 1.0.0.0\r\n\r\n"
      },
      {
        "codeunitId": 50131,
        "method": "SplitsEvenly",
        "status": "passed",
        "durationMs": 4,
        "output": ""
      }
    ]
  }
}
```

(A third, synthetic entry with an empty method name is trimmed from the block above —
it's the `debug_eval` side effect mentioned in step 8, not a real test result. It's also
present, with a different message, in a plain non-debug `run_tests` call made earlier in
the same investigation, so it's a pre-existing quirk of the test-run summary shape, not
something this demo introduced.)

### 10. Detach

```json
// debug_detach {}
```
```json
{ "detached": true }
```

## Test results

| Method | Status | Duration | Message |
|---|---|---|---|
| FailsOnZeroPayments | **FAILED** | 6 ms | Attempted to divide by zero. |
| SplitsEvenly | **PASSED** | 4 ms | — |

## What we found the hard way

Two genuine BC28/Cronus28 platform quirks surfaced during this investigation, both
worked around above rather than papered over:

1. **`AddBreakpoint` (and `DebugAdapterConfigurationDone`) need a live session.** Calling
   `debug_attach` with `breakpoints: [...]` directly, or calling `debug_breakpoints` right
   after `debug_attach`/`debug_run_tests` with no session activity yet, fails with
   `An unexpected error occurred invoking 'AddBreakpoint' on the server.` The BC event log
   traced this to `NavTenantNotFoundException: The tenant '' was not found` — the
   debugger's tenant/company context isn't bound until the session has actually paused at
   least once. Break-on-error doesn't have this problem (it was already proven to work in
   an earlier round of testing), so the workaround here is: attach with `breakOnError`
   and no breakpoints, let the first test's runtime error bring the session "live", *then*
   register the file/line breakpoint, then continue. Once live, breakpoints registered
   for later test methods in the same run fire normally.
2. **Breakpoint `line` is 0-based**, even though nothing in the tool surface converts it.
   Break events report `"line": 9` for the statement on **file line 10** (1-based, what
   an editor shows), and a breakpoint request has to use the same convention — `line: 9`
   to land on file line 10, confirmed by single-stepping from there to `line: 10` (file
   line 11) in step 8. Worth knowing if you're scripting breakpoints from an editor's
   line number.
   Update: since this capture, the tools convert automatically — `debug_attach`/`debug_breakpoints`
   take the 1-based line you see in your editor, and break events report 1-based lines; the
   raw wire values in the transcript above predate that fix.

Also recorded honestly rather than silently avoided: `debug_eval` only resolves simple
identifier/member-path expressions, not compound AL expressions with operators (step 8).

## What this proves

- **File/line breakpoints** — a breakpoint set on a specific source line stops execution
  there, before any error, with the correct local file mapped back from the compiled
  object id (step 7).
- **Live state inspection** — locals at a paused frame, including uninitialized-vs-set
  values (`PerPayment` before/after its assignment).
- **Watch evaluation** — arbitrary identifier/member-path expressions evaluated on demand
  at a break, with an honestly-reported limitation for compound expressions.
- **Stepping** — `stepOver` genuinely advances one statement in the live session.
- **Break-on-error** — an unhandled AL runtime error (division by zero) pauses the
  debugger with the error message and full call stack, no breakpoint required.
- **Debug-a-test binding** — breakpoints and break-on-error apply to a *specific*
  `debug_run_tests` invocation via `connectionId`/`debuggingContext`, not globally.

## Cleanup

The demo app is left published on Cronus28 (`Hello Bug Demo`, publisher `SShadowS`,
version `1.0.0.0`) so this walkthrough can be re-run. To remove it:

```bash
docker exec Cronus28 powershell -command "Import-Module 'C:\Program Files\Microsoft Dynamics NAV\280\Service\Microsoft.Dynamics.Nav.Management.psm1'; Uninstall-NAVApp -ServerInstance BC -Name 'Hello Bug Demo' -Tenant default -Force; Unpublish-NAVApp -ServerInstance BC -Name 'Hello Bug Demo' -Version 1.0.0.0"
```

---
*Full transcript authenticity: captured against BC28 (Cronus28 container), 2026-07-03.
Only truncation noise was trimmed; amounts, names, and line numbers are unedited.*
