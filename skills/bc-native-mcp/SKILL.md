---
name: bc-native-mcp
description: Discover and invoke Business Central 28 native MCP tools through bc-dev-mcp. Use when an agent needs BC business actions, the native AL runtime test tool, or native troubleshooting tools for an already paused AL debugger session.
---

# Use Business Central native MCP tools

## Workflow

1. Select one context and call `bcdev_native_list` with the exact `company`:
   - `business` for `bc_actions_*`;
   - `runtime` for native AL runtime tools;
   - `debugging` for troubleshooting an active paused debugger.
2. Read the returned `catalog.tools`. Use the exact `name`, `inputSchema`, and annotations;
   never invent a native tool name or argument shape.
3. Call `bcdev_native_call` with the same target, context, and company. Put only the
   upstream tool arguments in `arguments`.
4. Read `result` as the unchanged native `CallToolResult`. `result.isError: true` is an
   upstream Business Central tool failure retained as evidence, even though the bridge call
   itself completed.

Use `cursor` from `catalog.nextCursor` to continue a paged listing. A named
`configurationName` is valid only for `business`; omitting it uses Business Central's
default dynamic configuration.

## Debugging context

First use `bcdev_debug_attach`, trigger the workload, and call `bcdev_debug_wait` until it
returns a `break`. Native debugging is deliberately unavailable while merely attached,
binding, running, or after `bcdev_debug_continue`. At the break, list the `debugging`
catalog and call its tools. Finish by using `bcdev_debug_continue` or
`bcdev_debug_detach`.

Record-write triage owns its debugger internally and cannot be inspected through this
passthrough.

## Guardrails

- Prefer `bcdev_test_run` for structured summaries, source mapping, and coverage. Prefer the
  first-class `bcdev_debug_*` tools for the normal inspect/step loop. Use native passthrough
  when its catalog or raw result is specifically useful.
- Treat every `bcdev_native_call` as potentially destructive. Inspect the upstream tool's
  annotations and arguments before calling it, especially against Production.
- Do not pass tokens, authorization headers, endpoint URLs, or routing headers. The bridge
  derives them from the configured cloud target and Azure CLI identity.
- Native passthrough supports cloud Sandbox and Production. It does not expose a profiling
  context; the separate `bcdev_profile_*` tools remain the supported BC28 profiling path.
- A native `runtime` call shares the one-test-run lock with direct and debug-bound test runs.
  Wait for the active run to finish instead of retrying concurrently.
