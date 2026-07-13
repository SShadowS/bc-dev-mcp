# Targeted debugger attach — Sandbox evidence — 2026-07-12

## Build under test

- Repository base: `origin/main` at `365b4e6d3fc2b95d36811f731082a0c2044d1bd6`
- Feature revision validated live: local commit `76b271c` (not pushed before interactive acceptance)
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
| Read-only standard API session lifecycle | API returned 200; `sessionBound` warning followed the short-lived session's detach and debugging cleanup remained usable | PASS — nonfatal warning path |

## Live setup

- WebClient A: `SESSION_A` (real identity not recorded)
- WebClient B: `SESSION_B` (real identity not recorded)
- Available account: `USER_REDACTED`
- Repeatable AL operation: edit and save one Item field with `breakOnRecordWrite: true`
- Negative wait window used for B: 15 seconds

The default attach was exercised first and reported a successful identity before an Item-write break. On this Sandbox build, `StopDebugging` retires that debugged WebClient NST request: three attempts to reuse the just-captured ID after detach (including immediate detach while paused) correctly failed as unavailable. The exact-target isolation test therefore selected a separate, already-active WebClient A through a read-only Admin Center active-session lookup. The selected ID stayed only in process memory. This validates the product contract—exact attach requires an existing active NST session—without adding active-session enumeration to the feature.

## Acceptance observations

| Step | Expected | Redacted observation | Result |
| --- | --- | --- | --- |
| Default attach, trigger A first | `sessionBound` identifies A | Successful identity event and Item-write break observed | PASS |
| Detach, then reuse the retired debugged request ID | Server reports the ID unavailable | Actionable, token-safe exact-attach rejection observed on three timing variants | PASS — lifecycle/rollback behavior |
| Exact attach to independently active `SESSION_A` | Attach accepted asynchronously | Attach returned before workload interaction; binding followed independently | PASS |
| Trigger operation in B | No `break` during documented window | No break during the full 15-second window | PASS |
| Trigger same operation in A | `break` arrives | Break observed; one duplicate record-write stop was continued | PASS |
| Compare exact-attach identity | Bound ID equals selected `SESSION_A` | In-memory equality assertion passed | PASS |
| Detach and attach with `USER_REDACTED` | Matching WebClient binds | A newly opened same-account WebClient produced a successful identity event | PASS |
| Trigger matching user operation | `sessionBound` and `break` arrive | Both observed; repeated Item-write stops were continued automatically | PASS |
| Final detach | No active debugger remains | Harness completed and exited cleanly after detach | PASS |

## Residual limitations

- Only one Sandbox identity is available, so cross-user negative isolation is covered by unit validation rather than a live two-user scenario.
- Production testing is intentionally excluded.
- The Sandbox retires the NST request that was being debugged when `StopDebugging` runs, so a captured-then-detached WebClient request ID is no longer a valid positive exact target. Exact isolation was proven against a separately active WebClient session instead.
