# On-prem `dev/packages` — BC28 evidence

- Date: 2026-09-11
- Target: local BC28 docker container (on-prem, UserPassword), dev API 7.0
- Client: `downloadPackage` from `src/core/package-download.ts` over the real `fetch`
- Server mutations: none — every operation was an HTTP GET

This closes the one item `#13`/`#14` left open: the on-demand package path had
SaaS Sandbox evidence only, because no on-prem target was reachable when that
work landed.

## Redaction

Tenant, user, password, Authorization header, authenticated URL, and machine
paths are not recorded. The downloaded package is the stock Microsoft
`Application` concept package on a throwaway demo container, so its resolved
version and digest are retained to make this run reproducible.

## Results

- `GET dev/metadata` returned 200 under Basic authentication.
- `GET dev/packages` returned **401 without a `tenant` query parameter** and 200
  with `tenant=default`, on a single-tenant server. Same requirement the hub
  `negotiate` already carries; `packageUrl` in `package-download.ts` already
  sends it.
- The selector `Microsoft` / `Application` / minimum `1.0.0.0`, with **no app ID
  supplied**, resolved the installed concept package — the on-prem behaviour
  matches the SaaS wire evidence from 2026-07-30.
- First call returned `status:"downloaded"`, `resolvedVersion` 28.4.53241.53758
  against `requestedVersion` 1.0.0.0, `appId` c1335042-3002-4257-bf8a-75c898ccb1b8,
  18667 bytes, SHA-256 6e80099c53b4395f0fe22c62dd03ae8acd0daea9c055160047efa43b43261470.
- The installed filename was derived from the validated identity
  (`Microsoft_Application_<resolvedVersion>.app`) and the on-disk size matched the
  reported byte count.
- Repeating the identical call returned `status:"unchanged"` with the same digest
  and no `warning`, confirming the byte-identical path on-prem.

The response passed `SymbolReference.json` validation, identity checking, and
hashing before installation — the same gates the SaaS run exercised.

## Not covered here

The Windows backup-swap warning path stays deterministic unit coverage
(`tests/core/package-download.test.ts`); it needs injected filesystem faults, not
a live server.
