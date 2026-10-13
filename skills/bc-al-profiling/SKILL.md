---
name: bc-al-profiling
description: Capture a CPU profile of a Business Central session with the bc-dev-mcp bcdev_profile_* tools — start, trigger the session yourself, poll until Started, finish to get an .alcpuprofile plus hotspot summary. Use when asked to profile, find hotspots, or explain why an AL operation is slow.
---

# Profiling AL on Business Central

The profiler **captures**; it does not drive BC. Arming it binds the *next* matching session,
and something else has to make that session run AL. Follow the order below — every call is
stateful and the steps cannot be reordered.

## Workflow

1. `bcdev_profile_status` — preflight the snapshot-debugger endpoint. Check `reachable: true`
   and `sampleProfilingSupported: true` (snapshot API major >= 3). On failure, read `error`.
2. `bcdev_profile_start` — arms the profiler and returns a `profileId` handle (plus the wire
   `debuggingContext`). Pass `profileId` to poll and finish; it is optional, but when given it
   must match the active capture or the call fails `NOT_FOUND`. Valid until `bcdev_profile_finish`.
   - `kind: "sampling"` (default): statistical stack samples every `samplingIntervalMs`
     (50 / 100 / 150, default 100). Dependency-free.
   - `kind: "instrumentation"`: records every call, so self-time is exact. Needs the
     bc-mdc-converter binary to produce an `.alcpuprofile` (see fallback below). Check
     `converterAvailable` in the response before you rely on a converted profile.
   - Binds the next session of `clientType` (default `WebClient`, what a browser or
     business-central-mcp creates). Narrow with `userId` on a shared server, or pass a specific
     `sessionId` (default `-1` = next matching).
3. **Trigger the session yourself.** Open the page, run the report, or post the document in a
   browser or through a WebSocket client such as business-central-mcp. That session's AL is
   what gets recorded. Nothing happens if you skip this.
4. `bcdev_profile_poll` — repeat until `ready: true` (`status: "Started"`). `Initialized` is a
   normal result: the session has not bound yet, so trigger it (again) and poll again.
   `Failed` means the capture is dead — call `bcdev_profile_finish` to release it and start over.
   For instrumentation, keep exercising the operation for a while after `Started`.
5. `bcdev_profile_finish` — ends the capture, writes the file (override with `outPath`) and
   returns `summary.hotspots` ranked by AL self-time, with `function`, `url`, `line`, `selfPct`.
   Hand the `.alcpuprofile` to al-perf for deeper analysis.

## Facts that save you time

- **One capture at a time.** A second `bcdev_profile_start` while one is armed fails with
  `PROFILE_ACTIVE`; call `bcdev_profile_finish` first. `bcdev_profile_poll` and
  `bcdev_profile_finish` without a capture fail with `PROFILE_NOT_ACTIVE`. Finish always
  releases the slot, even when it returns `captured: false` or throws, so it is also your reset.
- **Snapshot port, not the dev port.** Profiling uses the snapshot-debugger endpoint, default
  port **7083**, separate from the dev endpoint port (often 7049). Pass `snapshotPort` to
  `bcdev_profile_status` and `bcdev_profile_start` if the server maps it elsewhere; poll and
  finish reuse the port chosen at start. Server, instance, tenant and credentials come from the
  same connection settings as every other tool (`.vscode/launch.json`, `BC_DEV_USER` /
  `BC_DEV_PASSWORD`).
- **`captured: false` means nothing was recorded.** Usually no matching session ran AL between
  start and finish (wrong `clientType`/`userId`, or the trigger happened before start).
  Start again and trigger after arming.
- **Expect `IdleTime` at the top of a sampled profile** for a lightly loaded interactive
  session; read the AL frames below it.
- **Converter fallback (instrumentation only).** The server returns a `.mdc` snapshot zip.
  `bcdev_profile_finish` converts it with bc-mdc-converter, found via `BC_MDC_CONVERTER` or
  `bc-mdc-converter` on `PATH`. When the binary is absent or conversion fails, the call still
  succeeds with `kind: "instrumentation-raw"`, `captured: true` and the saved `zipPath` — no
  `profilePath`, no `summary`. Install the converter and convert the zip
  (`bc-mdc-converter <zip> <out.alcpuprofile> --format v8`) or open it in VS Code
  (`AL: Open snapshot`). The `.mdc` data is never lost.
- A sampling capture whose archive turns out to be a snapshot recording returns
  `captured: false` with `kind: "recording"`; replaying recordings is a VS Code concern.
- **Follow the response.** Successes carry `hint` and `nextSteps`; MCP errors are JSON with a
  stable `error.code`, `retryable` and recovery `nextSteps`.

## After the profile

Found a hot AL method and want live values there? Switch to the bc-al-debugging skill
(skill://bc-al-debugging/SKILL.md) and set a breakpoint on the reported `url`/`line`.
