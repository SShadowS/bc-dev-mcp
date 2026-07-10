# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Project Overview

`bc-dev-mcp` is a standalone MCP server (stdio) that exposes Business Central
dev-endpoint capabilities to agents and developers: running AL tests (with code
coverage) and interactive debugging, over the same SignalR hubs the AL VS Code
extension uses. It is not coupled to any specific BC customer or product — any AL
dev with a reachable dev endpoint (dev API `WebApiVersion >= 7.0`, i.e. the AL 18
platform / BC28) can use it.

The BC dev-endpoint protocol is undocumented; wire behaviour was established
by interoperating with the official tooling. It is documented in `// WIRE:`
comments and re-verified live per AL major (`scripts/e2e.md`).

Design specs and implementation plans live in `docs/superpowers/` (git-ignored,
machine-local); pointers in `CLAUDE.local.md`.

## Runtime & Build

- **Bun** for dev/test/build; the built artifact targets **Node 18+**.
- Runtime deps are exactly three: `@microsoft/signalr`, `@modelcontextprotocol/sdk`, `zod`. Don't add more without a design change.

```bash
bun run dev          # run the MCP server from source (stdio)
bun test             # unit tests (fake-hub based, no server needed)
bun run typecheck    # tsc --noEmit  (must stay clean)
bun run build        # bundle to dist/index.js (Node target)
bun run compile      # single executable bc-dev-mcp.exe
```

## Architecture

```
src/core/            # pure library — typed returns, injected deps, never prints/exits
  hubs/signalr-base.ts   # HubProxy seam over @microsoft/signalr; buildHubQuery; normalizeKeys
  hubs/test-runner-hub.ts# /TestRunnerHub client (Initialize/RunTests, coverage)
  hubs/debugger-hub.ts   # /DebuggerHub client (attach, breakpoints, stepping, inspection)
  server-info.ts         # GET dev/metadata preflight + feature gates
  launch-config.ts       # .vscode/launch.json (JSONC) discovery + env credentials
  al-objects.ts          # file <-> (objectType, objectId) index; test discovery
  types.ts, urls.ts
src/mcp/             # thin frontend
  server.ts              # buildServer: registerTool/registerResource wiring (testable over InMemoryTransport)
  tools/                 # the 11 bcdev_* tool definitions (zod schemas + metadata + handlers)
  skills.generated.ts    # GENERATED from skills/ by scripts/embed-skills.ts — do not edit
  state.ts               # debug session singleton, event queue, run lock
  index.ts               # stdio entry: builds deps, calls buildServer, connects transport
```

**Core rule:** everything in `src/core/` takes I/O dependencies (hub factory,
fetch, env) as parameters, returns typed data, and never calls `console.*` or
`process.exit()`. `src/` must be Node-18-compatible — **no `Bun.*` APIs in
`src/`** (Bun is only for dev/test/build; `Bun.*` in tests is fine).

The `HubProxy`/`HubFactory` seam exists so hub clients are tested against an
in-process `FakeHub` (`tests/fakes/fake-hub.ts`) — never hit a live server in unit
tests.

## Wire protocol — hard-won facts (DO NOT regress)

Every wire assumption carries a `// WIRE:` comment citing its provenance, and
is listed in `scripts/e2e.md` for live re-verification per AL major. These were each found the hard way (some only via
live E2E) — changing them will break against real BC:

- **Hub URLs:** `<server>:<port>/<instance>/dev/TestRunnerHub` and `/dev/DebuggerHub`.
- **Auth:** Basic header value sent BOTH as `Authorization` header and as the `Authentication` query param.
- **Tenant:** hub `negotiate` 401s without a `tenant` query param even on single-tenant servers — default to `"default"`.
- **Attach `SessionId` = -1** (break-on-next); `0` is rejected ("session with id 0 cannot be found").
- **`DebugAdapterConfigurationDone`** is only accepted after the debugger binds a session — fire it on the first of `HubConnected` / `OnAttachedToConnection`, not inline after `Attach`. (BC28 sends `HubConnected`, never `OnAttachedToConnection`.)
- **Line numbers:** the wire is **0-based**; the tool surface is **1-based** (editor convention). Conversion is centralized in `debugger-hub.ts` — take/report 1-based, convert at the wire boundary only.
- **Payload casing:** debugger payloads arrive dual-cased (PascalCase + camelCase); `Break` arg0 is PascalCase-only. Always run incoming payloads through `normalizeKeys`. `LocalNode` `typeName`/`summary` can be `null` on synthetic nodes → coerced to `""`.
- **`AddBreakpoint`** fails ("tenant '' not found") until the session has paused once — attach with `breakOnError`, register breakpoints at the first break.
- **App publish** (dev endpoint) needs `multipart/form-data` (`-F`), not raw octet-stream (415 otherwise).
- **Coverage payload** is procedure-level; `line` mode is unproven — validate before trusting.

## Testing against a live server

Unit tests need no server. Live-validation environment details (local BC28
docker container, credentials, compiler path) live in `CLAUDE.local.md`
(git-ignored, machine-local).

`scripts/e2e.md` is the wire-assumption + failure-scenario checklist plus a
"Known server behaviours" section; `scripts/e2e-results-2026-07-03.md` holds the
captured live evidence. Tool names are `bcdev_status`, `bcdev_test_*`, `bcdev_debug_*`;
demo transcripts predate the rename (mapping note at the top of each demo).
Three published demo apps back the walkthroughs:

- `demos/DEMO.md` / `demos/hello-bug/` — end-to-end debug of a division-by-zero.
- `demos/TYPE-ZOO.md` / `demos/type-zoo/` — all 31 AL variable types parse (incl. RecordRef/FieldRef); `CurrPage`/`CurrReport` are not exposed by the BC wire.
- `demos/OBJECT-TYPES.md` / `demos/trigger-zoo/` — break output is identical across codeunit/table/report/page (only `objectType`, trigger `methodName`, implicit globals differ; pages double-break).

## Roadmap

See README `## Roadmap`. Several items are already spec'd/wire-validated in the
local `docs/superpowers/` working docs (pointers in `CLAUDE.local.md`).

## Skills over MCP

The server serves `skills/*/SKILL.md` as `skill://` resources with a `skill://index.json`
discovery index and declares the `io.modelcontextprotocol/skills` extension capability
(tracks draft SEP-2640). Skill sources are authored in `skills/`; `bun run embed-skills`
regenerates the committed `src/mcp/skills.generated.ts` (build/dev/compile run it
automatically; a drift test fails if the generated file is stale).

## Capture-and-ship recipe

`scripts/capture-and-ship.ts` (logic in `src/core/ship/`) is a schedulable
one-shot cycle: arm BC instrumentation capture → convert with bc-mdc-converter
→ gzip → POST to al-perf `/api/ingest`. "0 sessions captured" exits 0 by
design. Operator doc: `docs/capture-ship-recipe.md`. It is a recipe, not a
daemon — per the al-perf platform umbrella spec's recipe-before-daemon rule.

## Development notes

- Windows + Git Bash with Windows paths (e.g. `U:\Git\bc-dev-mcp`). Don't use `2>nul` (creates undeletable files on Windows).
- Prefer `pwsh` for any project scripts.
- This tool has multiple consumers (colleagues + Claude Code agents), so tool
  responses and error messages must be actionable and structured, not just human prose.
- Development follows the Superpowers workflow (brainstorm → write spec → write
  plan → subagent-driven build with per-task review + live E2E). Follow it for
  new features.
