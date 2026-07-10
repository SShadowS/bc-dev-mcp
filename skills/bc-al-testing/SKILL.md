---
name: bc-al-testing
description: Run AL tests against a Business Central dev endpoint with the bc-dev-mcp tools — discover test codeunits, run them with structured per-method results, optionally collect code coverage. Use when asked to run, re-run, or triage AL tests on a BC server.
---

# Running AL tests against Business Central

## Workflow

1. `bcdev_status` — preflight. Confirms the dev endpoint is reachable, credentials work,
   and `supportsTestRunning` is true (requires dev API `WebApiVersion >= 7.0`, i.e. BC28+).
   Call this first whenever anything else fails.
2. `bcdev_test_discover` — pure filesystem scan of the AL project for test codeunits
   (`Subtype = Test`) and their `[Test]` methods. No server involved. Use the returned
   `codeunitId` values in the next step.
3. `bcdev_test_run { codeunits: [{ id: <codeunitId> }] }` — runs on the server, returns
   per-method `passed | failed | skipped` with duration and failure output (message +
   AL callstack). Restrict with `methods: ["Name"]`; pick the company with `company`.

## Facts that save you time

- **One run at a time.** A second `bcdev_test_run` while one is active fails with
  "already running" — wait and retry.
- **Coverage:** pass `coverage: "procedure"` (validated against real BC). `"line"` is
  unproven — do not trust it without independent verification. Covered procedures map
  back to local source files when the object IDs exist in the project.
- **Tests run in codeunit declaration order**, not the order of your `methods` array.
- **Synthetic results:** the run summary can contain an extra entry with an empty
  method name (a server-side quirk, e.g. after watch evaluations). Ignore entries with
  an empty `method`.
- The tests must already be published to the server (publish via the dev endpoint or
  VS Code AL extension); this server runs tests, it does not publish apps.
- Connection defaults come from the project's `.vscode/launch.json`; credentials from
  `BC_DEV_USER` / `BC_DEV_PASSWORD`. Auth failures name the env vars to check.

## Debugging a failing test

Switch to the bc-al-debugging skill (skill://bc-al-debugging/SKILL.md): attach the
debugger with break-on-error, run the same codeunit via `bcdev_debug_run_tests`, and
inspect live state at the failure line.
