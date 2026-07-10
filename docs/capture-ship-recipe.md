# Capture-and-ship recipe — scheduled BC instrumentation captures into al-perf

One runnable script, no daemon (deliberately — see the last section). Each run is
one complete cycle:

```
preflight (snapshotendpointmetadata)
  -> arm instrumentation capture (next matching session)
  -> wait the capture window (polling status)
  -> finish (download the .mdc recording zip)
  -> bc-mdc-converter --format ir-json
  -> gzip the ir-json bytes
  -> POST multipart to {AL_PERF_URL}/api/ingest
```

"0 sessions captured" is a **normal outcome** (the snapshot debugger arms
against the *next matching session*; in a quiet window nothing binds): the
script logs it and exits 0 without shipping.

## Prerequisites

1. **A reachable BC snapshot endpoint.** The snapshot debugger listens on its
   own port (default **7083**, separate from the dev endpoint's 7049) — expose
   it on your container/server. Enabling the development/snapshot endpoints on
   a production OnPrem server is a **customer security decision**: the endpoint
   grants debug-level access, so restrict it to trusted networks and require
   TLS off-localhost. Credentials are NavUserPassword via `BC_DEV_USER` /
   `BC_DEV_PASSWORD`.
2. **The bc-mdc-converter binary** (Rust, converts the `.mdc` recording zip to
   ir-json). Build with `cargo build --release` in the
   [bc-mdc-converter repo](https://github.com/SShadowS/bc-mdc-converter) or
   use a released binary. Point `BC_MDC_CONVERTER` (or `--converter`) at it.
3. **An al-perf server with your tenant registered.** Registration is a
   one-time operator step that yields the per-tenant ingest token
   (`AL_PERF_TOKEN`). The token is returned **once** at registration — store it
   securely. Registration needs the admin secret (`AL_PERF_ADMIN_SECRET`,
   falling back to `AL_PERF_POC_SECRET` on the server) and an RSA public key
   whose private half stays with you (it decrypts your stored profiles):

   ```bash
   # generate a keypair + registration payload (run once, keep private.pem safe)
   bun -e '
   const { generateKeyPairSync } = require("node:crypto");
   const { writeFileSync } = require("node:fs");
   const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
   const jwk = publicKey.export({ format: "jwk" });
   const xml = `<RSAKeyValue><Modulus>${Buffer.from(jwk.n, "base64url").toString("base64")}</Modulus><Exponent>${Buffer.from(jwk.e, "base64url").toString("base64")}</Exponent></RSAKeyValue>`;
   writeFileSync("private.pem", privateKey.export({ format: "pem", type: "pkcs8" }));
   console.log(JSON.stringify({ tenantCode: "acme", sharedSecret: process.env.AL_PERF_ADMIN_SECRET, publicKeyXml: xml }));
   ' > register.json

   curl -sS -X POST "$AL_PERF_URL/api/tenants/register" \
     -H "Content-Type: application/json" --data @register.json
   # -> { "tenantToken": "..." }   <- this is AL_PERF_TOKEN; shown exactly once
   ```
4. **Bun** (>= 1.0) and this repo checked out (`bun install`).

## Configuration

| Setting | Env | Flag | Notes |
|---|---|---|---|
| BC server / instance | — | `--server`, `--instance` (or `--project` with `.vscode/launch.json`) | e.g. `http://localhost`, `BC` |
| BC tenant | — | `--bc-tenant <id>` | default `"default"` — the BC tenant, not the al-perf tenant |
| BC credentials | `BC_DEV_USER`, `BC_DEV_PASSWORD` | — | NavUserPassword |
| Snapshot port | — | `--snapshot-port` | default 7083 |
| Session filter | — | `--client-type`, `--user-id` | default `WebClient`; `Background` for job-queue work |
| Capture window | — | `--duration <seconds>` | default 60; see size caps below |
| Poll cadence | — | `--poll-interval <seconds>` | default 5 — how often the script checks capture status during the window |
| Converter | `BC_MDC_CONVERTER` | `--converter` | path to bc-mdc-converter |
| al-perf target | `AL_PERF_URL`, `AL_PERF_TENANT`, `AL_PERF_TOKEN` | `--al-perf-*` | token = per-tenant ingest token, **not** the shared secret |
| Manifest | — | `--schedule-id <guid>`, `--description <text>` | scheduleId groups recurring runs in al-perf |
| Artifacts | — | `--out-dir`, `--keep-artifacts` | raw `.snapshot.zip` / `.ir.json` land here |

## First run — smoke test without a server

`--dry-run` performs the real capture + conversion but prints the manifest and
sizes instead of POSTing (al-perf settings not required):

```bash
BC_DEV_USER=admin BC_DEV_PASSWORD=... \
BC_MDC_CONVERTER=/path/to/bc-mdc-converter \
bun scripts/capture-and-ship.ts --server http://localhost --instance BC \
  --duration 60 --dry-run --out-dir ./captures
```

While the window is open, exercise the target: open pages in the web client,
run the job queue entry, call the web service — whatever `--client-type` is
meant to catch. Instrumentation records *every call* in the bound session, so
activity during the window is what produces data.

## One-shot real run

```bash
export BC_DEV_USER=admin BC_DEV_PASSWORD=...
export AL_PERF_URL=https://alperf.example.com
export AL_PERF_TENANT=acme
export AL_PERF_TOKEN=...          # per-tenant token from registration
export BC_MDC_CONVERTER=/opt/bc-mdc-converter/bc-mdc-converter

bun scripts/capture-and-ship.ts --server http://bc-prod --instance BC \
  --client-type Background --duration 120 \
  --schedule-id 6f9619ff-8b86-d011-b42d-00cf4fc964ff \
  --description "Nightly job-queue capture" \
  --out-dir /var/lib/al-perf-captures
```

Exit codes: `0` shipped / duplicate / no session captured / dry-run;
`1` cycle failed (message names the stage; artifacts retained);
`2` bad usage.

## Scheduling

Run it **off-peak**. Instrumentation is not free on the profiled server — it
records every AL call in the bound session — and full-verbosity recordings are
large. Prefer a couple of short scheduled windows over one long one.

### Windows Task Scheduler

Wrap the invocation in a `.cmd` so secrets live in one ACL-protected file, not
in the task definition:

```bat
@echo off
rem C:\perf-captures\capture-and-ship.cmd — restrict ACLs to the service account
cd /d C:\tools\bc-dev-mcp
set BC_DEV_USER=admin
set BC_DEV_PASSWORD=...
set AL_PERF_URL=https://alperf.example.com
set AL_PERF_TENANT=acme
set AL_PERF_TOKEN=...
set BC_MDC_CONVERTER=C:\tools\bc-mdc-converter\bc-mdc-converter.exe
bun scripts\capture-and-ship.ts --server http://localhost --instance BC ^
  --client-type Background --duration 120 ^
  --schedule-id 6f9619ff-8b86-d011-b42d-00cf4fc964ff ^
  --description "Nightly job-queue capture" ^
  --out-dir C:\perf-captures >> C:\perf-captures\capture.log 2>&1
```

```powershell
schtasks /Create /TN "al-perf nightly capture" /TR "C:\perf-captures\capture-and-ship.cmd" `
  /SC DAILY /ST 02:30 /RU DOMAIN\svc-alperf /RP
```

### cron

Standard cron entries are a single line — no line continuation — so wrap the
invocation in a script, the same "secrets in one ACL-protected file" pattern
as the Task Scheduler example above:

```bash
#!/usr/bin/env bash
# /opt/bc-dev-mcp/capture-and-ship.sh — mode 0700, owned by svc-alperf
set -a
# /etc/al-perf/capture.env — mode 0600, owned by svc-alperf (holds the tenant
# token; never world-readable)
. /etc/al-perf/capture.env
set +a
cd /opt/bc-dev-mcp
exec bun scripts/capture-and-ship.ts --server http://bc --instance BC \
  --client-type Background --duration 120 --description "Nightly capture" \
  --out-dir /var/lib/al-perf-captures
```

```cron
# /etc/cron.d/al-perf-capture
30 2 * * * svc-alperf /opt/bc-dev-mcp/capture-and-ship.sh >> /var/log/al-perf-capture.log 2>&1
```

## Capture-size caps — why `--duration` matters

The script checks these **before** POSTing and the server enforces them:

| Budget | Limit | Enforced by |
|---|---|---|
| gzipped upload (whole request) | 100 MB | al-perf server body cap |
| decompressed ir-json | 128 MiB (server default, `AL_PERF_MAX_PROFILE_BYTES`) | ingest handler |
| ir-json invocations | 500,000 | al-perf parser (over-budget surfaces as `500 analyze_failed`) |

Instrumentation output scales with *calls made during the window*, not with
time — a busy posting routine can hit 500k invocations in seconds, an idle
session records nothing. Start with `--duration 60`–`120` and adjust from the
logged `converted: N invocations` line. When a budget trips, the run fails
cleanly and **keeps** the local `.snapshot.zip` + `.ir.json` for inspection.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| exit 2 + usage | missing/invalid flag or env | message names the exact setting |
| `FAILED at preflight` | snapshot port not exposed / endpoint disabled | expose 7083; verify dev+snapshot endpoints are enabled on the server |
| `FAILED at attach` (HTTP 401) | wrong `BC_DEV_USER`/`BC_DEV_PASSWORD` | NavUserPassword credentials with debug permission |
| `0 sessions captured` (exit 0) | no session of `--client-type` started during the window | not an error; schedule when the target workload runs, or widen `--duration` |
| `FAILED at capture` (status Failed) | server aborted the snapshot session | check the BC event log; re-run |
| `FAILED at finish` | `finish` call failed/timed out, or returned an archive with no `.mdc` member | transient network/HTTP error — re-run; a `.mdc`-less archive means the session ended without recording anything usable — verify `--client-type`/`--user-id` actually matched a session and BC's snapshot recording completed |
| `FAILED at convert` | converter/BC version mismatch or corrupt zip | raw `.snapshot.zip` retained — retry the converter manually; update bc-mdc-converter |
| `400 invalid_gzip` | something rewrote the request body | remove/bypass body-transforming proxies |
| `400 invalid_capture_kind` | al-perf server too old for ir-json ingest | upgrade the al-perf server |
| `400 invalid_tenant_id` | `AL_PERF_TENANT` doesn't match the tenant-code pattern (`^[A-Za-z0-9][A-Za-z0-9-]{0,39}$`) | fix `AL_PERF_TENANT` — the client validates this before sending, so this should surface as exit 2, not a server response |
| `400 invalid_idempotency_key` | internal bug — the activityId sent wasn't a GUID | file a bug against capture-and-ship; the script always generates a GUID activityId, so this should never happen in normal operation |
| `401 unauthorized` | `AL_PERF_TOKEN` wrong / is the shared secret, **or** the tenant isn't registered yet | use the per-tenant token from registration; in token-auth mode an unregistered tenant also surfaces as 401 (bearer lookup fails before the server checks whether the tenant record exists) — if the token is definitely right, register the tenant (Prerequisites §3) |
| `404 tenant_not_registered` | tenant unknown to the server | run the registration step (Prerequisites §3) |
| `409 tenant_missing_public_key` | registration never recorded a public key | re-register with a valid `publicKeyXml` |
| `409 tenant_public_key_invalid` | registration's `publicKeyXml` doesn't parse as RSA | re-register with a valid RSA public key XML |
| `413 payload_too_large` / `FAILED at budget` | capture too large | shorten `--duration`, capture off-peak; artifacts retained |
| `500 analyze_failed` | usually > 500,000 invocations | shorten `--duration`; artifacts retained |
| `202 duplicate` (exit 0) | same activityId re-POSTed | success/no-op — the idempotency key did its job |
| `al-perf unreachable after retries` | server down / network | artifacts + `<id>.manifest.json` retained; re-ship manually (below) or just let the next scheduled run capture fresh data |

Manual re-ship of a retained capture:

```bash
gzip -k <id>.ir.json
curl -sS -X POST "$AL_PERF_URL/api/ingest" \
  -H "Authorization: Bearer $AL_PERF_TOKEN" \
  -H "X-Tenant-Id: $AL_PERF_TENANT" \
  -H "X-Idempotency-Key: <id>" \
  -F "manifest=@<id>.manifest.json;type=application/json" \
  -F "profile=@<id>.ir.json.gz;type=application/octet-stream"
```

## What the future daemon would add (and this recipe deliberately does not)

Per the platform umbrella spec, the daemon is built **when a named deployment
needs it** — not before. It would add, over this recipe:

- capture/ship state persisted across restarts (resume an armed capture);
- scheduling internalized (cron/Task Scheduler no longer required);
- a retry queue across runs (an unreachable al-perf drains later instead of
  waiting for the next scheduled slot);
- concurrent capture jobs across environments from one config;
- adaptive capture windows based on prior runs' invocation counts.

Everything else — the wire protocol, conversion, budgets, idempotency — is
already exercised by this recipe and carries over unchanged.
