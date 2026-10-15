# Profiling and snapshot capture

## Profiling

`bcdev_profile_*` **captures** a CPU profile; it does not itself drive BC. The division of labour is
deliberate:

1. `bcdev_profile_start` arms the profiler on the snapshot-debugger port (7083, separate from the dev
   port) and binds the **next** matching session. Pass `kind: "sampling"` (default) or
   `kind: "instrumentation"`.
2. **You trigger the session to profile** — open a page or run a report in a browser, or drive a
   WebSocket client such as [`business-central-mcp`](https://github.com/SShadowS/business-central-mcp).
   That running WebClient session is what the profiler records.
3. `bcdev_profile_poll` until `ready`, then `bcdev_profile_finish` writes the `.alcpuprofile` (V8
   format, with AL call frames) and returns a ranked self-time hotspot summary.
4. For deep analysis (anti-patterns, AI insights), hand the `.alcpuprofile` to
   [al-perf](https://github.com/SShadowS/al-perf).

**`kind: "sampling"`** (default) is statistical — a periodic stack sample at a configurable interval
(`samplingIntervalMs`) — and dependency-free: the `.alcpuprofile` comes straight off the wire, no
extra tooling required.

**`kind: "instrumentation"`** records every call deterministically instead of sampling, so
self-time in the resulting profile is exact call-time, not a statistical estimate. The server
returns a `.mdc` snapshot zip, not an `.alcpuprofile` directly, so `bcdev_profile_finish` converts it
headlessly via [`bc-mdc-converter`](https://github.com/SShadowS/bc-mdc-converter) — a standalone
Rust binary (no .NET runtime, no AL tooling) whose `.alcpuprofile` output is byte-identical to the
official AL tooling's. Point `BC_MDC_CONVERTER` at the binary or put it on `PATH`. When it's
missing, `bcdev_profile_finish` degrades gracefully: it still saves the raw `.mdc` `.zip` to disk
and tells you to convert it manually or open it in VS Code (`AL: Open snapshot` → generate profile)
instead of failing the call.

Validated end-to-end against a live BC28 in `scripts/e2e-profile-results-2026-07-04.md`.

## Snapshot capture

Use `bcdev_snapshot_*` when you cannot attach the interactive debugger and pause: a user's browser
session, or a session that must keep running. It shares the snapshot-debugger port (7083) and the
one-capture-per-tenant slot with profiling.

1. `bcdev_snapshot_start` with `snappoints` (`file` + 1-based `line`; none = record only what throws)
   and optionally `userId`, `sessionId` or `verbosity: "full"`.
2. **Trigger the scenario** (open the page in a browser or with
   [`business-central-mcp`](https://github.com/SShadowS/business-central-mcp)).
3. `bcdev_snapshot_status` until `ready`, then `bcdev_snapshot_finish`. Points come back exceptions
   first, then snappoint hits; a snappoint's values are taken **before** that line runs.

To capture an AL **test run** (on-prem), replace step 2 with `bcdev_snapshot_run_tests { codeunits:
[{ id, methods? }] }`: it runs the tests attached to the armed capture and returns per-method results
(a failing test is an ordinary result), then call `bcdev_snapshot_finish` directly. The failing
test's exception point carries the variables at the moment it threw.

Zips are saved to `%TEMP%\bc-dev-mcp-snapshots` (`<os temp>/bc-dev-mcp-snapshots`) unless you pass
`outPath`; bc-dev-mcp never deletes them, and they open in VS Code for replay. Decoding needs
bc-mdc-converter (see `BC_MDC_CONVERTER`), which is downloaded on first use when missing.

**Data disclosure:** captured variables can hold customer data, credentials and source code. They
are returned to the agent as-is, and the saved zip holds everything, including what the response
left out (`verbosity: "full"` also bundles the source of every object the session touched).

Verified live against BC29 (`scripts/e2e.md` "Snapshot debug capture"): `clientType` WebClient
(default), `userId` and `sessionId` bind; WebServiceClient records nothing usable (the capture is
dropped when the API call's session ends); Background binds a TaskScheduler session but records nothing
usable either (source only while it runs, dropped when it ends). BC29 ignores snappoint
`condition`s, so filter the points yourself. To capture an AL test run, arm a capture and call
`bcdev_snapshot_run_tests` (on-prem).

[Back to README](../README.md)
