---
name: bc-al-source-symbols
description: Retrieve deployed AL source or download one installed Business Central dependency symbol package without leaving the agent. Use when a debugger or coverage frame has no local file, or an AL project is missing one .app package in .alpackages.
---

# Retrieve deployed AL source and package symbols

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

- The package tool downloads exactly one installed `.app`; it does not enumerate apps,
  resolve transitive dependencies, or reproduce the AL extension's full Download Symbols
  command. Repeat it only for package identities the project actually needs.
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
  identity; on-premises uses `BC_DEV_USER` and `BC_DEV_PASSWORD`.
