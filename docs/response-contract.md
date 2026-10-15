# Agent response contract

## Success results

Successful tool calls remain backward-compatible objects and add a required `nextSteps: string[]`.
The array is contextual and may be empty when the result is terminal or no useful action follows.
Test runs add `summary`; failed method rows add `failure.message`, `failure.parsed`, and predictable
`failure.callStack` frames. The original `output` and each frame's `raw` text are retained so an
unrecognized or localized server format never loses evidence. Local source mapping is lazy and
best-effort: passing runs without coverage do not scan the AL tree, indexes are reused per MCP
server and project, and an unreadable/missing project preserves the server evidence plus a
nonfatal `sourceMappingWarning` that identifies whether call-stack or coverage file mapping was
unavailable.

## Errors

MCP errors intentionally omit `structuredContent` (the protocol has no negotiated structured-error
channel here). Their text content is a JSON object with stable `error.code`, `category`, `message`,
`retryable`, `tool`, redacted `details`, and recovery `nextSteps`, so agents can parse it without
scraping prose while existing MCP clients still receive a normal `isError: true` response. Expected
launch configuration, Azure CLI authentication, active-profile, SQL-insight, and unsupported-server
failures are typed where they originate; message matching is only a defensive fallback. String
detail values are redacted, and sensitive detail keys fail closed to `[REDACTED]`.
`error.code` is either a toolbox core code shared across the BC toolbox (`TOOLBOX_CORE_ERROR_CODES`)
or a bc-dev-mcp extension code for server-specific state (`BC_DEV_MCP_ERROR_CODES`, e.g.
`NO_DEBUG_SESSION`); both live in `src/core/agent-errors.ts` with the extension rule. Clients that
don't recognise an extension code should fall back to `category` and `retryable`.
If an installed MCP SDK no longer exposes the private validation-error formatting seam, the server
warns and continues with the SDK's default formatting instead of refusing to start.

## Guidance

Debugger guidance accounts for asynchronous binding: next-session/user-filtered attach tells the
agent to create or trigger the matching session before waiting, exact-session attach waits for
confirmation before driving the operation, and a timeout reminds the agent to confirm the workload
was triggered. Profiling guidance similarly branches on reachability, feature support, every poll
status (`Initialized`, `Started`, `Finished`, or `Failed`), and whether the capture actually
contained data. Test-running support is preflighted only after atomically claiming the shared
single-run slot, so concurrent direct/debug-bound calls cannot pass the feature gate together. A
successful capability result is cached for 60 seconds and the metadata request times out after 15
seconds, preventing a stale or hung preflight from holding that slot indefinitely.

[Back to README](../README.md)
