# Configuration details

## Authentication

Connection-opening tools accept the corresponding target fields; session-scoped tools reuse their attached authorization provider. On-premises `UserPassword` and SaaS Entra are explicit separate modes and never fall back to each other. Windows and on-premises AAD are not currently supported. For upgrade compatibility, an on-prem launch configuration that still says `"authentication": "Windows"` or `"AAD"` continues to use UserPassword only when both `BC_DEV_USER` and `BC_DEV_PASSWORD` are present; otherwise it fails with an actionable unsupported-mode error.

Example SaaS launch configuration:

```jsonc
{
  "type": "al",
  "request": "launch",
  "environmentType": "Sandbox",
  "environmentName": "Sandbox",
  "tenant": "00000000-0000-0000-0000-000000000000"
}
```

Azure access tokens are acquired with `az account get-access-token`, cached only in memory until shortly before expiry, and never logged or written by this project. A `BC_ACCESS_TOKEN` is never logged either; once its JWT `exp` has passed, calls fail with `AUTHENTICATION_FAILED` (it is not refreshed).

## al-sem and bc-mdc-converter resolution

| Setting | Source | Default | Description |
|---------|--------|---------|-------------|
| `BC_DEV_ALSEM` | env var | pinned download | Path to `alsem.exe` (al-sem), used as-is. Unset: `alsem` on PATH if it is at least the pinned version, else the pinned al-sem release binary, downloaded once into the cache and checked against its SHA-256 before it runs (`bcdev_status` reports which one: `alsem.source`). `bcdev_test_select` runs `alsem graph <project>`; `bcdev_test_orchestrate` mode `order` runs `alsem digest`/`query touches` to predict polluters (optional: absent al-sem = one warning); `bcdev_record_writes_*` runs `alsem query` for its optional static cross-check; `bcdev_profile_finish` runs `alsem analyze` for hotspot explanations (optional); `bcdev_debug_wait { effects: true }` runs `alsem query effects` + `alsem prove` (without alsem that enrichment reports `status: unavailable` instead of failing). al-sem needs no compile, shows `Codeunit.Run` and trigger paths, and states where its graph is incomplete |
| `BC_MDC_CONVERTER` | env var | pinned download | Path to the [bc-mdc-converter](https://github.com/SShadowS/bc-mdc-converter) binary, used as-is. Unset: `bc-mdc-converter` on PATH if it is at least the pinned version, else the pinned release binary, downloaded once into the cache and checked against its SHA-256 (`bcdev_status` reports which one: `converter.source`). `bcdev_snapshot_finish` decodes recordings with it; `bcdev_profile_finish` converts instrumentation captures |
| `BC_DEV_ALSEM_DOWNLOAD` | env var | on | `0` = never download al-sem (offline or locked-down hosts); al-sem then comes only from `BC_DEV_ALSEM` or PATH. The download uses Node's `fetch`, which ignores `HTTPS_PROXY`: behind a proxy, set `BC_DEV_ALSEM` |
| `BC_DEV_CACHE_DIR` | env var | `%LOCALAPPDATA%\bc-dev-mcp` / `~/.cache/bc-dev-mcp` | Where the downloaded al-sem and bc-mdc-converter live (`alsem/<version>/`, `bc-mdc-converter/<version>/`) |
| `BC_MDC_CONVERTER_DOWNLOAD` | env var | on | `0` = never download bc-mdc-converter; without one, `bcdev_snapshot_finish` returns `decodeStatus: "raw"` with the saved zip |
| `BC_DEV_ALTOOL` | env var | `altool` on PATH | Path to `altool.exe` (AL extension `bin` folder); the fallback engine, via its `graph` command |

[Back to README](../README.md)
