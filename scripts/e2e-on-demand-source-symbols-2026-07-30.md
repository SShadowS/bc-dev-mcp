# On-demand source and symbols — SaaS Sandbox evidence

- Date: 2026-07-30
- Target: Business Central SaaS Sandbox
- Client: built `dist/index.js` over MCP stdio
- Server mutations: none

## Redaction

The validation output retained only booleans, lifecycle statuses, stable error
codes, file counts, and equality checks. Tenant, environment-specific identity,
user, token, Authorization header, authenticated URL, package selector values,
returned source text, package filename, SHA-256 value, and machine paths were
not recorded.

The target package was an already-published disposable demo with source exposure
enabled. The harness created and removed a temporary local AL project. Every
Business Central operation in this run was an HTTP GET.

## Built-server results

- `tools/list` exposed both `bcdev_source` and `bcdev_package_download`.
- `resources/list` exposed `skill://bc-al-source-symbols/SKILL.md`.
- `bcdev_source` returned `source:"rest"`, `isAlContent:true`, and deployed
  source matching the requested disposable codeunit identity.
- The exact package request returned `status:"downloaded"`.
- The written file existed only under the temporary project’s `.alpackages`
  directory, began with NAVX, contained parseable `SymbolReference.json`, and
  its returned name/app ID matched the requested package in memory.
- The returned byte count and SHA-256 matched the written file.
- Repeating the exact request returned `status:"unchanged"`.
- Requesting a lower minimum version returned `status:"unchanged"` and resolved
  to the same higher installed version.
- A too-new version, wrong app ID, and unknown package name each returned the
  stable `NOT_FOUND` error code.
- The final directory contained one `.app` and zero `.tmp`/`.backup` files.
- The temporary project was deleted after the MCP client and server closed.

## Deterministic gates

- `bun test`: 638 passed, 0 failed.
- `bun run typecheck`: passed.
- `bun run build`: passed; four embedded skills generated.
- Package URL/query, Application app-ID omission, authentication, timeout,
  streamed/declared size bounds, corrupt/missing symbols, identity/version
  mismatch, unsafe names, safe replacement, and cleanup are covered by unit
  tests.

No Production call was made.
