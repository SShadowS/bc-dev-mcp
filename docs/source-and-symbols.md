# On-demand source and symbols

`bcdev_source` reads the deployed source for one numeric object identity. Use it when a debugger
frame or coverage row has no local file. Empty content with `isAlContent:false` means Business
Central did not expose deployed AL source; the tool does not substitute potentially stale local
source.

`bcdev_package_download` retrieves one explicitly identified installed `.app` through
`dev/packages` and writes it to the selected project’s `.alpackages` directory. Supply the
publisher, name, four-part minimum version, and app ID when known. Business Central may resolve a
higher installed version; the result reports both requested and resolved versions. The selected
project must already contain `app.json`.

The package is size- and time-bounded, validated through `SymbolReference.json`, checked against
the requested identity, hashed, and only then installed under a filename derived from the returned
metadata. A byte-identical file returns `unchanged`; different validated server bytes replace the
same package path. A nonfatal `warning` can report that the validated replacement succeeded but a
stale `.backup` file could not be removed. This is deliberately a single-package operation, not dependency enumeration or
full Download Symbols synchronization. The default request bounds are 120 seconds and 256 MiB;
`timeoutMs` and `maxBytes` can raise them to hard limits of 300 seconds and 512 MiB. Inflated symbol
metadata is independently capped at the runtime-safe text limit (at most 512 MiB). A `NOT_FOUND`
response can mean either no installed package matched or the target server does not expose
`dev/packages`.

`bcdev_symbols_download` does what the AL extension's Download Symbols does, from the project's
`app.json`: `platform` selects Microsoft/System, `application` the Microsoft/Application package,
and each `dependencies` entry its app. It then reads every package's manifest and follows its
dependencies until the whole closure is local. A package already in `.alpackages` at a satisfying
version (any filename) is skipped without a request; `force: true` re-requests everything. Requests
are sequential, one per package, with the same validation and bounds as `bcdev_package_download`
(per package). The cache is always `<project>/.alpackages`, and nothing already in it is deleted or
renamed. A package the server cannot supply is reported `failed` with its error code while the rest
continue; authentication or connectivity failures abort. `dryRun: true` lists the `app.json`
references and their cache status without a connection or credentials.

[Back to README](../README.md)
