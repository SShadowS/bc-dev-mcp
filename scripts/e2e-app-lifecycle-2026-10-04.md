# App lifecycle (`bcdev_app_*`) — BC28 evidence

- Date: 2026-10-04
- Target: local BC28 docker container (on-prem, UserPassword), BC 28.4.53241.53758, dev API 7.0
- Client: the four `bcdev_app_*` tool handlers (`bcdev_app_list`, `bcdev_app_publish`, `bcdev_app_uninstall`, `bcdev_app_unpublish`) over the real `fetch` (POST/publish) and the real HTTP/1.0 client (on-prem Automation GETs), `timeoutMs` 30000 on every call
- Server mutations: two throwaway probe apps (publisher "SShadowS Probe", `probe-base` and `probe-dependent`), published, upgraded, uninstalled and unpublished again. The run ended with zero probe apps, verified with `bcdev_app_list`.

## Redaction

User, password, Authorization header, authenticated URLs, machine paths, tenant
specifics and correlation IDs are not recorded. The probe apps are generated,
carry no data, and exist only for this run.

## 2026-10-03 curl probe (raw HTTP, before the tools existed)

| # | Finding |
|---|---------|
| 1 | Automation API on-prem: `http://<host>:7048/<instance>/api/microsoft/automation/v2.0/companies(<id>)/extensions?tenant=<t>`. The `extension` key is `packageId`; properties `packageId, id (appId), displayName, publisher, versionMajor/Minor/Build/Revision, isInstalled, publishedAs`. |
| 2 | Bound actions `Microsoft.NAV.install`, `uninstall`, `uninstallAndDeleteExtensionData`, `unpublish` take only the binding parameter — no cascade/dependents option. |
| 3 | Bodyless POST without length → 411 from HTTP.sys. Always send `Content-Length: 0`. |
| 4 | `uninstall` on an app with an installed dependent → 204, and the dependent is uninstalled too, with no notice in the response. `install` does not cascade. |
| 5 | `unpublish` while installed → 400 `Application_DialogException` ("cannot be unpublished because it is installed"). |
| 6 | `unpublish` while a dependent is still published (uninstalled) → 400 `code:"Unknown"`, message names the dependents ("required by the following apps"). |
| 7 | Unknown `packageId` → 404 `BadRequest_ResourceNotFound`. |
| 8 | `publishedAs` arrives with a leading space (`" Dev"`, `"Global"`) — trimmed by the client. |
| 9 | Dev-endpoint publish: `POST dev/apps?tenant=…&SchemaUpdateMode=<lower>&DependencyPublishingOption=<lower>`, multipart part named after the file. Success 200. Failure (missing dependency) → 422 JSON `{Message, ErrorType:"InvalidOperation"}`. |

## Tool run, 2026-10-04 (probe-base 1.0.0.0/1.0.0.1/1.0.0.2, probe-dependent 1.0.0.0 requiring base ≥ 1.0.0.0)

| Step | Result |
|------|--------|
| `bcdev_app_list` (publisher filter) | OK, empty |
| publish base, synchronize | OK `published`, identity (appId, name, publisher, 1.0.0.0, bytes) read from the package |
| publish dependent, synchronize | OK `published` |
| republish identical base package | `SERVER_REJECTED`, HTTP 422, `bcErrorCode` `InvalidOperation`, "A duplicate package ID is detected… same package ID already exists"; first nextStep is the Global-scope list/uninstall/unpublish hint |
| republish base 1.0.0.1, recreate | OK `published` |
| republish base 1.0.0.2, forcesync | OK `published` |
| `bcdev_app_list` | two rows: base 1.0.0.2 and dependent 1.0.0.0, both `isInstalled: true`, `publishedAs: "Dev"` (dev publish replaces the older base version; only one remains) |
| unpublish base while installed | `SERVER_REJECTED`, 400, `Application_DialogException`, "cannot be unpublished because it is installed" |
| uninstall base (`deleteData: true`) | OK `uninstalled`, `dataDeleted: true`, `alsoUninstalled` contains `probe-dependent`; nextSteps mention the cascade |
| uninstall base again | OK `alreadyUninstalled`, `alsoUninstalled: []` |
| unpublish base while dependent published | `SERVER_REJECTED`, 400, `bcErrorCode` `Unknown`, message names `probe-dependent` |
| unpublish dependent | OK `unpublished` |
| unpublish base | OK `unpublished` |
| unpublish base again | `NOT_FOUND`, nextStep points at `bcdev_app_list` |
| publish dependent without base | `SERVER_REJECTED`, 422, `InvalidOperation`, "Extension compilation failed… AL1024 … probe-base … could not be loaded"; Global-scope hint is the first nextStep |
| `bcdev_app_list` | OK, empty (container clean) |

All outputs validated against each tool's output schema.

## New wire facts from this work

- **HTTP/1.1 chunked tail stall on the Automation API.** For larger responses
  (for example the unfiltered extensions list) the API services never send the
  tail of the chunked body. The request stays open and holds one of roughly five
  per-user API slots until the service restarts. After the slots are used up,
  every authenticated request on port 7048 hangs and the server logs event 705
  ("Request was throttled. It either timed-out or was cancelled. The OData
  operation was canceled by the user."). Unauthenticated requests still return
  401 immediately, and the dev endpoint on 7049 keeps working.
- **HTTP/1.0 returns the full body.** The same unfiltered list over HTTP/1.0
  came back complete: 57,767 bytes, 167 rows, 0.1 s. On-prem Automation GETs
  therefore use an HTTP/1.0 client; POSTs, publish and SaaS keep `fetch`.
- `isInstalled` cannot be used in `$filter` (400 `BadRequest_NotSupported`);
  filtering is by `publisher` and `id` only.
- Republishing a byte-identical package is refused: 422 `InvalidOperation`
  "duplicate package ID". A rebuilt package with a higher version replaces the
  published one (recreate and forcesync both 200).
- Publishing a lower version than one whose data was retained is refused: 422
  "Cannot install … because a newer version … was already installed". An
  uninstall without `deleteData` keeps that version marker through unpublish;
  `deleteData: true` clears it.
- The two earlier attempts on the same day were wedged by the stall above
  (every call after the first few timed out, event 705 at the client timeout
  cadence); both were cleared by a service restart and are explained by the
  slot exhaustion, not by the tool logic.

## Known server behaviours

- A BC28 API-services hang (event 705 throttling) was observed before this run
  and cleared by a service restart; the cause was later traced to the chunked
  tail stall described above.

## Open items

- SaaS Sandbox re-run (no SaaS credentials on this machine): Automation URL
  without tenant query, PTE list/uninstall/unpublish, and `dev/apps` publish.
- The Global-scope replace refusal named in #47 was not reproduced (it needs a
  `Publish-NAVApp -Scope Global` on the host).
