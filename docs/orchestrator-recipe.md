# Orchestrator daemon — scheduling capture jobs from one long-running process

`scripts/orchestrate.ts` is one Bun process that reads a config file of jobs
(cron expression, command, args, env, retry policy) and supervises them as
child processes for as long as it runs — cron/Task Scheduler entries are no
longer required per job, only for the daemon itself. It **never reimplements
capture logic**: a "job" is just `command` + `args` spawned verbatim, so the
existing [capture-and-ship](capture-ship-recipe.md) and
[work-capture-queue](capture-queue-worker.md) scripts (or anything else) plug
in unchanged.

```
load + validate config (fail-closed)
  -> arm one timer for the earliest due job across the whole config
  -> on fire: overlap check (D3) -> spawn (Bun.spawn, no shell) -> await
  -> non-zero exit / timeout -> retry chain (D4) -> persist state (atomic)
  -> repeat until SIGINT/SIGTERM
```

`--dry-run` validates the config and prints the parsed schedule — no jobs are
spawned. This is the smoke test to run before ever putting a new config in
front of the real daemon:

```bash
bun scripts/orchestrate.ts --config orchestrator.config.json --dry-run
```

```
name               cron        next 3 fire times (local)
-----------------  ----------  -------------------------------------------------------------------
nightly-capture    30 2 * * *  2026-07-13 02:30:00  |  2026-07-14 02:30:00  |  2026-07-15 02:30:00
hourly-queue-poll  0 * * * *   2026-07-12 11:00:00  |  2026-07-12 12:00:00  |  2026-07-12 13:00:00
```

Fire times are computed via the same pure `nextRun()` the scheduler itself
uses, **without jitter** (jitter is randomized per occurrence at runtime —
printing it here would just be noise, not something worth validating). A
config that fails to load — a syntax error in any field, *or* a
syntactically valid but unsatisfiable schedule like `0 0 31 2 *` (February
31st never exists) — prints the error (naming the job + field) and **exits
2**, identically whether that happens via `--dry-run` or a real startup;
`--dry-run` doesn't bypass validation, it stops one step short of
scheduling. Both checks run at config *load* time (`loadOrchestratorConfig`),
not the first time the scheduler happens to compute that job's next
occurrence — a bad schedule is caught before anything is ever armed, not as
an uncaught crash partway through running.

## Prerequisites

1. **Bun** (>= 1.0) and this repo checked out (`bun install`).
2. **An `orchestrator.config.json`** — see the config reference below. Every
   `command`/`args` pair in it must already work when run by hand (the
   daemon does not validate that `command` exists on disk or `$PATH` until
   it actually tries to spawn it).
3. **Nothing else** — no daemon of its own dependencies. Point it at
   whatever jobs you already run today (capture-and-ship, work-capture-queue,
   `lifecycle sync`/`pull-telemetry`, or an arbitrary script) and it supervises
   them.

## Flags

