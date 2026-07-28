# BC native MCP passthrough — SaaS correction evidence

Validated on 2026-07-28 against a Business Central 28 SaaS Sandbox through the
feature's real `bcdev_native_list`, `bcdev_native_call`, debugger, and debug-bound
test handlers. The harness accepted only `environmentType: "Sandbox"` and made no
Production or on-premises call.

Tenant, environment, company, user, host, session, token, authorization,
authenticated URL, returned business data, native result bodies, and raw server
payloads were not retained. Native tool names and public input-schema field names
are protocol metadata and are recorded only to identify the verified surface.

## Authentication and catalogs

- The active Azure CLI identity acquired a Business Central token, reached the
  Sandbox companies API, and selected a company without printing or retaining its
  identity.
- The business context initialized with server identity decoration and listed
  `bc_actions_search`, `bc_actions_describe`, and `bc_actions_invoke`.
- A list-only, keyword-mode `bc_actions_search` call returned one non-error MCP
  content block. No returned action or business content was retained.
- The runtime context initialized with server identity decoration and listed
  `run_tests`; its public input fields remained `testCases` and optional
  `companyName`.
- Native `run_tests` executed one passing method from the already-published
  disposable fixture and returned one non-error MCP content block. The shared
  singleton test-run slot was released afterward.

## Paused-debugger context

- A manual debugger attached to the disposable test fixture. Native debugging
  before the break failed with the typed `DEBUG_SESSION_NOT_PAUSED` result.
- The debug-bound failing test produced both a usable bound NST identity and a
  real error break.
- The debugging context initialized with server identity decoration and listed
  `get_stack_frames`, `get_variables`, `get_source_code`, and `add_breakpoint`.
  The public schemas retained their expected context/frame/object fields.
- `get_stack_frames` returned one non-error MCP content block through
  `bcdev_native_call`.
- After `bcdev_debug_continue`, native debugging again failed with
  `DEBUG_SESSION_NOT_PAUSED`. The test-run slot released and detach left no
  active debugger.

## Review-correction boundaries

This happy-path rerun confirms that the six review corrections did not regress
the verified SaaS surface. Failure and compatibility cases that should not be
induced against a shared Sandbox remain deterministic:

- an operation-phase native runtime timeout returns
  `upstreamRunCancelled: false`, is non-retryable, and warns that the upstream
  run may still be executing before the local lock is reused;
- authorization and connection timeouts remain retryable because no upstream
  tool invocation began;
- bare JWT-shaped strings are redacted from upstream error detail;
- a successful list or call survives missing initialization identity decoration
  with `server: null`;
- every operation creates and closes a fresh upstream MCP session;
- typed debugger-state errors remain authoritative without loose
  message-derived identity or paused-state classification.

No timeout, malformed server identity, token echo, or concurrent debugger resume
was deliberately induced live.
