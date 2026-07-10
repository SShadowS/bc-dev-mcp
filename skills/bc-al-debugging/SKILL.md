---
name: bc-al-debugging
description: Interactively debug AL code on a Business Central server with the bc-dev-mcp tools — attach, breakpoints, break-on-error, step, inspect variables and watches during a test run. Use when asked to debug AL code, find why an AL test fails, or inspect live state on a BC server.
---

# Debugging AL on Business Central

## The loop

1. `bcdev_debug_attach { breakOnError: true }` — attach WITHOUT file/line breakpoints (see
   "session must pause first" below). One session at a time; `bcdev_debug_detach` before
   re-attaching.
2. `bcdev_debug_run_tests { codeunits: [{ id: <codeunitId> }] }` — starts the run bound to
   this debug session and returns immediately.
3. `bcdev_debug_wait` — long-poll for events. **A timeout is a normal result** (`timedOut:
   true`): just call it again. Real events carry `kind`: `break`, `testRunFinished`
   (with the test results embedded), `detached`, `fatal`.
4. At a `break`: `bcdev_debug_variables { frameId: 0 }` for locals,
   `bcdev_debug_eval { frameId: 0, expression: "..." }` for watches,
   `bcdev_debug_breakpoints { add: [...] }` to place file/line breakpoints.
5. `bcdev_debug_continue { action: "continue" | "stepOver" | "stepInto" | "stepOut" }`,
   then `bcdev_debug_wait` again.
6. `bcdev_debug_detach` when done.

## Facts that save you time

- **Session must pause once before breakpoints bind.** `AddBreakpoint` fails server-side
  ("tenant '' not found") until the session has paused at least once. That is why you
  attach with `breakOnError: true` and add breakpoints at the first break. Once the
  session is live, breakpoints added for later code in the same run fire normally.
- **Line numbers are 1-based** everywhere in these tools — use the line you see in your
  editor. (The BC wire is 0-based; conversion is internal.)
- **Watch expressions are paths, not code.** `bcdev_debug_eval` resolves identifier /
  member paths only (`CustomerName`, `Customer."No."`). Operators come back
  `<Out Of Scope>` — and leave a synthetic empty-method entry in the test-run summary.
- **Variable expansion:** nodes with `hasChildren: true` expand via
  `bcdev_debug_variables { frameId, expand: "<dot-joined path>" }`, e.g. `"Customer"` or
  `"Customer.Fields"`. Globals live under the `<Globals>` node (or pass
  `globals: true`).
- **Pages double-break:** page triggers fire twice per interaction on BC28 — expect two
  identical breaks, continue through the second.
- **Test results arrive on the `testRunFinished` event** from `bcdev_debug_wait`, not from
  `bcdev_debug_run_tests` (which only starts the run).
- `break` events map object IDs back to local `.al` files (`file` on the event and each
  stack frame) when the objects exist in the project.
