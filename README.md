# bc-dev-mcp

MCP server for Business Central AL development: run tests (with code coverage) and debug interactively against a BC server's dev endpoint — the same SignalR hubs the AL VS Code extension uses.

[![Bun](https://img.shields.io/badge/bun-1.x-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue)](https://typescriptlang.org)
[![BC dev API](https://img.shields.io/badge/BC%20dev%20API-%E2%89%A57.0-purple)]()
[![Tests](https://img.shields.io/badge/tests-431%20passing-green)]()

## Overview

| Metric | Value |
|--------|-------|
| Runtime | Bun (dev/build) · Node 18+ (dist) |
| Runtime dependencies | 3 (`@microsoft/signalr`, `@modelcontextprotocol/sdk`, `zod`) |
| Transport | MCP over stdio |
| Server requirement | BC dev API `WebApiVersion >= 7.0` (AL 18 platform, e.g. BC28) |
| Auth | Azure CLI / Entra ID (SaaS) · UserPassword (on-prem / docker) |
| Validation | Live E2E against BC28 (`scripts/e2e-results-2026-07-03.md`, `scripts/e2e-profile-results-2026-07-04.md`) |

## Features

| Feature | Description |
|---------|-------------|
| **Structured test runs** | Per-method pass/fail/skip with duration and failure output — every tool returns `structuredContent` validated by a published `outputSchema` |
| **Code coverage** | `procedure` mode, mapped back to local source files (`line` mode exists but is unproven against real BC) |
| **Multi-codeunit plans** | Sequential codeunit groups over one hub connection |
| **Interactive debugging** | Next-session, user-filtered, or exact-session attach; file/line breakpoints, break-on-error, stack + variables + watch, stepping |
| **Debug-a-test** | Test run bound to the debug session — breakpoints fire during test execution |
| **Config auto-discovery** | Server/instance/tenant read from the AL project's `.vscode/launch.json` |
| **Preflight diagnostics** | `bcdev_status` distinguishes unreachable / bad credentials / unsupported dev API |
| **Sampling CPU profiling** | Capture a `.alcpuprofile` (V8 format) of a live session and get a ranked AL self-time hotspot summary; hand off to al-perf for deep analysis |

## Prerequisites

- A reachable BC server with dev API `WebApiVersion >= 7.0` (check with `bcdev_status`)
- For SaaS: the standard Azure CLI, signed in to the launch configuration's tenant (`az login --tenant <tenant-id>`)
- For on-premises: UserPassword credentials for the dev endpoint
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
3. `bcdev_test_run { codeunits: [{ id: 50100 }], coverage: "procedure" }` — structured results.
4. `bcdev_debug_attach { breakOnError: true }` → trigger the workload → `bcdev_debug_wait` for `sessionBound` and breaks → inspect with `bcdev_debug_variables` / `bcdev_debug_eval` → `bcdev_debug_continue` → `bcdev_debug_detach`. For a debug-bound test run, trigger with `bcdev_debug_run_tests { codeunits: [{ id: 50100 }] }`.

Debugger attach returns as soon as Business Central accepts the request; binding is asynchronous. With no selector it binds the next session of the `breakOnNext` client type. Pass `userId` to filter that next session by Business Central user, or pass a known positive `sessionId` to attach to an existing NST session. `sessionId` and `userId` are mutually exclusive; exact `sessionId` targeting takes precedence over `breakOnNext`. `bcdev_debug_wait` reports `{ kind: "sessionBound", sessionId, hostId }` after binding. If identity lookup fails, it reports a nonfatal warning-form `sessionBound` event and debugging remains active.

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
src/mcp/server.ts ── tools/ (15 bcdev_* tools) ── state.ts (session, event queue)
  |
  v
src/core/  (pure library — typed returns, injected deps)
  |-- launch-config.ts   launch.json + env credentials
  |-- authorization.ts   Basic or cached Azure CLI authorization provider
  |-- server-info.ts     GET dev/metadata, feature gates
  |-- al-objects.ts      file <-> (objectType, objectId) index, test discovery
  |-- hubs/test-runner-hub.ts ──> <server>/BC/dev/TestRunnerHub   (SignalR)
  |-- hubs/debugger-hub.ts    ──> <server>/BC/dev/DebuggerHub     (SignalR)
```

## Tools

| Tool | Purpose |
|------|---------|
| `bcdev_status` | Preflight: reachability, auth, dev API version, feature gates |
| `bcdev_test_discover` | List test codeunits and `[Test]` methods from local `.al` files |
| `bcdev_test_run` | Run tests, structured results, optional coverage |
| `bcdev_debug_attach` | Arm next-session/user-filtered attach or target an existing NST session; optionally set breakpoints |
| `bcdev_debug_run_tests` | Run tests with breakpoints live |
| `bcdev_debug_wait` | Long-poll for session-bound / break / run-finished lifecycle events |
| `bcdev_debug_continue` | continue / stepOver / stepInto / stepOut |
| `bcdev_debug_variables` | Inspect locals, globals, expand records |
| `bcdev_debug_eval` | Evaluate watch expression |
| `bcdev_debug_breakpoints` | Add/remove breakpoints mid-session |
| `bcdev_debug_detach` | End the debug session |
| `bcdev_profile_status` | Preflight the snapshot-debugger endpoint; report whether sampling CPU profiling is supported |
| `bcdev_profile_start` | Arm a CPU profiler (`kind: "sampling"` or `"instrumentation"`); binds the next matching session (trigger it after) |
| `bcdev_profile_poll` | Poll the active capture; `ready` once the session was recorded (Started) |
| `bcdev_profile_finish` | Finish, write the `.alcpuprofile`, return a ranked AL self-time hotspot summary |

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
`skill://bc-al-testing/SKILL.md`, `skill://bc-al-debugging/SKILL.md`, discovery index at
`skill://index.json`. Clients that understand the `io.modelcontextprotocol/skills` extension pick
these up automatically; everything else sees them as plain readable resources.
Sources live in `skills/`; `bun run embed-skills` regenerates `src/mcp/skills.generated.ts`.

## Key Files

| File | Purpose |
|------|---------|
| `src/mcp/index.ts` | stdio entry: builds deps, calls buildServer, connects transport |
| `src/mcp/server.ts` | buildServer: registerTool/registerResource wiring (testable over InMemoryTransport) |
| `src/mcp/tools/` | The 15 bcdev_* tool definitions (zod schemas + metadata + handlers) |
| `src/mcp/state.ts` | Debug session singleton, event queue, run lock |
| `src/core/hubs/test-runner-hub.ts` | TestRunnerHub client (Initialize/RunTests, coverage) |
| `src/core/hubs/debugger-hub.ts` | DebuggerHub client (attach, breakpoints, stepping, inspection) |
| `src/core/hubs/signalr-base.ts` | Hub seam: auth query params, key normalization, `HubProxy` |
| `src/core/authorization.ts` | Shared Basic/Azure CLI authorization provider and token cache |
| `scripts/e2e.md` | Real-server wire-assumption checklist + known server behaviours |

## Roadmap

Ordered by intent, not commitment:

1. **Agent-grade responses** — structured run summaries, parsed call stacks mapped to source lines, verified breakpoint locations, changed-variable flags, structured errors, and next-step hints on every tool. Designed, wire-validated.
2. **Debugger power controls** — SQL cost per frame at a break, break on unhandled errors only, abort a hung operation, read source for objects not on local disk. Designed, wire-validated against a live BC28.
3. **CPU profiling** (`bcdev_profile_*`) — **shipped.** Capture a sampling CPU profile (`.alcpuprofile`, V8 format) of a live session and get back a ranked AL-hotspot summary, not just a blob. Four tools (status/start/poll/finish), validated end-to-end against a live BC28 — a real profile with AL call frames captured through the tools (`scripts/e2e-profile-results-2026-07-04.md`). (Full snapshot recording for VS Code replay shares the same core and stays deferred.)
4. **Entra ID auth** — **shipped.** Azure CLI-backed cloud sandbox/production access alongside explicit on-prem UserPassword.
5. **Coverage gap analysis** — cross procedure coverage with `git diff`: which changed procedures have no test coverage.
6. **Test orchestration** — repeat runs, diff pass/fail sets, flag flaky tests.
7. **Break-on-record-write triage** — arm write breaks on a table and auto-collect the stacks of everything that writes it.
8. **BC native MCP passthrough** — a general-purpose front door to Business Central's own MCP endpoint. BC exposes runtime-troubleshooting and server-side profiling tools there that its shipped tooling only partially surfaces (one slice isn't exposed by any Microsoft client at all); a dynamic passthrough would make the full catalog reachable from any agent.
9. **On-demand source & symbols** — fetch a server object's source, or download a single dependency package, without leaving the agent.

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
