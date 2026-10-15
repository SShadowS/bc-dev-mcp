# Debugging

## Attach and session binding

Debugger attach returns as soon as Business Central accepts the request; binding is asynchronous. With no selector it binds the next session of the `breakOnNext` client type. Pass `userId` to filter that next session by Business Central user, or pass a known positive `sessionId` to attach to an existing NST session. `sessionId` and `userId` are mutually exclusive; exact `sessionId` targeting takes precedence over `breakOnNext`. `bcdev_debug_wait` reports `{ kind: "sessionBound", sessionId, hostId }` after binding; `hostId` may be null when Business Central omits that optional field. If identity lookup fails, it reports a nonfatal warning-form `sessionBound` event and debugging remains active. If Business Central emits a fatal user-filter rejection before `sessionBound`, the debugger tears down without binding or delivering breaks and reports an actionable `fatal` event.

## Breakpoints and variables

Breakpoint additions include `verification.status` (`verified`, `relocated`, or `unverified`) and
the resolved object, method, and 1-based span when Business Central supplies them. An all-zero
wire span is the value type's unset form and remains `unverified`; it is not reported as line 1.
Variable and watch nodes include `changeState` plus the convenience boolean `changed`; `unknown`
means the server omitted or returned an unfamiliar wire value, not that the value was proven
unchanged.

## Record-write triage

Business Central's debugger enables record-write breaks globally; it does not accept a table filter.
`bcdev_record_writes_start` therefore arms one debugger session, inspects each paused
`Insert`/`Modify`/`ModifyAll`/`Rename`/`Delete`/`DeleteAll` receiver, compares its runtime numeric
table ID with `tableId`, groups exact matches by operation, receiver, and full stack, and
automatically continues. Unrelated writes are counted but not retained as writer groups.

Use `sessionId`, `userId`, or `breakOnNext` as with manual debugger attach. Temporary-record writes
are excluded by default; pass `includeTemporary: true` to include them. Deployed source is
authoritative. Local source can establish an exact match only when the caller explicitly asserts
that it is deployed with `changesDeployed: true`; the tool does not verify that assertion.
`maxObservedWrites` bounds all observed breaks and defaults to 500. Reaching it releases the
workload and returns a truncated, incomplete report.

The final `complete` flag means every record-write break observed in this one attached-session
capture window was classified. It is not proof that no other session or operation writes the
table. Any missing source/span, unsupported receiver, watch failure, unknown runtime type,
unexpected break, lifecycle failure, early session detach, or truncation keeps the report
fail-closed. Exact groups collected before a detach remain available, but the tool does not claim
that no later writes were missed.

A next-session or user-filtered capture whose bound session detaches before any break (a stray
bind, seen in about half the `breakOnNext: "WebServiceClient"` attaches on BC28) is re-armed
after ~10 s rather than stopped: status reports `phase: "rearming"` and `strayBinds`/`rearms`
counters, and a workload started in that window is missed. After `maxRearms` (default 3) strays
the capture stops with `stopReason: "strayBindsExhausted"`.

**Static cross-check (optional, needs [al-sem](https://github.com/SShadowS/al-sem)).** When `alsem`
is found (`BC_DEV_ALSEM` or PATH), start also returns `staticWriters`: the write sites
(`Insert`/`Modify`/`ModifyAll`/`Delete`/`DeleteAll`/`Rename`, temporary records excluded unless
`includeTemporary`) al-sem believes can write the table, from `alsem query touches` +
`alsem query effects`, plus its "unknown bucket" (writes with an unresolved table, such as
`RecordRef`). The table is selected as `<app.json id>/table/<tableId>`, then by table name (the
project's own source object, and at finish the runtime name the debugger reported; base-app tables
need their symbols in `.alpackages`). Finish adds `staticCrossCheck`: statically possible writers
that were never observed, and observed writers that are not in al-sem's set (flagged when they sit
in its unknown bucket). Without `alsem`, or with an unknown al-sem schema major, start carries one
warning and nothing else changes. Limits to keep in mind: the debugger reports lines, not columns, so two
writes on one line join as one observed site; al-sem #9 (`Rename` is not modelled as a write), and dependencies without shipped
source never appear in the static set. "Never observed" only means not exercised by this workload.

[Back to README](../README.md)
