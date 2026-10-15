# bc-dev-mcp

MCP server for Business Central AL development: run tests (with code coverage) and debug interactively against a BC server's dev endpoint — the same SignalR hubs the AL VS Code extension uses.

[![npm](https://img.shields.io/npm/v/bc-dev-mcp)](https://npmjs.com/package/bc-dev-mcp)
[![Node](https://img.shields.io/badge/node-22+-green)](https://nodejs.org)
[![BC dev API](https://img.shields.io/badge/BC%20dev%20API-%E2%89%A57.0-purple)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why bc-dev-mcp

Microsoft's AL tooling makes agents good at **writing** AL: the `altool launchmcpserver` server
compiles, builds, publishes, searches symbols and manages translations. bc-dev-mcp makes them good
at **checking** it: is the change tested, why does a test fail, what does this code do at runtime,
where is the time going. Use both: `al` to write, bc-dev-mcp to verify.

What you gain over Microsoft's MCP servers (checked against AL Language 30.0, `altool` 30.0.43,
2026-10-14: the `al` server's 16 tools, the profiling proxy's 4 and the snapshot proxy's 4):

| You want to… | Microsoft's MCP | bc-dev-mcp |
|---|---|---|
| Debug from any MCP client (Claude Code, Codex, Cursor, …) | No debugger tool. BC's cloud native MCP has `debugging` tools, but only for a session a debugger has already attached to and paused, and only in the cloud | Attach (next session, user or session ID), breakpoints, break on error or record write, step, variables, watch, eval, abort; on-prem, docker and SaaS |
| Debug a failing test | No | `bcdev_debug_run_tests`: breakpoints fire inside the test run |
| Find and run tests | `al_run_tests`: one codeunit ID, pass/fail counts and failure details | Discovery from source (incl. `TransactionModel`), multi-codeunit plans, per-method results and durations, parsed AL call stacks mapped to your files |
| Know whether the change is tested | No coverage over MCP (the `altool runtests` CLI has it) | Procedure coverage mapped to source and crossed with your Git diff: which changed procedures the tests did and did not reach; Cobertura XML export for CI |
| Run only the tests that matter | No | `bcdev_test_select`: diff → ranked tests via whole-program call graph + coverage history, with `bcdev_test_run`-ready shards |
| Catch flaky and order-dependent tests | No | Repeat runs with pass/fail diffs; `mode: "order"` finds victims and bisects each to its polluter |
| Find who writes a record | No | Record-write triage: capture every write to one table, grouped by writer stack, cross-checked against static writers |
| Understand a slow session | Profiling proxy returns `.alcpuprofile` files; analysis is left to the agent | Sampling or exact instrumentation capture, a ranked AL hotspot summary in the response, al-sem's static performance findings on each hotspot, hand-off to al-perf |
| See what code *can* do before it runs | No | al-sem enrichments: risk of uncovered changes (commits, writes, UI), effects of the routine at a breakpoint, predicted test-order polluters |
| Clean up apps without host access | `al_publish` only | List, publish, uninstall, unpublish over HTTP; reports apps BC uninstalled with it |
| Rely on the output | None of the 24 tools publishes an `outputSchema` | Every tool has an `outputSchema` and `structuredContent`, stable error codes with `nextSteps`, usage skills served over MCP, MCP 2026-07-28 |

Microsoft's own extras are worth keeping: symbol search, page inspection, translations and object IDs.

## Overview

| Metric | Value |
|--------|-------|
| Runtime | Bun (dev/build) · Node 22+ (dist) |
| Runtime dependencies | 5 (`@microsoft/signalr`, `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `zod`, `@sshadows/bc-toolbox-envelope`) |
| Transport | MCP over stdio (protocol 2026-07-28 and 2025-11-25 clients) |
| Tools | 34 `bcdev_*` tools, plus 5 usage skills served over MCP |
| Server requirement | BC dev API `WebApiVersion >= 7.0` (AL 18 platform, e.g. BC28) |
| Auth | Azure CLI / Entra ID or a pre-acquired `BC_ACCESS_TOKEN` (SaaS) · UserPassword (on-prem / docker) |
| Validation | Live E2E against BC28, BC29 and SaaS Sandbox (`scripts/e2e.md`) |

## Features

| Feature | Description |
|---------|-------------|
| **Test runs** | Discovery from source or compiled `.app`s, multi-codeunit plans, per-method results and durations, parsed AL call stacks mapped to your files — [docs/testing.md](docs/testing.md) |
| **Coverage** | Procedure coverage mapped to source, crossed with a Git diff (`coverageAgainst`), Cobertura XML export for CI (`coberturaFile`) |
| **Test selection** | Turn a Git diff into ranked, ready-to-run test shards from a whole-program call graph (al-sem, or `altool graph`) plus coverage history |
| **Flaky and order-dependent tests** | Repeat a selection and diff pass/fail sets; `mode: "order"` finds order-dependent victims and bisects each to its polluter |
| **Interactive debugging** | Attach by next session, user or session ID; breakpoints, break on error or record write, stepping, variables, watch, eval, live SQL cost — [docs/debugging.md](docs/debugging.md) |
| **Record-write triage** | Capture every write to one table, grouped by writer stack, cross-checked against al-sem's static writers |
| **Profiling and snapshots** | Sampling or instrumentation CPU profiles with a ranked hotspot summary; snapshot capture of sessions you cannot pause, decoded into variables and call stacks — [docs/profiling-and-snapshots.md](docs/profiling-and-snapshots.md) |
| **BC native MCP passthrough** | List and call Business Central's own MCP tools (business actions, AL runtime, paused debugger), cloud and on-prem — [docs/native-mcp.md](docs/native-mcp.md) |
| **Source and symbols** | Read deployed source for off-disk objects; fill `.alpackages` from `app.json` — [docs/source-and-symbols.md](docs/source-and-symbols.md) |
| **App lifecycle over HTTP** | List, publish, uninstall and unpublish apps without PowerShell or host access |
| **Agent-grade responses** | Schema-validated `structuredContent`, contextual `nextSteps`, stable redacted error codes — [docs/response-contract.md](docs/response-contract.md) |
| **Zero setup** | Server/instance/tenant from `.vscode/launch.json`; al-sem and bc-mdc-converter fetched on demand (pinned, SHA-256-verified) |

## Prerequisites

- A reachable BC server with dev API `WebApiVersion >= 7.0` (check with `bcdev_status`)
- For SaaS: the standard Azure CLI, signed in to the launch configuration's tenant (`az login --tenant <tenant-id>`),
  or a pre-acquired Business Central bearer token in `BC_ACCESS_TOKEN` (takes precedence; not refreshed)
- For on-premises: UserPassword credentials for the dev endpoint
- Git on `PATH` and an AL project inside a repository when using `coverageAgainst`
- Bun (to run from source) or Node 22+ (to run the built `dist/index.js`)

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

(`bunx bc-dev-mcp` works too.) For on-premises, credentials come from the two environment variables above. For SaaS, no password environment variable is accepted: `environmentType`, `environmentName`, and `tenant` come from the AL project's `.vscode/launch.json`, and the server asks Azure CLI for an in-memory Business Central token by default, or uses `BC_ACCESS_TOKEN` for CI. Every connection-opening tool also accepts target overrides.

Running from source instead: `git clone` → `bun install && bun run build` → point `command` at `node dist/index.js`, or `bun run compile` for a standalone `bc-dev-mcp.exe`.

## Quick Start

1. `bcdev_status` — verify reachability, auth, and that test running is supported.
2. `bcdev_test_discover` — list test codeunits and `[Test]` methods.
3. `bcdev_test_run { codeunits: [{ id: 50100 }], coverage: "procedure" }` — structured results with coverage.
4. `bcdev_debug_attach { breakOnError: true }` → trigger the workload → `bcdev_debug_wait` → `bcdev_debug_variables` / `bcdev_debug_eval` → `bcdev_debug_continue` → `bcdev_debug_detach`.

The server also ships these workflows as skills (`skill://bc-al-testing/SKILL.md` and friends), so an agent can read the full playbook itself.

## Configuration

| Setting | Source | Default | Description |
|---------|--------|---------|-------------|
| `BC_DEV_USER` / `BC_DEV_PASSWORD` | env var | — | On-prem UserPassword credentials |
| `BC_DEV_ENTRA_TENANT` | env var | — | SaaS tenant fallback when launch.json does not provide `tenant` |
| `BC_ACCESS_TOKEN` | env var | — | SaaS only: pre-acquired Business Central bearer token (CI); takes precedence over Azure CLI, never refreshed |
| `environmentType` | launch.json / tool param | inferred | `OnPrem`, `Sandbox`, or `Production` |
| `environmentName` | launch.json / tool param | — | SaaS environment name |
| `server` / `serverInstance` | launch.json / tool param | — | BC server URL and instance, e.g. `http://bcserver`, `BC` |
| `port` | launch.json / tool param | `7049` | Developer service port |
| `tenant` | launch.json / tool param | `default` | Tenant (hub negotiate requires one) |
| `project` | tool param | server cwd | AL project dir for launch.json and `.al` scanning |
| `BC_DEV_API_PORT` | env var | `7048` | On-prem API/OData port: the `bcdev_app_*` tools and BC's own MCP endpoint (tool param `apiPort` overrides) |
| `BC_DEV_CALLGRAPH_ENGINE` | env var | `auto` | Call-graph engine for `bcdev_test_select`: `auto` (al-sem, else altool), `al-sem` or `altool` |
| `BC_DEV_ALSEM` | env var | pinned download | Path to `alsem.exe`; unset = PATH if new enough, else the pinned release, downloaded and SHA-256-checked |
| `BC_DEV_ALSEM_DOWNLOAD` | env var | on | `0` = never download al-sem |
| `BC_MDC_CONVERTER` | env var | pinned download | Path to the [bc-mdc-converter](https://github.com/SShadowS/bc-mdc-converter) binary; resolved like al-sem |
| `BC_MDC_CONVERTER_DOWNLOAD` | env var | on | `0` = never download bc-mdc-converter (snapshots then come back raw) |
| `BC_DEV_CACHE_DIR` | env var | `%LOCALAPPDATA%\bc-dev-mcp` / `~/.cache/bc-dev-mcp` | Where downloaded al-sem and bc-mdc-converter live |
| `BC_DEV_ALTOOL` | env var | `altool` on PATH | Path to `altool.exe`, the fallback call-graph engine |

Authentication modes, a SaaS `launch.json` example and how the helper binaries are resolved: [docs/configuration.md](docs/configuration.md).

## Architecture

```
MCP client (agent)
  |
  v  (stdio)
src/mcp/server.ts ── tools/ (34 bcdev_* tools) ── state.ts (debug/test/profile/snapshot ownership)
  |
  v
src/core/  (pure library — typed returns, injected deps)
  |-- launch-config.ts   launch.json + env credentials
  |-- authorization.ts   Basic, cached Azure CLI or BC_ACCESS_TOKEN authorization
  |-- server-info.ts     GET dev/metadata, feature gates
  |-- native-mcp.ts      BC native MCP client (cloud gateway, on-prem over HTTP/1.0)
  |-- package-download.ts bounded, validated dev/packages download into .alpackages
  |-- symbols-download.ts app.json -> full symbol closure in .alpackages
  |-- al-objects.ts      file <-> (objectType, objectId) index, test discovery
  |-- hubs/test-runner-hub.ts ──> <server>/BC/dev/TestRunnerHub   (SignalR)
  |-- hubs/debugger-hub.ts    ──> <server>/BC/dev/DebuggerHub     (SignalR)
```

## Tools

| Tool | Purpose |
|------|---------|
| `bcdev_status` | Preflight: reachability, auth, dev API version, feature gates |
| `bcdev_test_discover` | List test codeunits and `[Test]` methods from local `.al` files, a `.app` (`appFile`) or `.alpackages` (`alpackages: true`) |
| `bcdev_test_run` | Run tests with a summary, parsed/source-mapped failures, optional coverage (Cobertura export via `coberturaFile`), and Git-aware changed-procedure gaps |
| `bcdev_test_select` | Before a run: turn a Git diff into a ranked test selection (call graph + coverage history), uncoverable procedures, `bcdev_test_run`-ready shards, and a fallbackToAll flag |
| `bcdev_test_orchestrate` | Repeat one selection 2–20 times, retain every run, diff adjacent pass/fail sets, and flag flaky/incomplete methods; `mode: "order"` finds order-dependent victims, bisects each to its polluter, and attributes its table writes |
| `bcdev_debug_attach` | Arm next-session/user-filtered attach or target an existing NST session; optionally set breakpoints |
| `bcdev_debug_run_tests` | Run tests with breakpoints live |
| `bcdev_debug_wait` | Long-poll for session-bound / break / run-finished lifecycle events; `effects: true` adds what the top frame's routine can still do (commit, table writes, errors, UI) via optional al-sem |
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
| `bcdev_symbols_download` | Download every symbol package `app.json` needs into `<project>/.alpackages`; `dryRun` lists the references and their cache status |
| `bcdev_app_list` | List published apps with app ID, version, installed state, and publish scope |
| `bcdev_app_publish` | Publish and install a compiled `.app` at Dev scope through the dev endpoint |
| `bcdev_app_uninstall` | Uninstall an app; reports the dependents Business Central uninstalled with it |
| `bcdev_app_unpublish` | Unpublish one published version of an uninstalled app |
| `bcdev_native_list` | List Business Central's native MCP tool catalog for business, AL runtime, or a paused debugger |
| `bcdev_native_call` | Invoke one exact native tool and preserve its complete upstream result |
| `bcdev_profile_status` | Preflight the snapshot-debugger endpoint; report whether sampling CPU profiling is supported |
| `bcdev_profile_start` | Arm a CPU profiler (`kind: "sampling"` or `"instrumentation"`); binds the next matching session (trigger it after) |
| `bcdev_profile_poll` | Poll the active capture; `ready` once the session was recorded (Started) |
| `bcdev_profile_finish` | Finish, write the `.alcpuprofile`, return a ranked AL self-time hotspot summary, with al-sem's static performance findings when available |
| `bcdev_snapshot_start` | Arm a snapshot debugging capture with up to 20 snappoints (file + 1-based line); binds the next matching session, a user's next session, or a running `sessionId` (trigger it after) |
| `bcdev_snapshot_status` | Status of the active snapshot capture; `ready` once a session is recording (Started) |
| `bcdev_snapshot_finish` | Finish, save the recording zip and return decoded points (exceptions first, then snappoint hits) with variables, call stack and source window |
| `bcdev_snapshot_run_tests` | Run AL test codeunits attached to the armed capture (on-prem); then `bcdev_snapshot_finish` collects the recording |

## Documentation

| Document | Covers |
|----------|--------|
| [docs/testing.md](docs/testing.md) | Repeat runs, order-dependent tests, coverage-gap analysis |
| [docs/debugging.md](docs/debugging.md) | Attach and session binding, breakpoint verification, record-write triage |
| [docs/profiling-and-snapshots.md](docs/profiling-and-snapshots.md) | CPU profiling (sampling, instrumentation) and snapshot capture |
| [docs/native-mcp.md](docs/native-mcp.md) | BC native MCP passthrough, cloud and on-prem |
| [docs/source-and-symbols.md](docs/source-and-symbols.md) | Deployed source, single-package and full symbol download |
| [docs/response-contract.md](docs/response-contract.md) | Success shape, error bodies, `nextSteps` guidance |
| [docs/configuration.md](docs/configuration.md) | Authentication modes, helper binary resolution |
| [docs/skills.md](docs/skills.md) | The usage skills the server serves over MCP (SEP-2640) |
| [docs/roadmap.md](docs/roadmap.md) | Shipped roadmap items |
| [docs/capture-ship-recipe.md](docs/capture-ship-recipe.md) | Scheduled profile capture → al-perf ingest |
| [scripts/e2e.md](scripts/e2e.md) | Live wire-assumption checklist and known server behaviours |

## Key Files

| File | Purpose |
|------|---------|
| `src/mcp/index.ts` | stdio entry: builds deps, calls buildServer, connects transport |
| `src/mcp/server.ts` | buildServer: tool, resource and skills wiring (testable over InMemoryTransport) |
| `src/mcp/tools/` | The 34 bcdev_* tool definitions (zod schemas + metadata + handlers) |
| `src/mcp/state.ts` | Single-slot debug/capture/record-write state, opaque handles, event queue, run lock |
| `src/core/hubs/` | TestRunnerHub and DebuggerHub clients over a SignalR seam |
| `src/core/native-mcp.ts` | BC native MCP routing, lifecycle, and SDK transport |
| `src/core/http10.ts` | HTTP/1.0 client for BC's on-prem API port |
| `skills/` | Usage skills served over MCP (embedded by `bun run embed-skills`) |
| `scripts/e2e.md` | Real-server wire-assumption checklist + known server behaviours |

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
