# Targeted debugger attach — Sandbox evidence — 2026-07-12

## Build under test

- Repository base: `origin/main` at `365b4e6d3fc2b95d36811f731082a0c2044d1bd6`
- Feature revision: pending local implementation commit
- Target: Business Central Sandbox (never Production)
- Business Central/dev API version: runtime 17.0 / dev API 7.0
- Identity availability: one account; live negative cross-user isolation is out of scope and remains unit-tested

All tenant, environment, user, host, NST session, SignalR connection, token, authorization, and authenticated URL values are omitted or represented by stable role labels. Raw authenticated logs are not retained in this tracked file.

## Automated gates

| Gate | Result |
| --- | --- |
| Upstream baseline (`bun run test`) | PASS — 415 tests before feature changes |
| Focused debugger core tests | PASS — payload, binding race/deduplication, identity, lookup failure, and rollback coverage |
| Focused MCP tool/server tests | PASS — validation, schema publication, wait events, and rollback coverage |
| Full tests | PASS — 431 tests, 0 failures, 1,230 assertions |
| Typecheck | PASS — `tsc --noEmit` |
| Build + embedded skill drift | PASS — production bundle built; 4 drift tests passed |

## Pre-acceptance live wire checks

These checks used the Sandbox and printed only booleans/mode labels. No identity or authenticated transport values were retained.

| Check | Redacted observation | Result |
| --- | --- | --- |
| Dev endpoint preflight | Sandbox runtime 17.0, dev API 7.0, core SignalR supported | PASS |
| Default WebClient arm | `Attach` accepted; detached immediately | PASS |
| Same-account `userId` WebClient arm | `Attach` accepted; detached immediately | PASS |
| Deliberately unavailable positive `sessionId` | Sandbox emitted fatal during `Attach` immediately before invocation resolution | DISCOVERY |
| Unavailable exact-session rollback after fix | Attach rejected through rollback with actionable, token-safe output | PASS |

## Live setup

- WebClient A: `SESSION_A` (real identity not recorded)
- WebClient B: `SESSION_B` (real identity not recorded)
- Available account: `USER_REDACTED`
- Repeatable AL operation/breakpoint: pending selection
- Negative wait window used for B: pending

## Acceptance observations

| Step | Expected | Redacted observation | Result |
| --- | --- | --- | --- |
| Default attach, trigger A first | `sessionBound` identifies A | Pending | Pending |
| Detach and exact attach to `SESSION_A` | Attach accepted asynchronously | Pending | Pending |
| Trigger operation in B | No `break` during documented window | Pending | Pending |
| Trigger same operation in A | `break` arrives | Pending | Pending |
| Compare exact-attach identity | Bound ID equals `SESSION_A` | Pending | Pending |
| Detach and attach with `USER_REDACTED` | Matching WebClient binds | Pending | Pending |
| Trigger matching user operation | `sessionBound` and `break` arrive | Pending | Pending |
| Final detach | No active debugger remains | Pending | Pending |

## Residual limitations

- Only one Sandbox identity is available, so cross-user negative isolation is covered by unit validation rather than a live two-user scenario.
- Production testing is intentionally excluded.
- Live acceptance remains pending until every row above has an observed, redacted result.
