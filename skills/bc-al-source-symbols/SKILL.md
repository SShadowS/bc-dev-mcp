---
name: bc-al-source-symbols
description: Retrieve deployed AL source, fill .alpackages with every symbol package app.json needs, or download one installed Business Central dependency package without leaving the agent. Use when a debugger or coverage frame has no local file, or an AL project is missing symbols in .alpackages.
---

# Retrieve deployed AL source and package symbols

## Fill .alpackages from app.json

Call `bcdev_symbols_download {}` (or `{ project }`) when the compiler, al-sem, or coverage
mapping is missing symbols. It reads `app.json` (`platform` -> Microsoft/System,
`application` -> the Microsoft/Application concept, every `dependencies[]` entry) and follows
each package's own dependencies until the whole closure is in `<project>/.alpackages`.

- A package already in `.alpackages` at a satisfying version is `skipped` and not requested,
  whatever its filename. Pass `force: true` to re-request everything; byte-identical results
  report `unchanged`.
- `dryRun: true` needs no connection or credentials: it lists the app.json references (not
  their dependencies) as `skipped` or `missing`.
- One package the server cannot supply is a `failed` entry with `error.code` (`NOT_FOUND`,
  `TIMEOUT`, `SERVER_REJECTED`, `PROTOCOL_ERROR`); the rest still download and its own
  dependencies are not explored. Authentication or connectivity failures abort the call.
- Requests are sequential; a BC29 Application closure (five packages, ~75 MB) takes a few
  seconds. `timeoutMs` and `maxBytes` apply per package.

## Read one server object

Call `bcdev_source { objectType, objectId }` with the numeric identity reported by a
debugger frame or coverage result. A nonempty `content` value is the server's deployed
source. `source: "hub"` means the REST endpoint had no answer and an active debugger
provided the source instead.

`isAlContent: false` with empty content means Business Central did not return deployed AL
source. The application may be compiled-only or its source-exposure policy may disable
retrieval; do not invent source from local files or treat an empty result as a successful
source fetch.

## Download one symbol package

1. Read the missing package identity from `app.json`, an AL compiler diagnostic, or other
   trusted project metadata.
2. Call `bcdev_package_download` with `publisher`, `appName`, the four-part minimum
   `version`, and `appId` when known.
3. Use `resolvedVersion` rather than assuming the requested minimum was returned.
   `packagePath` is the validated package under `<project>/.alpackages`.
4. Rerun the compile, source mapping, or coverage operation that needed the symbols.

`status: "downloaded"` created the local package, `"replaced"` updated different bytes
for the same returned identity/version, and `"unchanged"` retained a byte-identical file.
If the result also has `warning`, the validated package is installed; review the nonfatal
local cleanup warning before deleting any stale `.backup` file.

## Guardrails

- `bcdev_package_download` downloads exactly one installed `.app`; it does not enumerate apps
  or resolve dependencies. Use `bcdev_symbols_download` for everything app.json needs.
- Neither tool deletes or renames anything already in `.alpackages`. A newer download sits
  next to an older copy of the same app (different filename); remove stale copies yourself if
  the compiler complains about duplicates.
- `version` is a minimum selector. Business Central can return a higher installed version,
  and the tool rejects a lower one or a mismatched name, publisher, or requested app ID.
- The output directory is fixed to `.alpackages`; there is no arbitrary destination.
  Packages are bounded, validated through `SymbolReference.json`, hashed, and installed
  only after the complete response passes validation.
- Package requests default to 120 seconds and 256 MiB. If a legitimate package exceeds a
  default, set `timeoutMs` or `maxBytes` deliberately; the hard limits are 300 seconds and
  512 MiB, and inflated `SymbolReference.json` output has its own runtime-safe text cap of
  at most 512 MiB.
- The selected project must already be an AL project with an `app.json`. A missing or
  mistyped project path is rejected before authentication or download and is never created.
- For the special Microsoft `Application` concept package, omit `appId`; the validated
  package request selects it by publisher, name, and minimum version. Third-party apps named
  `Application` remain ordinary app-ID selectors.
- `NOT_FOUND` cannot distinguish a missing package from an older server that does not expose
  `dev/packages`; confirm server capability when a known installed package returns that code.
- A downloaded package supplies compiler symbols and may contain source according to the
  publisher's resource-exposure policy. The tool does not extract or claim source that
  Business Central did not expose through `bcdev_source`.
- Connection defaults come from `.vscode/launch.json`. SaaS uses the current Azure CLI
  identity, or `BC_ACCESS_TOKEN` (pre-acquired bearer token, EntraId/cloud only) when set, which
  takes precedence; on-premises uses `BC_DEV_USER` and `BC_DEV_PASSWORD`.
