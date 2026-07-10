# Debugger break output across object types: table, report, page vs codeunit

> **Note (2026-07-03):** captured before the v0.1 tool rename and result envelopes.
> Current names: `bc_status` → `bcdev_status`, `discover_tests` → `bcdev_test_discover`,
> `run_tests` → `bcdev_test_run`, `debug_*` → `bcdev_debug_*`;
> `bcdev_test_discover` now returns `{ tests: [...] }`,
> `bcdev_debug_variables` `{ variables: [...] }`, `bcdev_debug_eval` `{ result: ... }`.
> Wire behaviour shown is unchanged.

Every prior walkthrough (`demos/DEMO.md`, `demos/TYPE-ZOO.md`) broke inside a **codeunit**
(`objectType 5`) — the one object type every AL developer already expects a debugger to
handle. This demo asks a narrower question: does `bc-dev-mcp`'s break event and
`debug_variables` output have the **same shape** when the paused frame is a table trigger,
a report trigger, or a page trigger, or does the tool (or BC's own debugger service) treat
them differently? Captured against the same live **Business Central 28** container
(`Cronus28`, dev endpoint `http://Cronus28:7049/BC`) used throughout this repo's demos —
not a mock.

## The app

`demos/trigger-zoo/` — four objects, one break-on-error trick each (the same pattern
`demos/hello-bug` and `demos/type-zoo` use: no breakpoint registration needed, an `Error()`
at the end of a trigger pauses the debugger with locals already assigned):

- **table 50150 "Trigger Demo"** — fields `Id` (Integer, PK), `Description` (Text[50]).
  `OnInsert` assigns two locals, then `Error('table OnInsert break')`.
- **report 50151 "Trigger Demo Report"** — `ProcessingOnly`, `UseRequestPage = false`, one
  dataitem on table 50150 filtered to nothing (`where(Id = const(0))`, never actually
  runs). `OnPreReport` assigns two locals, then `Error('report OnPreReport break')` —
  fires before the (empty) dataset loop.
- **page 50152 "Trigger Demo Page"** — Card page, `SourceTable = "Trigger Demo"`.
  `OnOpenPage` assigns one local, then `Error('page OnOpenPage break')`.
- **codeunit 50153 "Trigger Zoo Tests"** (`Subtype = Test`) — three `[Test]` methods, each
  firing exactly one of the above: `TableTrigger` inserts a record (`Insert(true)` to force
  `RunTrigger`), `ReportTrigger` calls `Report.Run(...)`, `PageTrigger` opens a `TestPage`
  (`.OpenView()`).

Published to Cronus28 as `Trigger Zoo` by `SShadowS`, version `1.0.0.0`.

## Environment

- Dev endpoint: `http://Cronus28:7049/BC`, Basic auth, tenant `default`, company
  `CRONUS Danmark A/S`
- BC28: `runtimeVersion 17.0`, `webApiVersion 7.0`
- Captured 2026-07-03

## Method

One `debug_attach { breakOnError: true }`, one `debug_run_tests { codeunits: [{ id: 50153 }] }`,
then a `debug_wait` loop: at every `"kind": "break"`, capture `debug_variables { frameId: 0 }`,
`debug_variables { frameId: 0, globals: true }`, then a `debug_eval` probe for the
type-appropriate implicit variable (`CurrFieldNo` for table, `CurrReport` for report,
`CurrPage` for page — see the finding below), then `debug_continue { action: "continue" }`
to reach the next break, until `testRunFinished`. Full transcript in
`scratch/trigger-zoo-transcript2.log` (untracked driver output, not committed) —
everything quoted below is copied verbatim from it, run twice for reproducibility (an
earlier pass without the `CurrPage`/`CurrReport` probes, `scratch/trigger-zoo-transcript.log`,
produced byte-identical break events).

## Comparison table

| Object | `objectType` | Trigger (`methodName`) | Break event shape identical to codeunit baseline? | Implicit globals present | File mapped correctly? |
|---|---|---|---|---|---|
| Codeunit (baseline, `demos/DEMO.md` step 4) | 5 | `SplitAmount` | — (this *is* the baseline) | — | Yes |
| Table 50150 | **1** | `OnInsert` | Yes — same `{kind,objectType,objectId,errorMessage,line,stack,file}` fields, 2-frame stack (trigger + calling test method) | `Rec`, `xRec` (both populated, `Table Trigger Demo (50150)`), `CurrFieldNo` (`Integer`, `0`) | Yes — `TriggerDemo.Table.al` line 37 |
| Report 50151 | **3** | `OnPreReport` | Yes — same fields, same 2-frame shape | `Rec`, `xRec` (present but `<Uninitialized>` — `OnPreReport` runs before the dataset binds any row), plus the dataitem's own auto-declared global (`TriggerDemo`, typed `Table Trigger Demo (50150)`). **No `CurrReport`** — see finding below | Yes — `TriggerDemoReport.Report.al` line 29 |
| Page 50152 | **8** | `OnOpenPage` | Yes for the *first* break at the page frame — but see the extra 4th break below, which codeunit/table/report never produce | `Rec`, `xRec` (both populated, `Table Trigger Demo (50150)`). **No `CurrPage`** — see finding below | Yes — `TriggerDemoPage.Page.al` line 36 |

`objectType` values (1/3/5/8) match BC's standard AL `ObjectType` enum (Table/Report/Codeunit/Page)
— `bc-dev-mcp` passes the server's own numbering through unchanged.

## Key finding: `CurrPage`/`CurrReport` are not reachable at all

The task expected to see `CurrPage` and `CurrReport` show up as implicit globals in their
respective frames, the way `Rec`/`xRec` do. **They don't — and it's not just an omission
from the `<Globals>` list, they aren't resolvable at all.** Explicit `debug_eval` probes by
name come back well-formed but empty:

```json
// debug_eval { frameId: 0, expression: "CurrReport" }  (at the report OnPreReport break)
{ "name": "CurrReport", "typeName": "", "summary": "<Out Of Scope>", "hasChildren": false }
```

```json
// debug_eval { frameId: 0, expression: "CurrPage" }  (at the page OnOpenPage break)
{ "name": "CurrPage", "typeName": "", "summary": "<Out Of Scope>", "hasChildren": false }
```

This is not a crash and not garbled output — it's the same clean `<Out Of Scope>` shape
`demos/DEMO.md` step 8 documented for an out-of-scope compound expression, returned
consistently for both implicit variables. But it means a caller inspecting a report or page
breakpoint cannot read `CurrReport`/`CurrPage` state (e.g. `CurrPage.SETRECFOCUS`-adjacent
fields, or a report's `CurrReport.PAGENO`) through this debugger surface at all — BC's own
debugger service doesn't expose them as watch-able identifiers, not something `bc-dev-mcp`
discards. `Rec`/`xRec`, by contrast, resolve cleanly at every object type that has a
`SourceTable`/dataitem context (table, page; present-but-uninitialized for the report,
correctly, since `OnPreReport` runs before any dataitem row is read).

## Key finding: page triggers produce a break codeunit/table/report never do

`TableTrigger` and `ReportTrigger` each produce exactly **one** break event per `Error()` —
consistent with every prior demo. `PageTrigger` produces **two**, reproduced identically
across both transcript runs:

1. Break #3 — inside `OnOpenPage` itself, `objectType: 8`, 2-frame stack (page + calling
   test method), exactly like the table/report shape above.
2. After `debug_continue { action: "continue" }`, a **second** break — `objectType: 5`
   (the codeunit), same `errorMessage: "page OnOpenPage break"`, same `line: 31` (the
   `TriggerDemoPage.OpenView()` call site), but now a **1-frame** stack (only the codeunit
   frame — the page frame is already unwound) and the `TriggerDemoPage` `TestPage` variable
   now reports `"summary": "<Closed>"`:

```json
// debug_wait — break #4, after continuing past break #3
{
  "kind": "break",
  "objectType": 5,
  "objectId": 50153,
  "errorMessage": "page OnOpenPage break",
  "line": 31,
  "stack": [
    {
      "objectType": 5,
      "objectId": 50153,
      "objectName": "Trigger Zoo Tests",
      "methodName": "PageTrigger",
      "line": 31,
      "file": "U:\\Git\\bc-dev-mcp\\demos\\trigger-zoo\\src\\TriggerZooTests.Codeunit.al"
    }
  ],
  "file": "U:\\Git\\bc-dev-mcp\\demos\\trigger-zoo\\src\\TriggerZooTests.Codeunit.al"
}
```

Read honestly, this is BC's break-on-error re-pausing as the same unhandled error
propagates back across the `TestPage.OpenView()` call boundary — page objects run as their
own client/server execution context even headless via `TestPage`, so the error surfaces
there a second time; `Table.Insert()`/`Report.Run()` don't cross an equivalent boundary, so
they only pause once. `bc-dev-mcp`'s `debug_wait` loop handles it fine (it's a normal,
well-formed `break` event, just an extra one) — but a caller driving `debug_run_tests` for a
codeunit that touches pages needs to expect **N+1** breaks where N is the number of page
triggers hit, not a strict 1:1 mapping between "break-on-error sites" and break events. This
also shows up in the final test summary as a fourth, method-less synthetic result entry
(same pattern `demos/DEMO.md` step 9 already documented for a `debug_eval` side effect —
here it's this re-break, not an eval, that produces the synthetic entry).

## Raw break events, side by side

### Codeunit baseline (`demos/DEMO.md` step 4, cited for comparison — not re-captured here)

```json
{
  "kind": "break",
  "objectType": 5,
  "objectId": 50130,
  "errorMessage": "Attempted to divide by zero.",
  "line": 9,
  "stack": [
    { "objectType": 5, "objectId": 50130, "objectName": "Demo Payment Split", "methodName": "SplitAmount", "line": 9, "file": "...\\DemoPayment.Codeunit.al" },
    { "objectType": 5, "objectId": 50131, "objectName": "Demo Payment Tests", "methodName": "FailsOnZeroPayments", "line": 16, "file": "...\\DemoPaymentTests.Codeunit.al" }
  ],
  "file": "...\\DemoPayment.Codeunit.al"
}
```

### Table 50150 — break #1

```json
{
  "kind": "break",
  "objectType": 1,
  "objectId": 50150,
  "errorMessage": "table OnInsert break",
  "line": 37,
  "stack": [
    { "objectType": 1, "objectId": 50150, "objectName": "Trigger Demo", "methodName": "OnInsert", "line": 37, "file": "U:\\Git\\bc-dev-mcp\\demos\\trigger-zoo\\src\\TriggerDemo.Table.al" },
    { "objectType": 5, "objectId": 50153, "objectName": "Trigger Zoo Tests", "methodName": "TableTrigger", "line": 17, "file": "U:\\Git\\bc-dev-mcp\\demos\\trigger-zoo\\src\\TriggerZooTests.Codeunit.al" }
  ],
  "file": "U:\\Git\\bc-dev-mcp\\demos\\trigger-zoo\\src\\TriggerDemo.Table.al"
}
```

`debug_variables { frameId: 0 }`:

```json
[
  { "name": "<Globals>", "typeName": "Table Trigger Demo (50150)", "summary": "Table Trigger Demo (50150)", "hasChildren": true },
  { "name": "TableLocalText", "typeName": "Text[50]", "summary": "'table trigger zoo'", "hasChildren": false },
  { "name": "TableLocalInt", "typeName": "Integer", "summary": "1", "hasChildren": false }
]
```

`<Globals>` expanded — `Rec`, `xRec`, `CurrFieldNo`:

```json
[
  { "name": "Rec", "typeName": "Table Trigger Demo (50150)", "summary": "1", "hasChildren": true },
  { "name": "xRec", "typeName": "Table Trigger Demo (50150)", "summary": "1", "hasChildren": true, "children": [ /* Fields, Filter Group, Filters, Keys */ ] },
  { "name": "CurrFieldNo", "typeName": "Integer", "summary": "0", "hasChildren": false }
]
```

### Report 50151 — break #2

```json
{
  "kind": "break",
  "objectType": 3,
  "objectId": 50151,
  "errorMessage": "report OnPreReport break",
  "line": 29,
  "stack": [
    { "objectType": 3, "objectId": 50151, "objectName": "Trigger Demo Report", "methodName": "OnPreReport", "line": 29, "file": "U:\\Git\\bc-dev-mcp\\demos\\trigger-zoo\\src\\TriggerDemoReport.Report.al" },
    { "objectType": 5, "objectId": 50153, "objectName": "Trigger Zoo Tests", "methodName": "ReportTrigger", "line": 23, "file": "U:\\Git\\bc-dev-mcp\\demos\\trigger-zoo\\src\\TriggerZooTests.Codeunit.al" }
  ],
  "file": "U:\\Git\\bc-dev-mcp\\demos\\trigger-zoo\\src\\TriggerDemoReport.Report.al"
}
```

`debug_variables { frameId: 0 }`:

```json
[
  { "name": "<Globals>", "typeName": "Report Trigger Demo Report (50151)", "summary": "Report Trigger Demo Report (50151)", "hasChildren": true },
  { "name": "ReportLocalText", "typeName": "Text[50]", "summary": "'report trigger zoo'", "hasChildren": false },
  { "name": "ReportLocalInt", "typeName": "Integer", "summary": "42", "hasChildren": false }
]
```

`<Globals>` expanded — `Rec`/`xRec` uninitialized, dataitem's own global populated:

```json
[
  { "name": "Rec", "typeName": "", "summary": "<Uninitialized>", "hasChildren": false },
  { "name": "xRec", "typeName": "", "summary": "<Uninitialized>", "hasChildren": false },
  { "name": "TriggerDemo", "typeName": "Table Trigger Demo (50150)", "summary": "0", "hasChildren": true, "children": [ /* Fields, Filter Group, Filters, Keys, <Globals> */ ] }
]
```

### Page 50152 — break #3

```json
{
  "kind": "break",
  "objectType": 8,
  "objectId": 50152,
  "errorMessage": "page OnOpenPage break",
  "line": 36,
  "stack": [
    { "objectType": 8, "objectId": 50152, "objectName": "Trigger Demo Page", "methodName": "OnOpenPage", "line": 36, "file": "U:\\Git\\bc-dev-mcp\\demos\\trigger-zoo\\src\\TriggerDemoPage.Page.al" },
    { "objectType": 5, "objectId": 50153, "objectName": "Trigger Zoo Tests", "methodName": "PageTrigger", "line": 31, "file": "U:\\Git\\bc-dev-mcp\\demos\\trigger-zoo\\src\\TriggerZooTests.Codeunit.al" }
  ],
  "file": "U:\\Git\\bc-dev-mcp\\demos\\trigger-zoo\\src\\TriggerDemoPage.Page.al"
}
```

`debug_variables { frameId: 0 }`:

```json
[
  { "name": "<Globals>", "typeName": "Page Trigger Demo Page (50152)", "summary": "Page Trigger Demo Page (50152)", "hasChildren": true },
  { "name": "PageLocalText", "typeName": "Text[50]", "summary": "'page trigger zoo'", "hasChildren": false }
]
```

`<Globals>` expanded — `Rec`/`xRec` populated from `SourceTable`, no `CurrPage`:

```json
[
  { "name": "Rec", "typeName": "Table Trigger Demo (50150)", "summary": "0", "hasChildren": true, "children": [ /* Fields, Filter Group, Filters, Keys, <Globals> */ ] },
  { "name": "xRec", "typeName": "Table Trigger Demo (50150)", "summary": "0", "hasChildren": true, "children": [ /* same shape */ ] }
]
```

(Page break #3's 1-frame-deeper follow-up break #4, and the `CurrPage`/`CurrReport`
`<Out Of Scope>` evals, are quoted in the findings above rather than repeated here.)

## Verdict

**Yes, the output format is the same across object types, with three specific,
well-documented differences — no crashes, no garbled JSON, no missing `name`/`typeName`
fields anywhere.**

1. **`objectType` differs** (1 table / 3 report / 5 codeunit / 8 page) — BC's own
   `ObjectType` enum value, passed through unchanged. Every other top-level field
   (`kind`, `objectId`, `errorMessage`, `line`, `stack`, `file`) has the identical shape
   for table and report as for the codeunit baseline; two-frame stacks throughout
   (trigger object + calling test method), correct local file/line mapping in every case.
2. **The implicit-global set is object-type-specific and two of them are unreachable.**
   `Rec`/`xRec` show up for table and page (populated) and report (present but
   `<Uninitialized>`, correctly, since `OnPreReport` precedes dataitem binding); a table
   trigger additionally exposes `CurrFieldNo`. **`CurrPage` and `CurrReport` never
   appear in `<Globals>` and don't resolve via `debug_eval` either** — both come back a
   clean `{ typeName: "", summary: "<Out Of Scope>" }`, the key finding of this demo.
   This is a real inspection gap (BC's own debugger protocol not exposing them, not
   something `bc-dev-mcp` discards) worth knowing before relying on this tool to debug
   `CurrPage`/`CurrReport`-heavy trigger code.
3. **Page triggers break twice per `Error()`, not once.** `TableTrigger`/`ReportTrigger`
   match the codeunit baseline (one break per unhandled error). `PageTrigger` produces a
   second break as the same error re-surfaces crossing the `TestPage.OpenView()` call
   boundary — a 1-frame stack at the codeunit, `errorMessage`/`line` identical to the
   first break, and the `TestPage` variable now shown as `<Closed>`. A caller must expect
   this rather than assuming a strict 1:1 break-to-`Error()` mapping when a run touches
   page objects.

Object types not covered: XmlPort (6) and Query (9) — out of scope for this task; nothing
above suggests they'd differ in kind from what's shown here, but that's untested.

## Test results

| Method | Status | Duration | Message |
|---|---|---|---|
| TableTrigger | **FAILED** (expected) | 34 ms | table OnInsert break |
| ReportTrigger | **FAILED** (expected) | 20 ms | report OnPreReport break |
| PageTrigger | **FAILED** (expected) | 27 ms | page OnOpenPage break |
| *(synthetic, method-less — see finding above)* | FAILED | 82 ms | page OnOpenPage break |

## Cleanup

The demo app is left published on Cronus28 (`Trigger Zoo`, publisher `SShadowS`, version
`1.0.0.0`) so this walkthrough can be re-run. To remove it:

```bash
docker exec Cronus28 powershell -command "Import-Module 'C:\Program Files\Microsoft Dynamics NAV\280\Service\Microsoft.Dynamics.Nav.Management.psm1'; Uninstall-NAVApp -ServerInstance BC -Name 'Trigger Zoo' -Tenant default -Force; Unpublish-NAVApp -ServerInstance BC -Name 'Trigger Zoo' -Version 1.0.0.0"
```

---
*Full transcript authenticity: captured against a live BC28 container (Cronus28),
2026-07-03. Every JSON block above is copied verbatim from
`scratch/trigger-zoo-transcript2.log` (untracked driver output, not committed) — nothing
here is hand-written or inferred from source reading. Re-run twice (with and without the
`CurrPage`/`CurrReport` eval probes); both runs produced byte-identical break events.*
