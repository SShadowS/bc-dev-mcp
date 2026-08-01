# bc-dev-mcp

MCP server for Business Central AL development: run tests (with code coverage) and debug interactively against a BC server's dev endpoint — the same SignalR hubs the AL VS Code extension uses.

[![Bun](https://img.shields.io/badge/bun-1.x-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue)](https://typescriptlang.org)
[![BC dev API](https://img.shields.io/badge/BC%20dev%20API-%E2%89%A57.0-purple)]()
[![Tests](https://img.shields.io/badge/tests-670%20passing-green)]()

## Overview

| Metric | Value |
|--------|-------|
| Runtime | Bun (dev/build) · Node 18+ (dist) |
| Runtime dependencies | 3 (`@microsoft/signalr`, `@modelcontextprotocol/sdk`, `zod`) |
| Transport | MCP over stdio |
| Server requirement | BC dev API `WebApiVersion >= 7.0` (AL 18 platform, e.g. BC28) |
| Auth | Azure CLI / Entra ID (SaaS) · UserPassword (on-prem / docker) |
| Validation | Live E2E against BC28 and SaaS Sandbox (`scripts/e2e.md`) |

## Features

| Feature | Description |
|---------|-------------|
| **Agent-grade responses** | Every success returns schema-validated `structuredContent` plus contextual `nextSteps`; failures use stable, redacted JSON error bodies |
| **Structured test runs** | Run-level pass/fail/abort counts, per-method duration, parsed AL call stacks, and local source mappings while retaining raw server output |
| **Test orchestration** | Repeat one test selection, diff adjacent passed/failed sets, retain every run, and classify stable, flaky, inconsistent, or incomplete methods |
| **Code coverage** | `procedure` mode, mapped back to local source files (`line` mode exists but is unproven against real BC) |
| **Coverage gap analysis** | Cross a Git diff with exact procedure coverage to report which changed procedures the selected tests did and did not exercise |
| **Multi-codeunit plans** | Sequential codeunit groups over one hub connection |
| **Interactive debugging** | Next-session, user-filtered, or exact-session attach; file/line breakpoints, break on all or unhandled errors only, record-write breaks (optionally skipping temp records), stack + variables + watch, stepping, abort/release at a break |
| **Record-write triage** | Arm a bounded capture for one numeric table ID, automatically continue every global record-write stop, and group exact matching writer stacks while failing closed on unresolved evidence |
| **BC native MCP passthrough** | Dynamically discover and invoke BC28 business-action, AL-runtime, and paused-debugger native MCP tools from the same agent |
| **On-demand source & symbols** | Read one deployed server object or download one validated installed `.app` package into the project’s `.alpackages` cache |
| **Debug-a-test** | Test run bound to the debug session — breakpoints fire during test execution |
| **Config auto-discovery** | Server/instance/tenant read from the AL project's `.vscode/launch.json` |
| **Preflight diagnostics** | `bcdev_status` distinguishes unreachable / bad credentials / unsupported dev API |
| **Sampling CPU profiling** | Capture a `.alcpuprofile` (V8 format) of a live session and get a ranked AL self-time hotspot summary; hand off to al-perf for deep analysis |

## Prerequisites

- A reachable BC server with dev API `WebApiVersion >= 7.0` (check with `bcdev_status`)
- For SaaS: the standard Azure CLI, signed in to the launch configuration's tenant (`az login --tenant <tenant-id>`)
- For on-premises: UserPassword credentials for the dev endpoint
- Git on `PATH` and an AL project inside a repository when using `coverageAgainst`
- Bun (to run from source) or Node 18+ (to run the built `dist/index.js`)

## Installation

**Claude Code** — one command:

```bash
claude mcp add bc-dev --env BC_DEV_USER=admin --env BC_DEV_PASSWORD=... -- npx -y bc-dev-mcp
```

**Any other MCP client** — `.mcp.json` (or your client's equivalent):

```jsonc
{
  "mcpServers": {
    "bc-dev": {
      "command": "npx",
      "args": ["-y", "bc-dev-mcp"],
      "env": { "BC_DEV_USER": "admin", "BC_DEV_PASSWORD": "..." }
    }
  }
}
```

(`bunx bc-dev-mcp` works too.) For on-premises, credentials come from the two environment variables above. For SaaS, no token or password environment variable is accepted: `environmentType`, `environmentName`, and `tenant` come from the AL project's `.vscode/launch.json`, and the server asks Azure CLI for an in-memory Business Central token. Every connection-opening tool also accepts target overrides.

Running from source instead: `git clone` → `bun install && bun run build` → point `command` at `node dist/index.js`, or `bun run compile` for a standalone `bc-dev-mcp.exe`.

## Quick Start

1. `bcdev_status` — verify reachability, auth, and that test running is supported.
2. `bcdev_test_discover` — list test codeunits and `[Test]` methods from local `.al` files.
3. `bcdev_test_run { codeunits: [{ id: 50100 }], coverage: "procedure" }` — structured results. Add `coverageAgainst: "origin/main"` for changed-procedure analysis. After publishing the current changed objects to the target, also pass `changesDeployed: true` to permit `covered`/`uncovered` classifications; without that explicit assertion, changed procedures remain `unknown`.
4. `bcdev_test_orchestrate { codeunits: [{ id: 50100 }], runs: 3 }` — repeat the same selection, retain every run, diff adjacent pass/fail sets, and flag flaky methods.
5. `bcdev_debug_attach { breakOnError: true }` → trigger the workload → `bcdev_debug_wait` for `sessionBound` and breaks → inspect with `bcdev_debug_variables` / `bcdev_debug_eval` → `bcdev_debug_continue` → `bcdev_debug_detach`. For a debug-bound test run, trigger with `bcdev_debug_run_tests { codeunits: [{ id: 50100 }] }`.
6. To find writers of one table without stepping through every stop: `bcdev_record_writes_start { tableId: 18 }` → trigger the matching workload → check `bcdev_record_writes_status` → call `bcdev_record_writes_finish` for grouped stacks.
7. To use Business Central's own MCP catalog: `bcdev_native_list { company: "...", context: "business" }` → inspect the returned schemas → `bcdev_native_call` with one exact returned tool name.
8. For off-disk code or missing symbols: use `bcdev_source { objectType, objectId }`, or `bcdev_package_download { publisher, appName, version, appId }` for one installed package.

Debugger attach returns as soon as Business Central accepts the request; binding is asynchronous. With no selector it binds the next session of the `breakOnNext` client type. Pass `userId` to filter that next session by Business Central user, or pass a known positive `sessionId` to attach to an existing NST session. `sessionId` and `userId` are mutually exclusive; exact `sessionId` targeting takes precedence over `breakOnNext`. `bcdev_debug_wait` reports `{ kind: "sessionBound", sessionId, hostId }` after binding; `hostId` may be null when Business Central omits that optional field. If identity lookup fails, it reports a nonfatal warning-form `sessionBound` event and debugging remains active. If Business Central emits a fatal user-filter rejection before `sessionBound`, the debugger tears down without binding or delivering breaks and reports an actionable `fatal` event.

## Configuration

| Setting | Source | Default | Description |
|---------|--------|---------|-------------|
| `BC_DEV_USER` | env var | — | On-prem UserPassword username |
| `BC_DEV_PASSWORD` | env var | — | On-prem UserPassword password |
| `BC_DEV_ENTRA_TENANT` | env var | — | SaaS tenant fallback when launch.json does not provide `tenant` |
| `environmentType` | launch.json / tool param | inferred | `OnPrem`, `Sandbox`, or `Production` |
| `environmentName` | launch.json / tool param | — | SaaS environment name |
| `server` | launch.json / tool param | — | BC server URL, e.g. `http://bcserver` |
| `serverInstance` | launch.json / tool param | — | Server instance, e.g. `BC` |
| `port` | launch.json / tool param | `7049` | Developer service port |
| `tenant` | launch.json / tool param | `default` | Tenant (hub negotiate requires one) |
| `project` | tool param | server cwd | AL project dir for launch.json and `.al` scanning |

Connection-opening tools accept the corresponding target fields; session-scoped tools reuse their attached authorization provider. On-premises `UserPassword` and SaaS Entra are explicit separate modes and never fall back to each other. Windows and on-premises AAD are not currently supported. For upgrade compatibility, an on-prem launch configuration that still says `"authentication": "Windows"` or `"AAD"` continues to use UserPassword only when both `BC_DEV_USER` and `BC_DEV_PASSWORD` are present; otherwise it fails with an actionable unsupported-mode error.

Example SaaS launch configuration:

```jsonc
{
  "type": "al",
  "request": "launch",
  "environmentType": "Sandbox",
  "environmentName": "Sandbox",
  "tenant": "00000000-0000-0000-0000-000000000000"
}
```

Azure access tokens are acquired with `az account get-access-token`, cached only in memory until shortly before expiry, and never logged or written by this project.

## Architecture

```
MCP client (agent)
  |
  v  (stdio)
src/mcp/server.ts ── tools/ (24 bcdev_* tools) ── state.ts (debug/test/profile ownership)
  |
  v
src/core/  (pure library — typed returns, injected deps)
  |-- launch-config.ts   launch.json + env credentials
  |-- authorization.ts   Basic or cached Azure CLI authorization provider
  |-- server-info.ts     GET dev/metadata, feature gates
  |-- native-mcp.ts      BC cloud Streamable HTTP MCP client and trusted routing
  |-- package-download.ts bounded, validated dev/packages download into .alpackages
  |-- al-objects.ts      file <-> (objectType, objectId) index, test discovery
  |-- hubs/test-runner-hub.ts ──> <server>/BC/dev/TestRunnerHub   (SignalR)
  |-- hubs/debugger-hub.ts    ──> <server>/BC/dev/DebuggerHub     (SignalR)
```

## Tools

| Tool | Purpose |
|------|---------|
| `bcdev_status` | Preflight: reachability, auth, dev API version, feature gates |
| `bcdev_test_discover` | List test codeunits and `[Test]` methods from local `.al` files |
| `bcdev_test_run` | Run tests with a summary, parsed/source-mapped failures, optional coverage, and Git-aware changed-procedure gaps |
| `bcdev_test_orchestrate` | Repeat one selection 2–20 times, retain every run, diff adjacent pass/fail sets, and flag flaky/incomplete methods |
| `bcdev_debug_attach` | Arm next-session/user-filtered attach or target an existing NST session; optionally set breakpoints |
| `bcdev_debug_run_tests` | Run tests with breakpoints live |
| `bcdev_debug_wait` | Long-poll for session-bound / break / run-finished lifecycle events |
| `bcdev_debug_continue` | continue / stepOver / stepInto / stepOut / release / abort |
| `bcdev_debug_variables` | Inspect locals/globals, expand records, and report server-provided change flags |
| `bcdev_debug_eval` | Evaluate watch expression (large strings un-truncated) |
| `bcdev_debug_sql` | Live SQL cost at a break: latency, executes, last statements |
| `bcdev_debug_breakpoints` | Add/remove breakpoints and report the server's verified or relocated source span |
| `bcdev_debug_detach` | End the debug session |
| `bcdev_record_writes_start` | Arm bounded background write triage for one positive numeric table ID |
| `bcdev_record_writes_status` | Read current write-triage lifecycle and classification counts without driving collection |
| `bcdev_record_writes_finish` | Release/stop collection and return grouped exact writer stacks plus unresolved evidence |
| `bcdev_source` | Read the server’s deployed AL source for an object not on local disk |
| `bcdev_package_download` | Download one validated installed dependency/symbol `.app` into `<project>/.alpackages` |
| `bcdev_native_list` | List the dynamic BC28 native tool catalog for business, AL runtime, or a paused debugger |
| `bcdev_native_call` | Invoke one exact native tool and preserve its complete upstream result |
| `bcdev_profile_status` | Preflight the snapshot-debugger endpoint; report whether sampling CPU profiling is supported |
| `bcdev_profile_start` | Arm a CPU profiler (`kind: "sampling"` or `"instrumentation"`); binds the next matching session (trigger it after) |
| `bcdev_profile_poll` | Poll the active capture; `ready` once the session was recorded (Started) |
| `bcdev_profile_finish` | Finish, write the `.alcpuprofile`, return a ranked AL self-time hotspot summary |

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

## BC native MCP passthrough

`bcdev_native_list` and `bcdev_native_call` connect to Business Central's cloud MCP gateway with
the same launch configuration and Azure CLI identity used by the other SaaS tools. Each operation
requires an exact `company` and one explicit context:

- `business` lists the dynamic `bc_actions_*` catalog. Pass `configurationName` only when selecting
  a named Business Central MCP configuration.
- `runtime` lists the BC28 AL runtime catalog. Native runtime calls share the same singleton
  test-run lock as `bcdev_test_run`, `bcdev_test_orchestrate`, and
  `bcdev_debug_run_tests`.
- `debugging` lists troubleshooting tools for the active manual debugger. Attach, trigger the
  workload, and wait for a `break` first; a merely bound or resumed session is rejected.

Always list before calling and follow the returned native `inputSchema`. The generic call is marked
potentially destructive because its safety cannot vary dynamically with the chosen upstream tool.
Its `result` is the unchanged native `CallToolResult`; `result.isError: true` therefore remains
available with all upstream evidence instead of being rewritten as a bridge error.

Each list or call uses a fresh upstream MCP session and closes it before returning. Prefer the
first-class debugger tools for repeated inspection because they reuse the existing debugger hub.
Native debugging snapshots the paused session identity at call start; do not resume that debugger
concurrently with an in-flight native call.

If a native runtime invocation times out after its upstream call begins, Business Central may
still be running the tests even though the local singleton slot has been released. That timeout
is non-retryable and tells the caller to confirm the server-side run finished before retrying or
starting any other test run.

This passthrough supports cloud Sandbox and Production targets. Live acceptance is Sandbox-only.
Its contexts intentionally match the verified BC28 surface and do not include native profiling;
the existing `bcdev_profile_*` snapshot tools are separate and unchanged.

## On-demand source and symbols

`bcdev_source` reads the deployed source for one numeric object identity. Use it when a debugger
frame or coverage row has no local file. Empty content with `isAlContent:false` means Business
Central did not expose deployed AL source; the tool does not substitute potentially stale local
source.

`bcdev_package_download` retrieves one explicitly identified installed `.app` through
`dev/packages` and writes it to the selected project’s `.alpackages` directory. Supply the
publisher, name, four-part minimum version, and app ID when known. Business Central may resolve a
higher installed version; the result reports both requested and resolved versions. The selected
project must already contain `app.json`.

The package is size- and time-bounded, validated through `SymbolReference.json`, checked against
the requested identity, hashed, and only then installed under a filename derived from the returned
metadata. A byte-identical file returns `unchanged`; different validated server bytes replace the
same package path. A nonfatal `warning` can report that the validated replacement succeeded but a
stale `.backup` file could not be removed. This is deliberately a single-package operation, not dependency enumeration or
full Download Symbols synchronization. The default request bounds are 120 seconds and 256 MiB;
`timeoutMs` and `maxBytes` can raise them to hard limits of 300 seconds and 512 MiB. Inflated symbol
metadata is independently capped at the runtime-safe text limit (at most 512 MiB). A `NOT_FOUND`
response can mean either no installed package matched or the target server does not expose
`dev/packages`.

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

## Skills

The server ships its own operational manual as [Agent Skills](https://agentskills.io) over MCP
resources (draft [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)):
`skill://bc-al-testing/SKILL.md`, `skill://bc-al-debugging/SKILL.md`,
`skill://bc-al-source-symbols/SKILL.md`,
`skill://bc-native-mcp/SKILL.md`, discovery index at
`skill://index.json`. Clients that understand the `io.modelcontextprotocol/skills` extension pick
these up automatically; everything else sees them as plain readable resources.
Sources live in `skills/`; `bun run embed-skills` regenerates `src/mcp/skills.generated.ts`.

## Agent response contract

Successful tool calls remain backward-compatible objects and add a required `nextSteps: string[]`.
The array is contextual and may be empty when the result is terminal or no useful action follows.
Test runs add `summary`; failed method rows add `failure.message`, `failure.parsed`, and predictable
`failure.callStack` frames. The original `output` and each frame's `raw` text are retained so an
unrecognized or localized server format never loses evidence. Local source mapping is lazy and
best-effort: passing runs without coverage do not scan the AL tree, indexes are reused per MCP
server and project, and an unreadable/missing project preserves the server evidence plus a
nonfatal `sourceMappingWarning` that identifies whether call-stack or coverage file mapping was
unavailable.

Use `bcdev_test_orchestrate` when repeatability is the question. It claims the same singleton
test-run slot for the entire sequence, executes 2–20 ordinary TestRunnerHub runs sequentially,
retains each enriched attempt, and returns exact adjacent additions/removals for the passed and failed
sets. A method is `flaky` only with positive pass-and-fail evidence. Missing or duplicate
observations, an aborted run, or a run with no real methods forces `complete: false`; mixed
passed/skipped or failed/skipped observations are `inconsistent`, not mislabeled as flaky.
If an attempt cannot start, earlier evidence and a final aborted attempt remain in `runs[]`.
After an aborted attempt, later requested runs are left as missing rather than started while
the prior server-side run may still be active. Client cancellation is observed between attempts;
it does not cancel an active Business Central run. `tests[].method` keeps the first requested or
observed spelling, so its casing can differ from raw server rows. An all-skipped selection retains
the existing `passed` outcome convention but warns that it contains no passing execution evidence.
Overlapping codeunit/method selections are rejected, while disjoint method groups for one codeunit
remain valid. Non-rolled-back test side effects repeat on every attempt.
Orchestration intentionally does not aggregate coverage — use `bcdev_test_run` for coverage and
changed-procedure analysis.

Pass `coverageAgainst` to `bcdev_test_run` for roadmap item 5's coverage-gap analysis. The tool
resolves the ref's merge base with `HEAD`, compares that commit with the current working tree
(committed branch changes, staged and unstaged edits, plus nonignored untracked AL files), and
automatically selects procedure coverage. `coverageGaps` reports each current executable procedure
intersecting those changed lines as `covered`, `uncovered`, or `unknown`, including the exact source
span, changed ranges, compiler method ID, and covering test identities. An `uncovered` result is only
emitted when the compiler identity is exact, the caller explicitly confirms the current changes are
deployed with `changesDeployed: true`, and every requested test group returned procedure coverage
that omitted it. TestRunnerHub does not return an artifact or source hash, so
`coverageGaps.deployment` distinguishes that caller assertion from tool verification. Without the
assertion, with unresolved signatures, incomplete parsing or coverage, or an aborted run, the
affected result remains `unknown` and `complete` is false. Trigger spans are detected but their
coverage identities are not yet classified by local discovery, so a changed trigger also forces an
explicit incomplete result instead of disappearing from the gate. SaaS validation confirmed that
Business Central reports codeunit `OnRun`, table `OnInsert`, report `OnPreReport`, and page
`OnOpenPage` under their owning object identities with the compiler's trigger-specific method-ID
hash; nested trigger scopes still need separate identity handling. Changed code that carries no
method identity at all — object and field properties, field and control declarations, global
variables, object headers, `namespace`/`using` declarations, and semantic preprocessor directives
outside method spans — is counted in
`summary.unattributedChanges`, listed in `warnings` with its exact lines, and also forces
`complete: false`: procedure coverage can never prove those lines were exercised. Conditional
compilation follows `app.json` preprocessor symbols (the manifest and its explicit `runtime` are
required because the runtime selects method-ID hash variants), and dependency identities preserve
namespace qualification from `.alpackages`. Use the same base ref when rerunning a broader test
selection to close reported gaps.

Breakpoint additions include `verification.status` (`verified`, `relocated`, or `unverified`) and
the resolved object, method, and 1-based span when Business Central supplies them. An all-zero
wire span is the value type's unset form and remains `unverified`; it is not reported as line 1.
Variable and watch nodes include `changeState` plus the convenience boolean `changed`; `unknown`
means the server omitted or returned an unfamiliar wire value, not that the value was proven
unchanged.

MCP errors intentionally omit `structuredContent` (the protocol has no negotiated structured-error
channel here). Their text content is a JSON object with stable `error.code`, `category`, `message`,
`retryable`, `tool`, redacted `details`, and recovery `nextSteps`, so agents can parse it without
scraping prose while existing MCP clients still receive a normal `isError: true` response. Expected
launch configuration, Azure CLI authentication, active-profile, SQL-insight, and unsupported-server
failures are typed where they originate; message matching is only a defensive fallback. String
detail values are redacted, and sensitive detail keys fail closed to `[REDACTED]`.
If an installed MCP SDK no longer exposes the private validation-error formatting seam, the server
warns and continues with the SDK's default formatting instead of refusing to start.

Debugger guidance accounts for asynchronous binding: next-session/user-filtered attach tells the
agent to create or trigger the matching session before waiting, exact-session attach waits for
confirmation before driving the operation, and a timeout reminds the agent to confirm the workload
was triggered. Profiling guidance similarly branches on reachability, feature support, every poll
status (`Initialized`, `Started`, `Finished`, or `Failed`), and whether the capture actually
contained data. Test-running support is preflighted only after atomically claiming the shared
single-run slot, so concurrent direct/debug-bound calls cannot pass the feature gate together. A
successful capability result is cached for 60 seconds and the metadata request times out after 15
seconds, preventing a stale or hung preflight from holding that slot indefinitely.

## Key Files

| File | Purpose |
|------|---------|
| `src/mcp/index.ts` | stdio entry: builds deps, calls buildServer, connects transport |
| `src/mcp/server.ts` | buildServer: registerTool/registerResource wiring (testable over InMemoryTransport) |
| `src/mcp/tools/` | The 24 bcdev_* tool definitions (zod schemas + metadata + handlers) |
| `src/mcp/state.ts` | Debug session singleton, event queue, run lock |
| `src/core/hubs/test-runner-hub.ts` | TestRunnerHub client (Initialize/RunTests, coverage) |
| `src/core/test-orchestration.ts` | Pure repeat-run identity, stability classification, and adjacent pass/fail diff analysis |
| `src/core/hubs/debugger-hub.ts` | DebuggerHub client (attach, breakpoints, stepping, inspection) |
| `src/core/hubs/signalr-base.ts` | Hub seam: auth query params, key normalization, `HubProxy` |
| `src/core/authorization.ts` | Shared Basic/Azure CLI authorization provider and token cache |
| `src/core/git-changes.ts` | Merge-base-to-working-tree AL change ranges, including untracked files |
| `src/core/al-procedures.ts` | Executable procedure/trigger spans and compiler-compatible procedure identities |
| `src/core/coverage-gaps.ts` | Exact join between changed procedures and TestRunnerHub coverage evidence |
| `src/core/record-write-triage.ts` | Source-aware runtime table classification and bounded writer-stack collector |
| `src/core/native-mcp.ts` | BC cloud native MCP routing, lifecycle, and SDK transport |
| `src/core/package-download.ts` | Bounded package retrieval, symbol identity validation, and safe `.alpackages` installation |
| `scripts/e2e.md` | Real-server wire-assumption checklist + known server behaviours |

## Roadmap

Ordered by intent, not commitment:

1. **Agent-grade responses** — **shipped.** Structured run summaries, parsed call stacks mapped to source lines, verified breakpoint locations, changed-variable flags, stable machine-readable error bodies, and next-step hints on every tool.
2. **Debugger power controls** — **shipped.** Live SQL cost at a break (`bcdev_debug_sql`), break on unhandled errors only / skip temp-record writes, abort or release a paused operation, read deployed source for off-disk objects (`bcdev_source`), un-truncated watch strings.
3. **CPU profiling** (`bcdev_profile_*`) — **shipped.** Capture a sampling CPU profile (`.alcpuprofile`, V8 format) of a live session and get back a ranked AL-hotspot summary, not just a blob. Four tools (status/start/poll/finish), validated end-to-end against a live BC28 — a real profile with AL call frames captured through the tools (`scripts/e2e-profile-results-2026-07-04.md`). (Full snapshot recording for VS Code replay shares the same core and stays deferred.)
4. **Entra ID auth** — **shipped.** Azure CLI-backed cloud sandbox/production access alongside explicit on-prem UserPassword.
5. **Coverage gap analysis** — **shipped.** Pass `coverageAgainst` to `bcdev_test_run` to cross the merge-base-to-working-tree Git diff with exact procedure coverage and identify covered, uncovered, or unresolved changed procedures.
6. **Test orchestration** — **shipped.** Repeat one selected test plan, retain every enriched run, diff adjacent passed/failed sets, and flag flaky or incomplete method outcomes.
7. **Break-on-record-write triage** — **shipped.** Arm bounded write triage for one numeric table ID and automatically collect grouped exact writer stacks.
8. **BC native MCP passthrough** — **shipped.** Dynamically list and invoke BC28 cloud business-action, AL-runtime, and active-debugger native tools through one agent-facing bridge while retaining complete upstream results.
9. **On-demand source & symbols** — **shipped.** Read a deployed server object with `bcdev_source`, or download one validated installed dependency package into `.alpackages` with `bcdev_package_download`.

## Development

| Command | Description |
|---------|-------------|
| `bun test` | Unit tests (fake-hub based, no server needed) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run build` | Bundle to `dist/index.js` (Node target) |
| `bun run compile` | Single executable `bc-dev-mcp.exe` |

Wire-format assumptions carry `// WIRE:` comments recording their provenance, and are re-verified live per AL major via `scripts/e2e.md`.

---

**Author**: Torben Leth (sshadows@sshadows.dk)
**License**: MIT (see [LICENSE](LICENSE))
