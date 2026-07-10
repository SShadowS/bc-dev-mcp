# Variable Type Zoo: full AL type coverage for the live debugger

> **Note (2026-07-03):** captured before the v0.1 tool rename and result envelopes.
> Current names: `bc_status` → `bcdev_status`, `discover_tests` → `bcdev_test_discover`,
> `run_tests` → `bcdev_test_run`, `debug_*` → `bcdev_debug_*`;
> `bcdev_test_discover` now returns `{ tests: [...] }`,
> `bcdev_debug_variables` `{ variables: [...] }`, `bcdev_debug_eval` `{ result: ... }`.
> Wire behaviour shown is unchanged.

This is a full, unedited walkthrough proving `bc-dev-mcp`'s debugger tools
(`debug_variables`, `debug_eval`) correctly parse **every major AL variable type** —
including the reference types (`Record`, `RecordRef`, `FieldRef`, `KeyRef`) and nested
expansion (collections, `Variant` unwrapping, table globals) — against a **real**
Business Central 28 container (`Cronus28`, dev endpoint `http://Cronus28:7049/BC`), the
same one used in `demos/hello-bug`.

`demos/hello-bug` proved the debugger's control flow (attach, breakpoints, step,
break-on-error). This demo is narrower and deeper: one break, every type in scope at
once, every `hasChildren: true` node expanded (and one level further where still
expandable), checking whether `normalizeKeys` + the `LocalNode` → `VariableNode` mapping
in `src/core/hubs/debugger-hub.ts` produces a clean `{ name, typeName, summary,
hasChildren, children }` for all of them, or whether any type comes back with a missing
name, a garbled summary, unparsable children, or a crash.

## The app

`demos/type-zoo/` — codeunit 50140 "Type Zoo", one `[Test] procedure ShowAllTypes()`.
It declares and assigns one local of every type below, opens and reads a real CRONUS
customer record (`Customer.FindFirst()` → `'10000'`, "Customer Card"), derives a
`RecordRef`/`FieldRef`/`KeyRef` from it, populates every collection, and — as the very
last line — calls `Error('type zoo ready')`. That deliberate error, combined with
`debug_attach { breakOnError: true }`, pauses the debugger with every local already
assigned and in scope, with no breakpoint registration needed at all (the same trick
`demos/hello-bug` uses, and for the same reason: `AddBreakpoint` needs a session that has
already bound to a live tenant/company context, which a break-on-error gives you for
free).

Published to Cronus28 as `Variable Type Zoo` by `SShadowS`, version `1.0.0.0`.

## Environment

- Dev endpoint: `http://Cronus28:7049/BC`, Basic auth, tenant `default`, company
  `CRONUS Danmark A/S`
- BC28: `28.0.46665.50383`, `runtimeVersion 17.0`
- Captured 2026-07-03

## Result table

Every declared local, exactly as returned by `debug_variables { frameId: 0 }` at the
break (simple types) or by its `expand` (complex types). "Parsed OK?" means: valid JSON
node, non-empty `name`, no thrown error, no garbled/truncated `children` — **not** a
judgment about whether BC's own debugger chose a good `typeName`/`summary` (see the
verdict section for the two cosmetic quirks that fall in that gap).

