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
- A known no-source object returned the empty result with neutral guidance that
  covers compiled-only applications and disabled source exposure.
- The exact package request returned `status:"downloaded"`.
- The written file existed only under the temporary project’s `.alpackages`
  directory, began with NAVX, contained parseable `SymbolReference.json`, and
  its returned name/app ID matched the requested package in memory.
- The returned byte count and SHA-256 matched the written file.
- Repeating the exact request returned `status:"unchanged"`.
- Omitting the app ID for that uniquely named ordinary package also returned
  `status:"unchanged"` for the same validated package.
- Requesting a lower minimum version returned `status:"unchanged"` and resolved
  to the same higher installed version.
- After the harness deliberately replaced the temporary local cache file with
  invalid bytes, the next request returned `status:"replaced"` and restored a
  NAVX package whose returned digest matched the installed bytes.
- Two simultaneous identical requests against an empty local destination
  returned one `downloaded` and one `unchanged` result for the same path.
- A large Microsoft Base Application dependency downloaded and validated within
  the default size and time limits.
- The special Microsoft Application concept downloaded with no app ID. A repeat
  carrying an irrelevant app ID still omitted that ID from selection and
  returned `unchanged` at the same path.
- A too-new version, wrong app ID, and unknown package name each returned the
  stable `NOT_FOUND` error code.
- A mistyped project path returned `CONFIGURATION_ERROR` and was not created.
- The final directory contained three `.app` files and zero `.tmp`/`.backup`
  files.
- The temporary project was deleted after the MCP client and server closed.

## Deterministic gates

- `bun test`: 649 passed, 0 failed after the deterministic review corrections.
- `bun run typecheck`: passed.
- `bun run build`: passed; four embedded skills generated.
- Package URL/query, Application app-ID omission, typed authentication,
  pre-request project validation, timeout, streamed/declared size bounds,
  corrupt/missing symbols, identity/version mismatch, identity-derived safe
  naming, simultaneous installation, safe replacement and restoration,
  response-body cancellation, symlink/junction refusal, bounded DEFLATE output,
  and cleanup are covered by unit tests.

The post-review corrections were deterministic and made no additional Sandbox
call: `SymbolReference.json` inflation is capped, the Windows backup-swap success
and restore paths use injected filesystem faults, the link guard runs as a
junction test on Windows, selector lengths and caller-adjustable request bounds
are validated, and 404 details distinguish a supplied app ID from an ID sent on
the wire. Wire comments now cite this tracked evidence instead of an unavailable
local decompilation directory.

No Production call was made.
