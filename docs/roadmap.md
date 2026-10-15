# Roadmap (shipped)

Ordered by intent, not commitment:

1. **Agent-grade responses** — **shipped.** Structured run summaries, parsed call stacks mapped to source lines, verified breakpoint locations, changed-variable flags, stable machine-readable error bodies, and next-step hints on every tool.
2. **Debugger power controls** — **shipped.** Live SQL cost at a break (`bcdev_debug_sql`), break on unhandled errors only / skip temp-record writes, abort or release a paused operation, read deployed source for off-disk objects (`bcdev_source`), un-truncated watch strings.
3. **CPU profiling** (`bcdev_profile_*`) — **shipped.** Capture a sampling CPU profile (`.alcpuprofile`, V8 format) of a live session and get back a ranked AL-hotspot summary, not just a blob. Four tools (status/start/poll/finish), validated end-to-end against a live BC28 — a real profile with AL call frames captured through the tools (`scripts/e2e-profile-results-2026-07-04.md`). Instrumentation capture (`kind: "instrumentation"`) shares the same flow and converts to ir-json via `bc-mdc-converter`, saving the raw `.mdc` archive when that binary is absent. Debug-context snapshot recording is item 10.
4. **Entra ID auth** — **shipped.** Azure CLI-backed cloud sandbox/production access alongside explicit on-prem UserPassword.
5. **Coverage gap analysis** — **shipped.** Pass `coverageAgainst` to `bcdev_test_run` to cross the merge-base-to-working-tree Git diff with exact procedure coverage and identify covered, uncovered, or unresolved changed procedures.
6. **Test orchestration** — **shipped.** Repeat one selected test plan, retain every enriched run, diff adjacent passed/failed sets, and flag flaky or incomplete method outcomes.
7. **Break-on-record-write triage** — **shipped.** Arm bounded write triage for one numeric table ID and automatically collect grouped exact writer stacks.
8. **BC native MCP passthrough** — **shipped.** Dynamically list and invoke BC28 cloud business-action, AL-runtime, and active-debugger native tools through one agent-facing bridge while retaining complete upstream results.
9. **On-demand source & symbols** — **shipped.** Read a deployed server object with `bcdev_source`, download one validated installed dependency package into `.alpackages` with `bcdev_package_download`, or every package `app.json` needs with `bcdev_symbols_download`.
10. **Snapshot debugging capture** (`bcdev_snapshot_*`) — **shipped.** Record a session that cannot be paused at snappoints and errors; bc-mdc-converter decodes the recording into agent-readable points (variables, call stack, source window), and the zip still replays in VS Code. Validated live against BC29 (`scripts/e2e.md`).

[Back to README](../README.md)