| AL type | example value | `debug_variables` summary | `typeName` | `hasChildren` | Parsed OK? |
|---|---|---|---|---|---|
| Integer | `42` | `42` | `Integer` | false | Yes |
| BigInteger | `2147483647 * 1000` | `2147483647000` | `BigInteger` | false | Yes |
| Decimal | `1234.5678` | `1234.5678` | `Decimal` | false | Yes |
| Boolean | `true` | `True` | `Boolean` | false | Yes |
| Byte | `255` | `255 (' ')` | `Byte` | false | Yes (BC renders the char glyph next to the byte value; codepoint 255 shows as a blank glyph — cosmetic, not a parse issue) |
| Char | `65` | `A` | `Char` | false | Yes |
| Text | `'Zoo unbounded text value'` | `'Zoo unbounded text value'` | `Text` | false | Yes |
| Text[50] | `'Zoo fifty-char text field example value'` | same, quoted | `Text[50]` | false | Yes |
| Code[20] | `'ZOOCODE001'` | `'ZOOCODE001'` | `Code[20]` | false | Yes |
| Date | `DMY2Date(3,7,2026)` | `07/03/26` | `Date` | false | Yes |
| Time | `143045T` | ` 2:30:45 PM` | `Time` | false | Yes |
| DateTime | `CreateDateTime(...)` | `07/03/26 02:30:45 PM` | `DateTime` | false | Yes |
| Duration | DateTime subtraction | `2 days 14 hours 30 minutes 45 seconds` | `Duration` | false | Yes |
| Guid | `CreateGuid()` | `f13196f5-d6ba-49cb-814c-bd4117595256` | `GUID` | false | Yes |
| Option (inline `Red,Green,Blue`) | `::Green` | `Green` | `Option` | false | Yes |
| Enum "Type Zoo Color" | `::Blue` | `Blue` | `Option` **(see verdict)** | false | Yes — parses cleanly, but see note below |
| Record (Customer) | `Customer.FindFirst()` | `'10000'` | `Table Customer (18)` | true | Yes — expands to `Fields`/`Filter Group`/`Filters`/`Keys`/`<Globals>` |
| RecordRef | `RecRef.GetTable(Customer)` | `'10000'` | `Table Customer (18)` | true | Yes — identical shape to Record |
| FieldRef | `RecRef.Field(1)` | `10000` | `FieldRef Customer.No. (Table 18)` | true | Yes — expands to `Field` (`'Customer."No.":Code[20]'`) and `Value` (`'10000'`) |
| KeyRef | `RecRef.KeyIndex(1)` | `Field1` | `KeyRef Table Customer (18)` | true | Yes, but expand returns `[]` — see verdict |
| List of [Text] | 3 items added | `null` at top level | `LIST OF [Text]` | true | Yes — expands to `[1]`/`[2]`/`[3]` with correct values |
| Dictionary of [Text, Integer] | 3 entries added | `null` at top level | `DICTIONARY OF [Text, Integer]` | true | Yes — expands to `['one']`/`['two']`/`['three']` with correct values |
| array[3] of Integer | `[111,222,333]` | `null` at top level | `ARRAY[3] OF Integer` | true | Yes — expands to `[1]`/`[2]`/`[3]` |
| JsonObject | 2 properties added | `{"appName":"Type Zoo","version":1}` | `JsonObject` | **false** | Yes — but see verdict: no structured children at all, whole thing flattened into the summary string |
| JsonToken | `JObj.Get('appName', tok)` | `"Type Zoo"` | `JsonToken` | true | Yes — expands to `IsArray`/`IsObject`/`IsValue` booleans |
| JsonValue | `tok.AsValue()` | `"Type Zoo"` | `JsonValue` | false | Yes |
| Codeunit "Temp Blob" | (holds streamed content) | `Codeunit Temp Blob (4100)` | `Codeunit Temp Blob (4100)` | true | Yes — expands to `<Globals>` → nested `Codeunit Temp Blob Impl. (4107)` |
| InStream | `TempBlob.CreateInStream(...)` | `InStream` | `InStream` | false | Yes |
| OutStream | `TempBlob.CreateOutStream(...)` | `OutStream` | `OutStream` | false | Yes |
| Variant (holding a Record) | `ZooVariant := Customer` | `'10000'` | `Variant (NavRecordHandle)` | true | Yes — expands to `InnerValue`, itself a full `Table Customer (18)` node |
| DateFormula | `Evaluate(df, '<1M+15D>')` | `1M+15D` | `DateFormula` | false | Yes |

**Not implemented** (per the task's own priority note — these two aren't real
declarable AL local-variable types in a modern per-tenant extension, only table-field or
legacy C/AL concepts):
- `BigText` — a C/AL-era type; not available as an AL variable type in this compiler.
- `Blob` — `BLOB` is a table *field* type only, never a standalone local variable type.
  Demonstrated instead via `Codeunit "Temp Blob"` + `InStream`/`OutStream` above, which is
  the actual modern AL replacement.

## Verdict: does the parser handle every type cleanly?

**Yes for every real AL type tested — nothing crashed, nothing came back with a missing
name or unparsable children.** `debug_variables`, its `expand`/`globals` modes, and
`debug_eval` all produced well-formed `{ name, typeName, summary, hasChildren, children? }`
objects for all 31 locals above, at every expansion depth exercised (top level → child →
grandchild, e.g. `RecRef` → `Fields` → all 185 individual `Table Customer` field nodes,
correctly typed and valued).

Four things are worth flagging, in descending order of how much they'd surprise a caller
— none of them are crashes, all of them are either genuine BC28 debugger-protocol
behavior faithfully passed through, or a minor type-contract gap in the mapping code:

