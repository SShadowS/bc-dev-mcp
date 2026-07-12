# Capture queue worker — executing al-perf's deep-capture request queue

`scripts/work-capture-queue.ts` is bc-dev-mcp's executor for al-perf's
capture-request queue: a cron-driven script that polls pending requests via
the al-perf CLI, claims one, runs the existing
[capture-and-ship recipe](capture-ship-recipe.md) against it, and lets
al-perf's automatic fulfillment close the loop. It implements the executor
side of al-perf's deep-capture request executor contract — `docs/capture-request-contract.md`
in that (separate) repository; not vendored or duplicated here. Read that
file for where requests come from, the fulfillment-matching mechanics, and
TTL expiry; this doc covers running the executor against it.

```
poll (captures list --status pending)
  -> claim one (captures claim <id> --by <executor>)
  -> run the capture-and-ship cycle against it (unchanged)
  -> release the claim per the outcome (see "Claim / release semantics" below)
```

## Prerequisites

1. **The al-perf CLI, reachable.** Either an installed binary (`al-profile`)
   or `bun run <path-to-al-perf>/src/cli/index.ts` — whatever you'd normally
   type to run `lifecycle captures list`. Point `--al-perf-cli` / `AL_PERF_CLI`
   at it.
2. **The lifecycle DB path**, if it isn't at al-perf's default location —
   `--queue-db <path>`, passed through to the CLI as its own `--db` option.
