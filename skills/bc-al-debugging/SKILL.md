---
name: bc-al-debugging
description: Interactively debug AL code on a Business Central server with the bc-dev-mcp tools — attach, breakpoints, break-on-error, step, inspect variables and watches during a test run. Use when asked to debug AL code, find why an AL test fails, or inspect live state on a BC server.
---

# Debugging AL on Business Central

## The loop

1. `bcdev_debug_attach { breakOnError: true }` — arm the next WebClient session WITHOUT
   file/line breakpoints (see "session must pause first" below). To filter that next session,
   add `userId`; to attach to a known active NST session, add its positive `sessionId` instead.
   The selectors are mutually exclusive, and exact `sessionId` targeting takes precedence over
   `breakOnNext`. One debugger at a time; `bcdev_debug_detach` before re-attaching.
2. `bcdev_debug_run_tests { codeunits: [{ id: <codeunitId> }] }` — starts the run bound to
   this debug session and returns immediately.
3. `bcdev_debug_wait` — long-poll for events. Attach returns before a workload binds; a successful
   bind reports `kind: sessionBound` with `sessionId` and `hostId` (the optional `hostId` may be null). **A timeout is a normal result**
   (`timedOut: true`): just call it again. Other events carry `kind`: `break`,
   `testRunFinished` (with the test results embedded), `detached`, `fatal`.
4. At a `break`: `bcdev_debug_variables { frameId: 0 }` for locals,
   `bcdev_debug_eval { frameId: 0, expression: "..." }` for watches,
   `bcdev_debug_breakpoints { add: [...] }` to place file/line breakpoints.
5. `bcdev_debug_continue { action: "continue" | "stepOver" | "stepInto" | "stepOut" }`,
   then `bcdev_debug_wait` again.
6. `bcdev_debug_detach` when done.

## Facts that save you time

- **Choose one targeting mode.** Omit both selectors for the next client of `breakOnNext` type;
  use `userId` for the next matching client owned by that user; use `sessionId` only when you
  already know the positive ID of an active NST session. Arm next-session/user-filtered attach
  before triggering the workload. A warning-form `sessionBound` with null identity means only
  correlation metadata failed — debugging remains active.
- If a user-filtered attach reports `fatal` before `sessionBound`, Business Central rejected the
  user filter. The client tears down that debugger and does not bind or deliver breaks; fix the
  user ID or permissions before retrying.
- **Session must pause once before breakpoints bind.** `AddBreakpoint` fails server-side
  ("tenant '' not found") until the session has paused at least once. That is why you
  attach with `breakOnError: true` and add breakpoints at the first break. Once the
  session is live, breakpoints added for later code in the same run fire normally.
- **Line numbers are 1-based** everywhere in these tools — use the line you see in your
  editor. (The BC wire is 0-based; conversion is internal.)
- **Check breakpoint verification.** Each added breakpoint returns `verification.status`.
  `verified` means the server accepted the requested line, `relocated` means it moved to the
  returned 1-based span, and `unverified` means this server returned only a usable breakpoint ID.
  Use the returned span rather than assuming the requested line will fire.
- **Watch expressions are paths, not code.** `bcdev_debug_eval` resolves identifier /
  member paths only (`CustomerName`, `Customer."No."`). Operators come back
  `<Out Of Scope>` — and leave a synthetic empty-method entry in the test-run summary.
- **Variable expansion:** nodes with `hasChildren: true` expand via
  `bcdev_debug_variables { frameId, expand: "<dot-joined path>" }`, e.g. `"Customer"` or
  `"Customer.Fields"`. Globals live under the `<Globals>` node (or pass
  `globals: true`).
- **Variable changes come from Business Central.** Each variable/watch node has `changeState`
  (`unchanged`, `new`, `valueChanged`, `descendantChanged`, or `unknown`) and `changed` is true
  for the three changed states. On a first read, or when the server omits the wire flag,
  `unknown` is not proof that a value stayed the same.
- **Pages double-break:** page triggers fire twice per interaction on BC28 — expect two
  identical breaks, continue through the second.
- **Test results arrive on the `testRunFinished` event** from `bcdev_debug_wait`, not from
  `bcdev_debug_run_tests` (which only starts the run).
- `break` events map object IDs back to local `.al` files (`file` on the event and each
  stack frame) when the objects exist in the project.
- **A break frame with no local `file`** (third-party extension, generated object) is readable
  anyway: `bcdev_source { objectType, objectId }` fetches the server's deployed source. Empty
  content with `isAlContent: false` means the object ships without source (base application).
- **SQL triage:** attach with `sqlInsight: true` (optionally `longRunningSqlThresholdMs`), then
  at each break `bcdev_debug_sql` returns current latency, execute count, and the last SQL
  statements with duration and approximate rows read. It errors if insight was not enabled at
  attach — the option cannot be turned on mid-session.
- **abort vs release at a break** (both end debugging with a `detached` event): `abort` kills
  the paused operation — a bound test run records it as failed; `release` lets it finish
  undebugged — a passing test still passes. Neither leaves a reusable session: a debug-bound
  test session ends with its run, so re-attach fresh instead of exact-targeting the old ID.
- **Precision breaks:** `breakOnError: "unhandled"` skips errors a try function catches and
  still breaks on uncaught ones; `breakOnRecordWrite: "nonTemporary"` skips temporary-record
  writes and still breaks on real-table writes.
- **Responses guide the loop.** Every successful tool result includes `nextSteps` (possibly
  empty for terminal results). MCP errors have `isError: true`, no `structuredContent`, and a
  JSON text body with stable `error.code`, `retryable`, redacted detail, and recovery steps.