1. **`typeName: null` for synthetic grouping nodes.** Expanding any `Record`/`RecordRef`
   produces a `Fields` pseudo-node (`"summary": "Count = 185"`) whose wire `TypeName` is
   a literal JSON `null`, not a string. `WireLocalNode.typeName` and `VariableNode.typeName`
   in `src/core/hubs/debugger-hub.ts` are both typed as plain `string` — the mapping
   (`toVariableNode`) passes the value through unchanged, so the declared TypeScript
   contract is violated at runtime (harmless today — nothing in this codebase calls
   `.typeName.something()` — but a consumer written against the documented `string` type
   would NPE). The sibling `Keys` and `<Globals>` pseudo-nodes get `typeName: ""` instead
   of `null` for the same kind of node — the empty-string/`null` choice isn't even
   consistent between them. Confirmed at three call sites: `Customer`, `RecRef`, and
   `ZooVariant.InnerValue` (a `Variant` unwrapped to the same `Record`) all reproduce it
   identically, so it's a stable BC-side behavior, not a fluke.
2. **`hasChildren: true` that expands to `[]`.** Two cases: the top-level `<Globals>` node
   for a codeunit with no actual global variables (`Type Zoo` has none — everything here
   is local) and `KeyRef` (`RecRf.KeyIndex(1)`) both report `hasChildren: true` but their
   expansion is an empty array. Not garbled — a well-formed empty list — but a caller
   gating "should I call expand?" purely on `hasChildren` will make a wasted round trip
   and may reasonably suspect a parse failure when children come back empty. It's BC's
   debugger service claiming expandability universally for these two node kinds
   regardless of actual content.
3. **`Enum` reports `typeName: "Option"`, indistinguishable from a real inline `Option`.**
   `ZooEnum: Enum "Type Zoo Color"` and `ZooOption: Option Red,Green,Blue` both come back
   with `typeName: "Option"` — from both `debug_variables` and `debug_eval`, so it's
   consistent, not a one-off. The `summary` (`Blue` vs `Green`) is correct and
   distinguishes the *value*, but nothing in the node distinguishes "this is an enum of
   type `Type Zoo Color`" from "this is a page-local option list" — that's BC28's own
   debugger wire protocol collapsing the two, not something `bc-dev-mcp` discards.
