# Agent-grade responses — SaaS Sandbox evidence (2026-07-20)

Scope: current local `feature/agent-grade-responses` build against a Business Central SaaS
Sandbox. No Production calls were made. This record intentionally excludes tenant, environment,
company, user, host, session, connection, subscription, token, authorization header, and
authenticated URL values.

## Results

| Contract | Redacted observation | Result |
|---|---|---|
| Success guidance | All 17 tools advertised `nextSteps` in `tools/list`; live status, test, attach, wait, variables, breakpoint, continue, and detach results returned arrays | PASS |
| Machine error | `bcdev_debug_wait` without a session returned `isError:true`, no `structuredContent`, parseable JSON, `NO_DEBUG_SESSION`, typed retryability, tool identity, and recovery steps | PASS |
| Ordinary run summary | One real published Sandbox test passed; `summary.outcome`, real-method total, synthetic count, and `nextSteps` were present | PASS |
| Debug-bound summary | A real `testRunFinished` carried one result row, `summary`, and `nextSteps`; `sessionBound` and `detached` lifecycle events also arrived | PASS |
| Breakpoint verification | At a real WebClient record-write break, `AddBreakpoint` returned `verified` with a non-null server-resolved 1-based span; step-over produced another break | PASS |
| Variable flags | Every returned variable normalized to a documented `changeState` plus boolean `changed`; the observed step emitted no `changed:true` node | PASS (no changed state observed) |
| Failed-test parsing | The already-installed intentional-failure probe produced a row but did not fail on this tenant, so no live SaaS AL Callstack was available | NOT OBSERVED |

The failed-test parser remains covered with the exact raw `AL Callstack:` shape captured from live
BC28 evidence, including CRLF input, source mapping, unrecognized/localized-line retention, opaque
fallback, raw-output preservation, and synthetic-row exclusion. No app was published or tenant data
changed solely to manufacture a failure for this check.

## Review-correction rerun

The corrected branch was rerun against the same SaaS Sandbox after making source mapping lazy and
adding the cached developer-metadata feature preflight. The MCP contract check passed, metadata
reported test-running support, an ordinary published test passed with its structured summary, and a
debug-bound test returned `testRunFinished`, `sessionBound`, and `detached` with the enriched result.
The run exited successfully. The already-installed failure probe again did not fail, so no new live
call-stack claim is made.

## Additional observations

- The selected published object did not expose deployed source through the Sandbox REST route;
  `bcdev_source` returned its documented empty, non-AL result with `nextSteps`. This does not affect
  debugger stack mapping from the local project.
- A very fast debug-bound test can finish before asynchronous debugger configuration is applied on
  this Sandbox. The observed order was `testRunFinished`, `sessionBound`, `detached`; the enriched
  result contract still arrived correctly. Breakpoint and variable response validation therefore
  used a WebClient workload, which produced a stable live pause.
- The temporary harnesses were stored only under ignored `scratch/`. All debugger connections were
  detached or closed. No cross-fork PR was created.