3. **Everything capture-and-ship needs** — a reachable BC snapshot endpoint,
   the bc-mdc-converter binary, a registered al-perf tenant. See
   [capture-ship-recipe.md's Prerequisites](capture-ship-recipe.md#prerequisites);
   nothing about those changes here.
4. **`lifecycle sync` running on its own schedule**, elsewhere (typically
   alongside al-perf's own `pull-telemetry` cron) — this worker only *drains*
   the queue; nothing files new requests without that scan running.

## Flags

Own flags (consumed before anything is forwarded):

| Flag | Env | Default | Notes |
|---|---|---|---|
| `--al-perf-cli <cmd>` | `AL_PERF_CLI` | — (required) | al-perf CLI command prefix, whitespace-split, e.g. `"bun run U:/Git/al-perf/src/cli/index.ts"` or an installed `al-profile` binary |
| `--queue-db <path>` | — | al-perf's own default DB location | passed to the CLI as `--db <path>` |
| `--executor <name>` | — | this host's name (`os.hostname()`) | stable claim identity — keep it stable across runs on the same box, not random per invocation |
| `--max <n>` | — | 1 | requests to attempt this invocation; must be a positive integer |
| `--queue-tenant <t>` | — | all tenants | only poll this tenant's pending requests |
| `--keep-claim-on-failure` | — | off | don't cancel the claim on a `no-capture`/`error` outcome — build your own retry above the queue |
| `--workload-cmd <cmd>` | — | none | spawned once capture is armed, whitespace-split; see "Workload hook" below |
| `--allow-dry-run-claims` | — | off | required alongside a forwarded `--dry-run`; see "Dry-run gating" below |
| `-h`, `--help` | — | — | prints this script's own flags, then capture-and-ship's flag reference |

Everything else forwards **verbatim** to capture-and-ship
(`resolveShipConfig`) — BC server/instance/credentials, `--client-type`,
`--duration`, `--poll-interval`, `--converter`, `--al-perf-url`,
`--al-perf-token`, `--out-dir`, `--keep-artifacts`, etc. See
[capture-ship-recipe.md's Configuration table](capture-ship-recipe.md#configuration)
for the full list — nothing about those flags changes here.

Two forwarded ship settings are handled specially, **per claimed request**:

- **`--al-perf-tenant` / `AL_PERF_TENANT`** — the ship destination MUST be
  the requesting tenant (the contract's same-tenant rule: al-perf only
  matches fulfillment within the SAME tenant that filed the request). This
  worker overrides whatever was forwarded with the claimed row's own
  `tenant` field before every cycle, logging the override only when it
  actually changes something you configured.

  **Gotcha:** `resolveShipConfig` still validates that `--al-perf-tenant` /
  `AL_PERF_TENANT` is a non-empty, tenant-code-shaped string *before* this
  worker gets a chance to override it — so you still need to set it to
  *something* (e.g. `--al-perf-tenant queue-worker-placeholder`), even though
  its actual value is discarded on every request. Only `--dry-run` waives
  the requirement — see "Dry-run gating".
- **`--description`** — overridden unconditionally with
  `capture-request #<id>: <reason>` so the shipped profile's manifest names
  the request that triggered it; the override is always logged.

## Claim / release semantics

1. **Poll**: `captures list -f json --status pending [--tenant <t>]`.
2. **Claim** the first (oldest) `--max` rows in list order, one at a time,
   with `--by <executor>`. A claim can fail two different ways, reported
   distinctly in the run summary:
   - **raced / gone** — another executor (or a human) claimed it first, or
     the row no longer exists (fulfilled/cancelled/expired between the poll
     and the claim). Normal in any pool with more than one worker, or when a
     human is also working the queue — the worker just moves to the next
     row and does not count this against `--max`.
   - **error** — the CLI invocation itself failed (bad `--al-perf-cli`,
     unreachable queue db, …). Tracked as a distinct `claimErrors` count —
     this is the "something's broken" signal, not "the pool is busy," and
     drives the exit-code rule below.
3. **Capture**, against the claimed request's
   `appId`/`objectType`/`objectId`/`methodName` — never `reason`, which is a
   human-readable summary and not guaranteed to parse back into those
   fields.
4. **Release**, decided by the cycle's outcome:
   - **`shipped` / `duplicate` / `dry-run` → the claim is KEPT.** Fulfillment
     is automatic and server-side (evaluating the shipped profile flips
     matching pending/claimed requests to `fulfilled` on its own — there is
     no "mark fulfilled" call in this loop). Cancelling right after a
     successful ship would be wrong: the request IS being serviced, just not
     synchronously. (`dry-run` never ships anything either, but cancelling
     would free the identity for the next `lifecycle sync` scan to
     immediately re-file it — churning the row for what was always a
     no-op. A claim that simply self-expires via TTL is cheaper.)
   - **`no-capture` / `error` → the claim is CANCELLED**, unless
     `--keep-claim-on-failure`. This frees the identity for the next
     `lifecycle sync` scan to re-file a fresh request if the underlying
     finding still qualifies, instead of wedging it claimed until TTL
     expiry (14 days by default) for no reason.

## Dry-run gating

Forwarding `--dry-run` (a capture-and-ship flag) still claims a **real**
queue row — a dry run performs the actual capture and conversion and prints
the manifest, skipping only the final POST. Because nothing ships, nothing
ever fulfills the request; the claim just sits (kept, per the table above)
until a later run cancels it or it self-expires via TTL. That's a real,
if harmless, side effect against the live queue, so the script refuses to
combine `--dry-run` with a live queue run unless you also pass
`--allow-dry-run-claims` — a bare `--dry-run` is a usage error (exit 2)
naming the missing flag.

## Workload hook

`--workload-cmd "<command>"` is spawned as a child process the moment the
cycle's log stream reports the capture is armed — i.e. right when BC has
bound the *next matching session*, the same instant capture-and-ship's own
`armed instrumentation capture ...` log line appears. No changes to the
capture cycle itself were needed for this: the worker taps the log stream it
already receives.

The child is killed (SIGTERM) if it's still running when the cycle resolves.
Either way its outcome is logged — `workload for request #<id> exited with
code <n>`, or `workload spawn failed for request #<id>` if the command
itself never started (bad path, not executable, …) — but never fails the
worker run; a bad `--workload-cmd` shows up in the log instead of silently
capturing nothing every cycle. The child's own stderr is inherited (not
captured), so whatever the driver itself prints about *why* it failed lands
directly in this process's stderr too, right alongside the worker's own log
lines. Without `--workload-cmd`, the capture window just catches organic
traffic per `--client-type`, exactly like capture-and-ship today — the hook
exists to make an *unattended* queue worker actually exercise the flagged
routine instead of hoping something calls it during the window.

The child inherits this process's full environment (`process.env`) plus the
`BCQ_*` vars below — including whatever secrets are set for capture-and-ship
itself (`AL_PERF_TOKEN`, `BC_DEV_PASSWORD`, …). `--workload-cmd` is
operator-controlled, not request data, so this is the same trust boundary as
any other command you'd put in the `.cmd`/cron wrapper — but don't point it
at something you wouldn't otherwise hand your capture credentials to.

The child receives the claimed request's routine identity as environment
variables:

| Var | Source |
|---|---|
| `BCQ_REQUEST_ID` | `id` |
| `BCQ_TENANT` | `tenant` |
| `BCQ_APP_ID` | `appId` |
| `BCQ_APP_NAME` | `appName` (empty string if `null`) |
| `BCQ_OBJECT_TYPE` | `objectType` |
| `BCQ_OBJECT_ID` | `objectId` |
| `BCQ_METHOD_NAME` | `methodName` |
| `BCQ_REASON` | `reason` |

An operator-written driver can read these and use
[bc-mcp](https://github.com/SShadowS/business-central-mcp) (or any other web
client automation) to actually invoke the flagged routine during the window.
Sketch of such a driver — not shipped by this repo, since the right page/action
to open is specific to your AL objects:

```javascript
#!/usr/bin/env node
// drive-workload.mjs — invoked by --workload-cmd once the capture window opens.
// Connect an MCP stdio client to bc-mcp's dist/stdio-server.js (same BC_BASE_URL /
// BC_CLIENT_VERSION env convention bc-mcp itself uses), then use the BCQ_* vars to
// open the right page and invoke the action that reaches the flagged routine.
console.error(
  `driving ${process.env.BCQ_OBJECT_TYPE} ${process.env.BCQ_OBJECT_ID} / ${process.env.BCQ_METHOD_NAME} (${process.env.BCQ_REASON})`,
);
// ... spawn/connect to bc-mcp, call its page/action tools with the object/method above.
```

```bat
bun scripts\work-capture-queue.ts ... --workload-cmd "node C:\tools\drive-workload.mjs"
```

The command string is whitespace-split — see the limitation below.

## Whitespace-splitting limitation

Both `--al-perf-cli` / `AL_PERF_CLI` and `--workload-cmd` are split on plain
whitespace, not shell-quote-parsed — a path containing a space breaks (it
gets split into two tokens). Use an 8.3 short path (`dir /x` on Windows) or
an NTFS junction/symlink pointing at a space-free path instead; this
intentionally does not grow a shell-quoting grammar.

## Scheduling

Running several of these on one box? The [orchestrator daemon](orchestrator-recipe.md)
supersedes per-job Task Scheduler entries — one long-running process reads a
config file of jobs (this worker being one of them, alongside
capture-and-ship and `lifecycle sync`/`pull-telemetry`) and schedules +
supervises them all itself, with cron expressions, jitter, no-overlap, and
retry built in. The per-job pattern below still works standalone; it's what
the daemon's own config entries are built from.

Mirrors [capture-ship-recipe.md's Windows Task Scheduler
pattern](capture-ship-recipe.md#windows-task-scheduler) — wrap the invocation
in a `.cmd` so secrets live in one ACL-protected file, not the task
definition:

```bat
@echo off
rem C:\perf-captures\work-capture-queue.cmd — restrict ACLs to the service account
cd /d C:\tools\bc-dev-mcp
set BC_DEV_USER=admin
set BC_DEV_PASSWORD=...
set AL_PERF_URL=https://alperf.example.com
set AL_PERF_TOKEN=...
rem placeholder only — overridden per request; still required by capture-and-ship's own validation
set AL_PERF_TENANT=queue-worker-placeholder
set BC_MDC_CONVERTER=C:\tools\bc-mdc-converter\bc-mdc-converter.exe
set AL_PERF_CLI=bun run C:\tools\al-perf\src\cli\index.ts
bun scripts\work-capture-queue.ts --server http://localhost --instance BC ^
  --client-type Background --duration 120 ^
  --out-dir C:\perf-captures >> C:\perf-captures\queue-worker.log 2>&1
```

```powershell
schtasks /Create /TN "al-perf capture queue worker" /TR "C:\perf-captures\work-capture-queue.cmd" `
  /SC HOURLY /RU DOMAIN\svc-alperf /RP
```

Poll no faster than `lifecycle sync` can plausibly produce new rows — hourly
alongside a 15-minute telemetry pull is a reasonable default, same guidance
as the executor contract itself gives for re-poll cadence.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| exit 2 + usage, names `--al-perf-cli` | missing flag and `AL_PERF_CLI` env | set one of them |
| exit 2 + usage, names `AL_PERF_TENANT` | `--al-perf-tenant`/`AL_PERF_TENANT` omitted entirely | set a placeholder value (see the Flags gotcha above) — it's still validated even though it's overridden per request; or use `--dry-run --allow-dry-run-claims` |
| exit 2 + usage, names `--allow-dry-run-claims` | `--dry-run` forwarded without the acknowledgment flag | add `--allow-dry-run-claims`, or drop `--dry-run` |
| `#<id>: claim-raced` in the log | another executor/human claimed it first, or it advanced/expired between poll and claim | **normal** in any pool with more than one worker — not an error, doesn't count against `--max` |
| `#<id>: no-capture (released)` | `0 sessions captured` in the window (see capture-ship-recipe.md) | **normal** — not an error; the claim is freed for the next scan to re-file if still relevant |
| exit 1, "the al-perf CLI itself appears broken" | `claimErrors > 0` and no request reached an actual cycle outcome | verify `--al-perf-cli`/`AL_PERF_CLI` actually runs `lifecycle captures ...` successfully by hand, and that `--queue-db` (if used) points at the right file |
| always `polled 0`, exit 0, nothing ever happens | `--queue-db` points at the wrong path — SQLite silently creates a fresh, empty database at whatever path it's given rather than erroring on a typo | verify `--queue-db` (or the CLI's own default) points at the *real* lifecycle DB that `lifecycle sync` actually writes to; run `lifecycle captures list -f json --status pending` with the exact same `--al-perf-cli`/`--queue-db` by hand and confirm it returns the rows you expect |
| `WARNING: N claim error(s) occurred alongside other work that succeeded` (exit 0) | some claims errored but at least one request still ran to a terminal outcome | investigate the CLI, but the run itself isn't failing overall |
| profile ships but the request never fulfills | shipped to the wrong tenant | shouldn't happen through this script (tenant is overridden per request every time); if you're re-shipping a *retained* artifact manually per capture-ship-recipe's curl recipe, use the request's own `tenant`, not whatever you'd normally ship to |
| preflight/attach/capture/finish/convert/budget/ship failures | same causes as plain capture-and-ship | see [capture-ship-recipe.md's Troubleshooting table](capture-ship-recipe.md#troubleshooting) — the underlying cycle is unchanged, only the queue loop is new |

---

Everything not covered here — BC connection details, capture window sizing,
size budgets, manual re-shipping of a retained capture — is
[capture-ship-recipe.md](capture-ship-recipe.md)'s territory, unchanged; this
worker only adds the queue loop around it.
