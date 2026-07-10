# Live E2E — Rust bc-mdc-converter discovery + conversion (2026-07-10)

**Context:** the committed .NET converter shim (`tools/mdc-converter/`) was removed and
`bcdev_profile_*` now discovers the standalone Rust
[`bc-mdc-converter`](https://github.com/SShadowS/bc-mdc-converter) via the `BC_MDC_CONVERTER`
env var or a `PATH` scan (`src/core/snapshot/converter.ts`). This run re-validates the
instrumentation chain end-to-end through the **built** server (`node dist/index.js`) — no
`converterOverride`, real discovery, real conversion.

**Target:** live BC28 docker container, instance `BC`, tenant `default`. Session trigger:
WebClient bursts via `business-central-mcp` (open/read/close pages 22/31/16/27/21/26 + Tell Me
search), armed **before** the session per the bind-next contract.

**Local gate before the run:** `bun test` → 184 pass / 0 fail; `bun run typecheck` clean;
`bun run build` → `dist/index.js` (1.19 MB).

## RUN A — `BC_MDC_CONVERTER` env-var discovery, full chain

Built server spawned with `BC_MDC_CONVERTER=<path to bc-mdc-converter.exe>`.

| Step | Result |
|------|--------|
| `bcdev_profile_status` | reachable, `sampleProfilingSupported: true` |
| `bcdev_profile_start { kind: "instrumentation" }` | `attachKind: "NextSessionOnTenant"`, **`converterAvailable: true`** (real `resolveConverter`, no override) |
| poll during live WebClient bursts | reached `Started` |
| `bcdev_profile_finish` | `captured: true`, **`kind: "instrumentation"`** (converted, not raw), wrote both `.snapshot.zip` and `.alcpuprofile` |
| converter invocation | `bc-mdc-converter <zip> <out> --format v8` (exit 0) |
| profile summary | `durationMs 111867.768`, `sampleCount 708`, `nodeCount 708` |
| on-disk V8 parse | `ok: true`, `nodes: 708`, `samples: 708`, `timeDeltas: 708` |

Top hotspots were real AL frames (`GetAvgDaysPastDueDateLabel` CodeUnit_32.dal:141,
`OnPageBackgroundTaskCompleted` Page_21.dal:2557, …) with `al-preview://` URLs — same shape as
the 2026-07-05 shim run (`scripts/e2e-instrumentation-results-2026-07-04.md`), and notably the
same 708-node count for an equivalent workload window.

## RUN C — `PATH` discovery

Second built server spawned with the converter's **directory prepended to `PATH`** and no
`BC_MDC_CONVERTER`.

| Step | Result |
|------|--------|
| `bcdev_profile_start { kind: "instrumentation" }` | **`converterAvailable: true`** — the PATH scan inside the shipped server found `bc-mdc-converter.exe` |
| `bcdev_profile_finish` (no session driven, deliberate) | `captured: false`, "Nothing recorded" hint — known empty-finish behaviour, session cleanly closed |

## Not re-run

Raw-.mdc graceful fallback (converter unavailable / non-zero exit): code path unchanged by the
shim removal, unit-covered (`tests/mcp/profile-tools.test.ts`), validated live 2026-07-05
(`scripts/e2e-instrumentation-results-2026-07-04.md` RUN B).

**Verdict: PASS** — both discovery paths work through the shipped artifact; the Rust converter
produces a valid V8 `.alcpuprofile` from a live BC28 instrumentation capture.

**Reproduce:** `bun run build && bun run scratch/instr-e2e-rust.mjs` (needs the live BC28
container, `bc-mdc-converter` built at its repo's `target/release/`, and `business-central-mcp`
built). Full transcript: `scratch/instr-e2e-rust.log`; artifacts: `scratch/instr-e2e-rust-out/`.
