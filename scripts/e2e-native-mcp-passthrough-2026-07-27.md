# BC native MCP passthrough — SaaS evidence

Validated on 2026-07-27 against a Business Central 28 SaaS Sandbox through the feature's
real `bcdev_native_list` and `bcdev_native_call` handlers. The harness refused any
non-Sandbox configuration.

Tenant, environment, company, user, host, session, token, authorization, authenticated
URL, returned business data, and raw native payload values were not retained. Native
tool names and public input-schema field names are protocol metadata and are recorded
only where needed to identify the verified surface.

## Authentication and routing

- The existing Azure CLI authorization provider acquired a Business Central token and
  `bcdev_status` reached developer API 7.0 before native validation began.
- The fixed cloud native MCP gateway initialized successfully. The business catalog was
  selected by omitting `Dev`; every list/call operation closed cleanly, and no
  caller-supplied URL, token, or routing header was used.
- No Production or on-premises call was made.

## Business and AL runtime catalogs

- The default business context listed `bc_actions_search`, `bc_actions_describe`, and
  `bc_actions_invoke`.
- A keyword-mode, list-only `bc_actions_search` completed with one non-error MCP content
  block. Its returned action/business content was not retained.
- `Dev: ALRuntime` listed exactly `run_tests`.
- A disposable published test fixture ran through native `run_tests` and returned one
  non-error MCP content block. The shared native test-run slot released afterward.

## Paused-debugger catalog

- Native debugging before a break failed with `DEBUG_SESSION_NOT_PAUSED`.
- A purpose-built divide-by-zero test from the Sandbox-only `hello-bug` fixture produced
  a real debugger bind and break with usable NST session and host identity.
- `Dev: Debugging` plus the internally constructed troubleshooting header listed
  `get_stack_frames`, `get_variables`, `get_source_code`, and `add_breakpoint`.
- All four tools were invoked through `bcdev_native_call` using their discovered schemas.
  Each returned a non-error MCP content block.
- After `bcdev_debug_continue`, native debugging again failed with
  `DEBUG_SESSION_NOT_PAUSED`. The test workload finished and detach left no active
  debugger.

One live round delivered the break before asynchronous session identity reporting. That
exposed a local lifecycle ordering bug: the later identity event could incorrectly clear
the paused state. Session binding now enriches identity without changing execution state,
and a deterministic regression test covers break-before-identity as well as the usual
identity-before-break order.

## Exclusions

The public context enum contains only `business`, `runtime`, and `debugging`. The live
run made no native profiling request, and the implementation sends neither
`Dev: Profiling` nor `mcp-profiling-options`.
