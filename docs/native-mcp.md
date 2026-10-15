# BC native MCP passthrough

`bcdev_native_list` and `bcdev_native_call` connect to Business Central's cloud MCP gateway with
the same launch configuration and Azure CLI identity used by the other SaaS tools. Each operation
requires one explicit context and, on cloud, an exact `company` (on-prem: see below):

- `business` lists the dynamic `bc_actions_*` catalog. Pass `configurationName` only when selecting
  a named Business Central MCP configuration.
- `runtime` lists the BC28 AL runtime catalog. Native runtime calls share the same singleton
  test-run lock as `bcdev_test_run`, `bcdev_test_orchestrate`, and
  `bcdev_debug_run_tests`.
- `debugging` lists troubleshooting tools for the active manual debugger. Attach, trigger the
  workload, and wait for a `break` first; a merely bound or resumed session is rejected.

Always list before calling and follow the returned native `inputSchema`. The generic call is marked
potentially destructive because its safety cannot vary dynamically with the chosen upstream tool.
Its `result` is the unchanged native `CallToolResult`; `result.isError: true` therefore remains
available with all upstream evidence instead of being rewritten as a bridge error.

Each list or call uses a fresh upstream MCP session and closes it before returning. Prefer the
first-class debugger tools for repeated inspection because they reuse the existing debugger hub.
Native debugging snapshots the paused session identity at call start; do not resume that debugger
concurrently with an in-flight native call.

If a native runtime invocation times out after its upstream call begins, Business Central may
still be running the tests even though the local singleton slot has been released. That timeout
is non-retryable and tells the caller to confirm the server-side run finished before retrying or
starting any other test run.

Cloud: Sandbox and Production (live acceptance Sandbox-only). On-prem: see below (verified live on BC 29, one server).

**On-prem and docker.** Pass the on-prem connection (`server`, `serverInstance`, `tenant`, or a
`launch.json` with `environmentType: "OnPrem"`) and the same tools talk to the server's own MCP
endpoint, `<server>:<apiPort>/<instance>/mcp/`, with your `BC_DEV_USER` / `BC_DEV_PASSWORD`.
It is on the API/OData port (`apiPort`, default `BC_DEV_API_PORT` or 7048), not the SOAP port
7047, and needs `McpServicesEnabled` on the server (a wrong port, e.g. 7047, comes back as
`UNSUPPORTED_SERVER` naming the port and the setting; a disabled service is expected to fail the
same way but has not been tested). `company` is optional on-prem: without it BC uses its default
company. `business` and `runtime` are verified live; `debugging` is accepted but unverified on-prem.
**Plain `http://` sends Basic credentials unencrypted**: use it only for local or dev containers,
and HTTPS for anything else.

Its contexts intentionally match the verified BC28 surface and do not include native profiling;
the existing `bcdev_profile_*` snapshot tools are separate and unchanged.

[Back to README](../README.md)