4. **`JsonObject` is not expandable at all.** Given `hasChildren: false` and its entire
   content flattened into `summary` as a JSON string
   (`{"appName":"Type Zoo","version":1}`). This is a legitimate surprise against the task's
   own expectation going in (that `JsonObject` would behave like `Record`/collections and
   expose per-property children) — it doesn't; BC's debugger treats it as an opaque
   leaf and relies on the serialized-JSON summary for all inspection. `JsonToken`, by
   contrast, *is* expandable (into `IsArray`/`IsObject`/`IsValue` — metadata about the
   token, not a way to drill into an object's properties either).

**Bottom line for "will this handle my variables":** if your breakpoint's locals include
`Record`, `RecordRef`, `FieldRef`, collections, `Variant`, or any of the simple types in
the table above, `debug_variables`/`debug_eval` will give you a complete, correctly
nested, non-crashing picture — including drilling into a `Variant`'s actual held type and
a `Record`'s own table-level global variables. The one place to build in a small amount of
defensiveness in a client is the `typeName: null` case for the `Fields` pseudo-node (treat
missing `typeName` as `""` before formatting) — nothing else needs a workaround.

## Notable expansions (verbatim)

### RecordRef → FieldRef, via the same customer row

```json
// debug_variables { frameId: 0, expand: "FldRef" }
[
  { "name": "Field", "typeName": "Text", "summary": "'Customer.\"No.\":Code[20]'", "hasChildren": false },
  { "name": "Value", "typeName": "Code[20]", "summary": "'10000'", "hasChildren": false }
]
```

### List of [Text]

```json
// debug_variables { frameId: 0, expand: "ZooTextList" }
[
  { "name": "[1]", "typeName": "Text", "summary": "'Alpha'", "hasChildren": false },
  { "name": "[2]", "typeName": "Text", "summary": "'Bravo'", "hasChildren": false },
  { "name": "[3]", "typeName": "Text", "summary": "'Charlie'", "hasChildren": false }
]
```

### Dictionary of [Text, Integer]

```json
// debug_variables { frameId: 0, expand: "ZooDict" }
[
  { "name": "['one']", "typeName": "Integer", "summary": "1", "hasChildren": false },
  { "name": "['two']", "typeName": "Integer", "summary": "2", "hasChildren": false },
  { "name": "['three']", "typeName": "Integer", "summary": "3", "hasChildren": false }
]
```

### array[3] of Integer

```json
// debug_variables { frameId: 0, expand: "ZooIntArray" }
[
  { "name": "[1]", "typeName": "Integer", "summary": "111", "hasChildren": false },
  { "name": "[2]", "typeName": "Integer", "summary": "222", "hasChildren": false },
  { "name": "[3]", "typeName": "Integer", "summary": "333", "hasChildren": false }
]
```

### Variant unwrapping a Record — two levels deep

```json
// debug_variables { frameId: 0, expand: "ZooVariant" }
[
  { "name": "InnerValue", "typeName": "Table Customer (18)", "summary": "'10000'", "hasChildren": true }
]
```

```json
// debug_variables { frameId: 0, expand: "ZooVariant.InnerValue" }  (first 3 of 5 children)
[
  { "name": "Fields", "typeName": null, "summary": "Count = 185", "hasChildren": true },
  { "name": "Filter Group", "typeName": "Integer", "summary": "0", "hasChildren": false },
  { "name": "Filters", "typeName": "Text", "summary": "", "hasChildren": false }
]
```

### Record's own `<Globals>` — one level below the record itself

`Customer.<Globals>` (i.e. `Table Customer`'s own trigger-scope global variables, not
`Type Zoo`'s) resolves to 25 entries — table references like `SalesSetup`
(`Table Sales & Receivables Setup (311)`, `<Uninitialized>`) and codeunit references like
`DimMgt` (`Codeunit DimensionManagement (408)`, `<Uninitialized>`), correctly typed even
though none of them were ever touched by this test. Confirms `<Globals>` expansion walks
the *target object's* own declared globals, not the calling codeunit's.

### JsonObject — flattened, not expandable

```json
// debug_variables { frameId: 0 }  (excerpt)
{ "name": "ZooJsonObject", "typeName": "JsonObject", "summary": "{\"appName\":\"Type Zoo\",\"version\":1}", "hasChildren": false }
```

### JsonToken — expandable, but into metadata rather than the object's properties

```json
// debug_variables { frameId: 0, expand: "ZooJsonToken" }
[
  { "name": "IsArray", "typeName": "Boolean", "summary": "False", "hasChildren": false },
  { "name": "IsObject", "typeName": "Boolean", "summary": "False", "hasChildren": false },
  { "name": "IsValue", "typeName": "Boolean", "summary": "True", "hasChildren": false }
]
```

### debug_eval cross-checks (leaf identifiers)

```json
// debug_eval { frameId: 0, expression: "ZooGuid" }
{ "name": "ZooGuid", "typeName": "GUID", "summary": "f13196f5-d6ba-49cb-814c-bd4117595256", "hasChildren": false }
```
```json
// debug_eval { frameId: 0, expression: "ZooEnum" }
{ "name": "ZooEnum", "typeName": "Option", "summary": "Blue", "hasChildren": false }
```
```json
// debug_eval { frameId: 0, expression: "ZooDateFormula" }
{ "name": "ZooDateFormula", "typeName": "DateFormula", "summary": "1M+15D", "hasChildren": false }
```

`debug_eval { frameId: 0, expression: "RecRef" }` is worth calling out structurally: unlike
`debug_variables`/`expand`, which return one level of children at a time, `GetWatchNode`
(the wire method behind `debug_eval`) returns the **entire nested tree already populated**
— `RecRef`'s response includes its full `Fields` array (all 185 fields) inline, no further
`expand` calls needed. Handy for a one-shot watch, expensive if you only wanted the top
node.

## Test result

| Method | Status | Duration | Message |
|---|---|---|---|
| ShowAllTypes | **FAILED** (expected — deliberate `Error`) | 173 ms | `type zoo ready` |

## Cleanup

The demo app is left published on Cronus28 (`Variable Type Zoo`, publisher `SShadowS`,
version `1.0.0.0`) so this walkthrough can be re-run. To remove it:

```bash
docker exec Cronus28 powershell -command "Import-Module 'C:\Program Files\Microsoft Dynamics NAV\280\Service\Microsoft.Dynamics.Nav.Management.psm1'; Uninstall-NAVApp -ServerInstance BC -Name 'Variable Type Zoo' -Tenant default -Force; Unpublish-NAVApp -ServerInstance BC -Name 'Variable Type Zoo' -Version 1.0.0.0"
```

---
*Full transcript authenticity: captured against a live BC28 container (Cronus28),
2026-07-03. Every summary/typeName/hasChildren value in the table and JSON blocks above
is copied verbatim from `scratch/type-zoo-transcript.log` (untracked driver output, not
committed) — nothing here is hand-written or inferred from source reading.*