| Flag | Default | Notes |
|---|---|---|
| `--config <path>` | — (required) | `orchestrator.config.json` path |
| `--state <path>` | beside `--config`, named `orchestrator.state.json` | see [State file](#state-file-and-no-backfill-d5) |
| `--shutdown-grace <seconds>` | 30 | see [Shutdown](#shutdown-semantics-d7) |
| `--dry-run` | off | print the parsed schedule, exit 0, schedule nothing |
| `-h`, `--help` | — | print usage |

Exit codes: `0` clean shutdown (SIGINT/SIGTERM handled) or `--dry-run`; `2`
bad usage, or a fail-closed config error at startup (message names the job +
field). There is no "job failed" exit code — a job failing, timing out, or
exhausting its retries is recorded in [state](#state-file-and-no-backfill-d5)
and logged; the daemon keeps scheduling everything else. An uncaught
exception outside that handled surface (e.g. the process running out of
memory, a bug) still crashes the process outside these two codes — that's
the "must never wedge, but can't promise never crash" honest boundary.

## Config reference (D1)

```json
{
  "jobs": [
    {
      "name": "nightly-capture",
      "schedule": "30 2 * * *",
      "jitterMinutes": 10,
      "command": "bun",
      "args": ["scripts/capture-and-ship.ts", "--server", "http://bc-prod", "..."],
      "env": { "BC_DEV_USER": "svc", "BC_DEV_PASSWORD": "..." },
      "timeoutMinutes": 30,
      "retry": { "attempts": 2, "delayMinutes": 5 }
    }
  ]
}
```

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `name` | string | yes | — | unique across the file (duplicate throws at load) |
| `schedule` | string | yes | — | 5-field cron; see [Cron subset](#cron-subset-d2) |
| `command` | string | yes | — | spawned **verbatim, no shell** — no `&&`, no globbing, no env expansion in the string itself |
| `args` | string[] | no | `[]` | spawned verbatim as separate argv entries |
| `env` | object&lt;string,string&gt; | no | `{}` | merged **over** the daemon's own `process.env` (a job can override an inherited var); keys must match `^[A-Za-z_][A-Za-z0-9_]*$` |
| `jitterMinutes` | number ≥ 0 | no | 0 | **capped at 59** (`MAX_JITTER_MINUTES`) — an absolute backstop only, not a per-schedule guarantee. Deriving a cron expression's true minimum interval is expensive (irregular gaps, the dom/dow OR-rule below), so the loader only refuses jitter ≥ 1 hour outright. **You are responsible for keeping jitter comfortably below your own schedule's actual interval** — e.g. `*/5 * * * *` with `jitterMinutes: 55` can jitter an occurrence past the *next* grid slot and silently skip it. A good rule of thumb: jitter no more than ~10-20% of your shortest gap between occurrences. |
| `timeoutMinutes` | number ≥ 0 | no | 60 | a job still running past this is SIGTERM'd, then SIGKILL'd after a short internal grace. **`0` means no timeout enforced** — an explicit opt-out, not an instant-kill; there's no other sane reading of a literal zero here. **Capped at 35791** (`MAX_TIMER_MINUTES`, ≈ 24.86 days — the largest delay a Bun/Node `setTimeout` will actually honor; anything larger silently clamps to ~1ms at runtime, SIGTERM-ing the job at birth on every run) — write `0` for "never," not a huge number |
| `retry` | object | no | none (no retry) | `{ "attempts": <int ≥0>, "delayMinutes": <number ≥0> }` — on failure/timeout/spawn-error, re-run after `delayMinutes`, up to `attempts` extra tries; success mid-chain resets. Fixed-delay only — exponential backoff is a follow-up. `delayMinutes` is **capped at 35791** too, same reason as `timeoutMinutes` above (an oversized value would clamp to an *instant* retry, not a long backoff). **Retries fire on any non-zero exit** — see the caveat about deterministic usage-error exits (e.g. capture-and-ship's exit 2) under [Overlap and retry semantics](#overlap-and-retry-semantics-d3d4) below. |

Unknown top-level job keys are ignored (forward-compatible config files).

## Cron subset (D2)

Five whitespace-separated fields: `minute hour day-of-month month day-of-week`
(`min` 0-59, `hour` 0-23, `dom` 1-31, `month` 1-12, `dow` 0-7 where **both 0
and 7 mean Sunday**). Each field accepts, comma-separated:

| Form | Meaning |
|---|---|
| `*` | every value |
| `N` | exactly N |
| `N-M` | inclusive range |
| `*/S` | every S-th value starting at the field's minimum |
| `N-M/S` | every S-th value within the range |

**Rejected on purpose:** a bare `N/S` (e.g. `5/10`) — under the D2 grammar
this would silently collapse to a single value (there's nowhere left to step
through), under-scheduling the job with no error. The parser throws instead,
suggesting `N-<max>/S` or `*/S`. If you meant "every 10 minutes starting at
minute 5," write `5-59/10`.

**Vixie dom/dow rule:** when **both** day-of-month and day-of-week are
restricted (neither is `*`), a day matches if **either** field matches — not
both. `0 0 13 * 5` fires on the 13th of every month *and* every Friday, not
only Friday-the-13th. This is the same non-obvious behavior real `cron(8)`
and most cron libraries have; if you actually want an AND (Friday the 13th
only), there's no field syntax for it — filter in the job's own code, or
accept the OR and note it in the job's `name`.

`nextRun` searches up to 4 years ahead and throws "unsatisfiable" past that
bound — `0 0 31 2 *` (February 31st) never matches. The config loader calls
`nextRun` for every job's schedule at **load** time (not just at parse time,
and not just the first time the scheduler would have tried to use it), so an
unsatisfiable schedule fails closed — exit 2, naming the job — identically
under `--dry-run` and a real startup. It does not silently schedule nothing,
and it does not surface later as an uncaught crash out of the scheduler.

**Sparse schedules (monthly, quarterly, yearly, "next Feb 29th") are safe to
use** — a genuinely rare occurrence can be months away, well past the ~24.86
days a single `setTimeout` delay can actually span before Bun/Node silently
clamps it to ~1ms. The scheduler caps the delay it actually arms and re-arms
the remainder as needed, so a long wait costs a small, bounded number of
timer re-arms instead of spinning at the clamped ~1ms interval — the job
still fires exactly on time either way; this only changes how the wait to
get there is implemented internally, and is not something a config author
needs to think about.

Cron times are evaluated in the **daemon process's local time zone** — the
conventional interpretation (`cron(8)`, Windows Task Scheduler both mean
"local wall clock" when you write `30 2 * * *`). DST transitions are a known,
accepted cost of that choice: a spring-forward can skip a wall-clock minute a
job was scheduled for; a fall-back can revisit one. Not specially handled.
An NTP correction that jumps the clock sharply **forward** has a related
effect: each tick only recomputes a job's *next single* occurrence from
whichever one it just fired, so if the jump skipped past several of that
job's occurrences at once, the daemon re-detects it as due again on the very
next tick (armed at ~0ms) — repeatedly, in rapid succession, until its
schedule finally catches up to the new "now." What that looks like in
practice depends on how long the job takes to run:
[no-overlap](#overlap-and-retry-semantics-d3d4) means a job that's still
in flight from the first catch-up fire has every subsequent rapid re-tick
counted as a skipped overlap, not a second concurrent spawn — but a job
that finishes fast enough between ticks *can* be genuinely re-spawned
several times in quick succession. Either way it's bounded (never more than
one truly concurrent run of the same job) and self-resolving within a few
ticks, not a sustained problem — but it's a real, if brief, burst either in
spawn count or in `skippedOverlaps`, not the missed slots quietly vanishing.

## Overlap and retry semantics (D3/D4)

- **No overlap, ever, per job.** If a job's next occurrence is due while its
  previous run (or an active retry) is still executing, that tick is
  **skipped** — logged, and counted in `skippedOverlaps` — never queued.
  Distinct jobs run fully concurrently; this only serializes one job against
  itself.
- **Retry is a fixed-delay chain that occupies the job.** A non-zero exit,
  a timeout, or a spawn failure triggers a retry after `retry.delayMinutes`,
  up to `retry.attempts` extra tries. The job counts as "running" for the
  whole chain (including the gap between attempts) — an overlapping regular
  due tick during that gap is skipped like any other overlap, not queued
  behind the retry.
  - **The daemon retries ANY non-zero exit — it has no idea which ones are
    worth retrying.** capture-and-ship.ts and work-capture-queue.ts's own
    exit-code conventions distinguish `1` (a real cycle failure — transient
    network/BC issues, worth retrying) from `2` (bad usage — the config's
    `args` themselves are wrong, e.g. a typo'd flag). Exit `2` is
    deterministic: retrying the exact same `args` produces the exact same
    usage error every time, so `retry` on such a job just delays discovering
    a config mistake by `attempts × delayMinutes`, not un-sticks anything.
    Exit `0` (shipped/duplicate/no-capture) is correctly recorded as
    success regardless of which of those three sub-outcomes it was — see
    each script's own troubleshooting table for what its exit codes mean.
    If a job is misconfigured, fix the config; don't rely on `retry` to
    paper over it.
- **Drift-free scheduling.** A job's next regular occurrence is always
  computed from the time it was *due*, never from when it happened to
  finish — a slow or retried run does not shift the job's own cadence.

## State file and no-backfill (D5)

Default `orchestrator.state.json`, beside `--config` unless `--state`
overrides it. Written **atomically** (temp file + rename) after every state
transition — a reader, or a daemon crash mid-write, never observes a
half-written file. Per job:

```json
{
  "jobs": {
    "nightly-capture": {
      "lastStartAt": 1783843980000,
      "lastFinishAt": 1783843980054,
      "lastExitCode": 0,
      "lastOutcome": "ok",
      "consecutiveFailures": 0,
      "skippedOverlaps": 0
    }
  }
}
```

`lastOutcome` is one of `"ok" | "failed" | "timeout"` in practice —
`"skipped-overlap"` is reserved in the *type* only and is never actually
assigned; an overlap leaves `lastOutcome` untouched (it always reflects the
last *completed* run) and is counted solely via the separate
`skippedOverlaps` counter.

**Missed schedules while the daemon was down are NOT backfilled.** On
startup, prior state for each job is logged (informational only) — cron
semantics, not a message queue. If the daemon was down for 3 hours across an
hourly job's schedule, it does not run 3 catch-up occurrences on restart; it
just resumes the normal cadence from "now." If you need guaranteed
execution-at-least-once semantics, that has to live in the underlying job
(the way capture-and-ship's idempotency key already handles duplicate ships) —
the daemon's job here is scheduling, not delivery guarantees.

**There is no lock file or pidfile — nothing stops you from accidentally
starting two daemon instances against the same `--config`.** State writes
are safe either way (each instance's tmp file is pid-scoped,
`<state>.tmp-<pid>`, so they never clobber each other mid-write), but D3's
overlap-skip only serializes a job against *itself within one process* — two
independent daemon processes have no idea about each other, so every job
would actually **run twice**, once per instance, on every occurrence. If
you're using a process supervisor (NSSM, systemd, schtasks), make sure its
own configuration only ever starts one instance per config file; there's no
daemon-side safety net for this.

## No hot reload (D6)

The config is read **once**, at startup. Editing `orchestrator.config.json`
while the daemon is running has no effect until it's restarted. There is no
SIGHUP/`--watch` in v1 — Windows service wrappers make signal-based reload
unreliable (see [Shutdown semantics](#shutdown-semantics-d7) below for the
concrete evidence), so restart-to-reload is the honest, simple posture rather
than a half-working reload story. Validate a config change with `--dry-run`
first, then restart the service.

## Shutdown semantics (D7)

SIGINT/SIGTERM should: stop scheduling new work, wait up to
`--shutdown-grace` (default 30s) for any currently-running jobs to finish,
then SIGTERM whatever's still running, and exit 0. The daemon's own handler
implements exactly that. **Whether the OS actually delivers the signal to
that handler in a way Bun/Node can act on is platform-dependent — and on
Windows, mostly no:**

- **Linux/systemd:** SIGTERM is a real, catchable signal. `systemctl stop`
  sends SIGTERM, the handler runs, the grace applies as designed. Set
  `--shutdown-grace` **at or below** systemd's own `TimeoutStopSec` for that
  unit, or systemd's harder SIGKILL will preempt the daemon's own grace
  window before it finishes waiting.
- **Windows, interactive console (Ctrl+C):** SIGINT delivered to a process
  that owns/shares the console it's running in **is** caught — this is
  standard, documented Node/Bun behavior on Windows and is the one case
  where the grace genuinely applies.
- **Windows, signal sent from another process — verified, not assumed:**
  tested directly against this implementation (a trivial `process.on(
  "SIGTERM", ...)` handler included) by having a separate Bun process spawn
  the daemon and call `subprocess.kill("SIGTERM")` on it. The child was
  **unconditionally terminated** — exit code `143` (the SIGTERM-convention
  code), but the handler's own log line never printed, and neither did
  `--shutdown-grace` get a chance to run. The same result was reproduced with
  `SIGINT` (exit `130`, handler never invoked). This matches the platform
  reality (Windows has no POSIX signal delivery; Node/Bun's `child.kill()`
  and `taskkill` both fall back to unconditional termination for a process
  they don't share a console with) rather than being specific to this code —
  but it means **schtasks "End Task," plain `taskkill`, and NSSM's default
  stop method are all abrupt on this platform: no grace, no clean draining,
  whatever job was mid-run is just gone.**
  - If you need an actual graceful stop under NSSM, configure
    `AppStopMethodConsole` (NSSM sends a synthetic Ctrl+C to the app's
    console before escalating to `WM_CLOSE` then `TerminateProcess`) — this
    is the closest Windows equivalent to systemd's SIGTERM, but confirm it
    works for your NSSM version before relying on it in production; the
    author has not independently verified it against this daemon.
  - Otherwise, accept abrupt restarts on Windows as this platform's honest
    v1 posture (in the same spirit as [no hot reload](#no-hot-reload-d6)) —
    a job that gets killed mid-run is recorded as whatever its last
    *completed* outcome was (state isn't updated for a run that never got to
    report in), and picks back up on the next due tick after restart, same
    as any other unclean stop.
  - This is abrupt, not leaky: a review pass independently `taskkill`'d a
    live daemon with a job in flight and confirmed Bun reaps its own spawned
    children when the parent process dies — the abruptly-killed job's child
    process does not survive as an orphan. The gap here is purely "no clean
    drain / no grace," not "orphaned processes accumulate."
  - The daemon prints a one-time startup warning
    (`WARNING: --shutdown-grace was set explicitly, but Windows does not
    reliably deliver...`) when `--shutdown-grace` was passed explicitly on
    `win32` — so an operator who set it doesn't silently trust a promise this
    platform breaks. It's silent on the *default* (nothing was explicitly
    relied on) and silent on other platforms (nothing to warn about).
- **A job's own `timeoutMinutes` kill (SIGTERM → SIGKILL) is unaffected by
  any of this** — that's the daemon killing a child it spawned, not the OS
  delivering an external signal to the daemon itself. On Windows the SIGTERM
  there already terminates the child unconditionally (same mechanism as
  above), so the child dies either way; it just doesn't get a chance to
  clean up first the way it might on Linux. `timeoutMinutes` enforcement is
  reliable cross-platform — it's only the *daemon's own* external shutdown
  signal that's Windows-fragile.

## Secrets posture

`job.env` is where BC credentials, al-perf tokens, and anything else a job
needs land — **the config file is a secrets file** and must be ACL-protected
exactly like the `.cmd`/`.env` wrappers `capture-ship-recipe.md` and
`capture-queue-worker.md` already document (Windows: NTFS ACL restricted to
the service account; Linux: mode `0600`, owned by the service account).

The daemon **never logs an env value** — every log line names `job.name`,
never the resolved environment. Only key *names* would ever be safe to log
(the config loader's own validation errors can mention that a key like
`env["BC_DEV_PASSWORD"]` failed a type check, which names the key, never the
value). If you're auditing a change to `scripts/orchestrate.ts` or
`src/core/orchestrate/`, grep for `.env` before adding any new log call —
that's the standing convention, not a one-time check.

## Windows service wrapper

### schtasks — ONSTART, not per-schedule

Instead of one Task Scheduler entry per job (per capture-ship-recipe.md's
pattern), register **one** task that starts the daemon at boot and let the
daemon own all the schedules:

```bat
@echo off
rem C:\perf-captures\orchestrate.cmd — restrict ACLs to the service account;
rem this file's own presence is not secret, but orchestrator.config.json is.
cd /d C:\tools\bc-dev-mcp
bun scripts\orchestrate.ts --config C:\perf-captures\orchestrator.config.json ^
  --state C:\perf-captures\orchestrator.state.json >> C:\perf-captures\orchestrate.log 2>&1
```

```powershell
schtasks /Create /TN "al-perf orchestrator" /TR "C:\perf-captures\orchestrate.cmd" `
  /SC ONSTART /RU DOMAIN\svc-alperf /RP
```

`/SC ONSTART` runs it once at boot and lets it run indefinitely — there is no
recurring schedule to configure here; that's the whole point of moving from
per-job Task Scheduler entries to this daemon. Stopping it via Task Scheduler
("End Task") or `taskkill` is abrupt — see
[Shutdown semantics](#shutdown-semantics-d7).

### NSSM (Windows service, restart-on-crash included)

```powershell
nssm install al-perf-orchestrator "C:\tools\bun\bun.exe" `
  "scripts\orchestrate.ts --config C:\perf-captures\orchestrator.config.json --state C:\perf-captures\orchestrator.state.json"
nssm set al-perf-orchestrator AppDirectory C:\tools\bc-dev-mcp
nssm set al-perf-orchestrator AppStdout C:\perf-captures\orchestrate.log
nssm set al-perf-orchestrator AppStderr C:\perf-captures\orchestrate.log
rem See Shutdown semantics above before relying on this for a graceful stop:
nssm set al-perf-orchestrator AppStopMethodConsole 3000
nssm start al-perf-orchestrator
```

NSSM restarts the service automatically on a crash (configurable via
`AppExit`/`AppRestartDelay`) — combined with no-backfill (D5), a restart just
resumes the normal cadence, it does not replay anything missed.

### systemd (Linux)

```ini
# /etc/systemd/system/al-perf-orchestrator.service
[Unit]
Description=al-perf orchestrator daemon
After=network.target

[Service]
Type=simple
User=svc-alperf
WorkingDirectory=/opt/bc-dev-mcp
ExecStart=/usr/local/bin/bun scripts/orchestrate.ts \
  --config /etc/al-perf/orchestrator.config.json \
  --state /var/lib/al-perf/orchestrator.state.json \
  --shutdown-grace 30
Restart=on-failure
RestartSec=5
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
```

`TimeoutStopSec` (40) is deliberately set **above** `--shutdown-grace` (30) —
systemd sends SIGTERM on `systemctl stop`, and if the daemon's own grace
(30s) hasn't finished by 40s, systemd escalates to SIGKILL. Keeping
`TimeoutStopSec` above `--shutdown-grace` lets the daemon's own graceful
drain always get to finish (or hit its own grace limit and self-kill
children) before systemd's harder timeout would ever fire.
`orchestrator.config.json` at `/etc/al-perf/` should be mode `0600`, owned by
`svc-alperf` (see [Secrets posture](#secrets-posture)).

## Migration from per-job Task Scheduler / cron entries

If you're currently running `capture-and-ship.ts` and/or
`work-capture-queue.ts` from separate Task Scheduler entries or cron lines
(per their own recipe docs), moving to the orchestrator is:

1. Write one `orchestrator.config.json` job per existing scheduled entry —
   `command`/`args` are exactly what the `.cmd`/`.sh` wrapper already invokes
   (split back out into `command` + `args`, no shell); `env` is whatever the
   wrapper currently `set`s/exports.
2. `bun scripts/orchestrate.ts --config orchestrator.config.json --dry-run`
   and confirm every job's next-3 fire times line up with what you expect
   from its old cron expression.
3. Disable (don't delete yet) the old per-job Task Scheduler entries / cron
   lines.
4. Register **one** ONSTART task / systemd unit for the daemon (above), start
   it, and watch the log for the first real firing of each job.
5. Once satisfied, delete the old per-job entries — the daemon fully
   supersedes them, per-job scheduling infrastructure is no longer needed.

The underlying scripts, their flags, their exit codes, and their
troubleshooting tables are **completely unchanged** — the daemon only
replaces what was invoking them.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| exit 2 at startup, names a job + field | fail-closed config validation (D1) | fix the named field; `--dry-run` catches this before it ever matters |
| exit 2, names `--config` | `--config <path>` omitted | it's required — there's no env var fallback, unlike the ship/queue scripts |
| exit 2, "cannot read" a path | typo, or the file doesn't exist yet | verify the path; relative paths resolve against the daemon's own working directory, not the config file's location |
| exit 2, "schedule is unsatisfiable" | a syntactically valid cron expression that never matches any real date (e.g. `0 0 31 2 *` — Feb 31st) | fix the schedule; this is caught at config load (both `--dry-run` and real startup), never a silent no-op or a later crash |
| a job runs twice on every occurrence | two daemon instances are running against the same `--config` — there's no lock file (see [State file](#state-file-and-no-backfill-d5)) | check your process supervisor isn't accidentally starting a second instance; kill the extra one |
| `--dry-run` shows a job's fire times far later/earlier than expected | vixie dom/dow OR-rule (a restricted `dom` *and* `dow` fires on either match, not both) | see [Cron subset](#cron-subset-d2); rewrite as two config entries if you need a true AND |
| a job never seems to fire even though `--dry-run` shows the right times | daemon process isn't actually running (crashed, or Windows abrupt-killed it — see Shutdown semantics) | check the log for a `starting —` line near when you expect it; on Windows confirm the service wrapper is actually still alive, not silently gone |
| `skippedOverlaps` climbing on one job | that job's `timeoutMinutes` (or its natural runtime) is longer than its own schedule interval | raise the schedule interval, lower `timeoutMinutes`, or investigate why the job is slow — this is not a bug, it's D3 doing its job |
| `consecutiveFailures` climbing | the underlying command is failing — check its own troubleshooting doc ([capture-ship-recipe.md](capture-ship-recipe.md#troubleshooting) / [capture-queue-worker.md](capture-queue-worker.md#troubleshooting) if it's one of those) | the daemon just reports the exit code; the failure is in the job, not the scheduler |
| SIGINT/SIGTERM doesn't drain gracefully on Windows | expected — see [Shutdown semantics](#shutdown-semantics-d7); verified empirically, not a bug in this daemon | use an interactive Ctrl+C where possible, or accept the abrupt-restart posture |
| config edit has no effect | no hot reload (D6) — config is read once at startup | restart the daemon after any config change |
| state file missing / empty on first run | normal — no prior state file exists yet | not an error; the daemon creates it on the first state transition |
