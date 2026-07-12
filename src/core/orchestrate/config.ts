// Fail-closed loader for orchestrator.config.json (D1 of the orchestrator-daemon
// plan). Every malformed field throws, naming the offending job (by name once
// known, else by index) and the field — startup-time config errors must be loud
// and specific, never a silent default or a generic "invalid config" message.
//
// SECURITY: job.env values are secrets-bearing (BC credentials, tokens, ...) —
// the config file on disk must be ACL-protected the same way the .cmd recipes
// it supersedes are. This loader never logs env values, only keys.
import { readFileSync } from "node:fs";
import { nextRun, parseCron } from "./cron";

export interface RetryConfig {
  readonly attempts: number;
  readonly delayMinutes: number;
}

export interface JobConfig {
  readonly name: string;
  readonly schedule: string; // validated 5-field cron; re-parsed by the scheduler via cron.nextRun
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  // Jitter added to this job's cron-computed due time, capped at MAX_JITTER_MINUTES (an
  // absolute backstop only — see the constant's comment). Operators are responsible for
  // keeping jitter comfortably below their OWN schedule's actual interval; a schedule of
  // "*/5 * * * *" with jitterMinutes near the cap can still jitter an occurrence past the
  // next grid slot and silently skip it. The loader cannot cheaply derive the true minimum
  // interval of an arbitrary cron expression (irregular gaps, DOM/DOW OR-matches, etc.), so
  // it only enforces the absolute cap, not a per-schedule one.
  readonly jitterMinutes: number;
  // A job still running past this is killed (0 = no timeout enforced). Capped at
  // MAX_TIMER_MINUTES — see that constant's comment.
  readonly timeoutMinutes: number;
  // retry.delayMinutes is capped at MAX_TIMER_MINUTES too — see that constant's comment.
  readonly retry?: RetryConfig;
}

export interface OrchestratorConfig {
  readonly jobs: readonly JobConfig[];
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_JITTER_MINUTES = 0;
const DEFAULT_TIMEOUT_MINUTES = 60;
// Absolute backstop, not a per-schedule guarantee: deriving a cron expression's true minimum
// interval is expensive to do correctly (irregular gaps, DOM/DOW OR-matches — see cron.ts),
// so instead of computing it we just refuse jitter at or beyond a full hour. This still lets
// a >=hourly job jitter past its own next occurrence; document that risk at the call site
// (D1/orchestrator-recipe.md) rather than pretend this check makes every schedule safe.
const MAX_JITTER_MINUTES = 59;
// Node/Bun's setTimeout silently clamps any delay past a signed 32-bit int of milliseconds
// (2**31-1 = 2,147,483,647ms, ~24.86 days -> floor(.../60_000) = 35791 minutes) to ~1ms at
// runtime — see scheduler.ts's own MAX_TIMER_DELAY_MS for the mechanism this guards against
// on the scheduling-delay side. timeoutMinutes and retry.delayMinutes both become real
// setTimeout delays in scripts/orchestrate.ts (job timeout enforcement) and scheduler.ts
// (retry backoff) respectively — an operator writing something like 99999999 "to mean never"
// would clamp to ~1ms and silently break the job forever (instant SIGTERM on every run /
// instant retry), not fail loudly. Reject it at config load instead.
const MAX_TIMER_MINUTES = 35_791;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number, got ${JSON.stringify(value)}`);
  }
  if (value < 0) {
    throw new Error(`${label} must be >= 0, got ${value}`);
  }
  return value;
}

function requireJitterMinutes(value: unknown, label: string): number {
  const n = requireNonNegativeNumber(value, label);
  if (n > MAX_JITTER_MINUTES) {
    throw new Error(`${label} must be <= ${MAX_JITTER_MINUTES} (an hour or more of jitter risks skipping this job's own occurrences), got ${n}`);
  }
  return n;
}

function requireTimerMinutes(value: unknown, label: string, zeroMeaning?: string): number {
  const n = requireNonNegativeNumber(value, label);
  if (n > MAX_TIMER_MINUTES) {
    const zeroHint = zeroMeaning ? ` (use 0 for ${zeroMeaning}, not a large number)` : "";
    throw new Error(
      `${label} must be <= ${MAX_TIMER_MINUTES} minutes — a Bun/Node timer armed for longer than that silently ` +
        `clamps to ~1ms at runtime instead of the delay you asked for${zeroHint}, got ${n}`,
    );
  }
  return n;
}

function parseRetry(raw: unknown, label: string): RetryConfig {
  if (!isPlainObject(raw)) {
    throw new Error(`${label}: "retry" must be an object with "attempts" and "delayMinutes"`);
  }
  const attempts = requireNonNegativeNumber(raw["attempts"], `${label}: "retry.attempts"`);
  if (!Number.isInteger(attempts)) {
    throw new Error(`${label}: "retry.attempts" must be an integer, got ${attempts}`);
  }
  const delayMinutes = requireTimerMinutes(raw["delayMinutes"], `${label}: "retry.delayMinutes"`);
  return { attempts, delayMinutes };
}

function parseEnv(raw: unknown, label: string): Record<string, string> {
  if (!isPlainObject(raw)) {
    throw new Error(`${label}: "env" must be an object mapping string keys to string values`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`${label}: env key "${key}" must match ${ENV_KEY_RE}`);
    }
    if (typeof value !== "string") {
      throw new Error(`${label}: env["${key}"] must be a string`);
    }
    env[key] = value;
  }
  return env;
}

function parseJob(raw: unknown, index: number): JobConfig {
  if (!isPlainObject(raw)) {
    throw new Error(`job[${index}]: must be an object`);
  }

  const name = raw["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`job[${index}]: "name" is required and must be a non-empty string`);
  }
  const label = `job "${name}"`;

  const schedule = raw["schedule"];
  if (typeof schedule !== "string" || schedule.length === 0) {
    throw new Error(`${label}: "schedule" is required and must be a non-empty string`);
  }
  try {
    parseCron(schedule);
  } catch (err) {
    throw new Error(`${label}: "schedule" is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Syntax alone isn't enough: "0 0 31 2 *" (February 31st) parses fine field-by-field but
  // never matches any real date. Confirm satisfiability at LOAD time — fail-closed here,
  // not an uncaught throw out of the scheduler at first-scheduling time, and not a --dry-run
  // that prints an inline error row yet still exits 0. The anchor date doesn't change the
  // outcome for a genuinely (un)satisfiable expression: nextRun searches 4 years forward
  // from wherever it starts, and a schedule that matches at all matches at least once a
  // year (month/dom/dow constraints repeat annually), so "satisfiable from now" and
  // "satisfiable from any other now" agree in every practical case.
  try {
    nextRun(schedule, new Date());
  } catch (err) {
    throw new Error(`${label}: "schedule" is unsatisfiable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const command = raw["command"];
  if (typeof command !== "string" || command.length === 0) {
    throw new Error(`${label}: "command" is required and must be a non-empty string`);
  }

  const argsRaw = raw["args"] ?? [];
  if (!Array.isArray(argsRaw) || !argsRaw.every((a) => typeof a === "string")) {
    throw new Error(`${label}: "args" must be an array of strings`);
  }
  const args = argsRaw as string[];

  const env = parseEnv(raw["env"] ?? {}, label);

  const jitterMinutes =
    raw["jitterMinutes"] !== undefined ? requireJitterMinutes(raw["jitterMinutes"], `${label}: "jitterMinutes"`) : DEFAULT_JITTER_MINUTES;
  const timeoutMinutes =
    raw["timeoutMinutes"] !== undefined
      ? requireTimerMinutes(raw["timeoutMinutes"], `${label}: "timeoutMinutes"`, "no timeout enforced")
      : DEFAULT_TIMEOUT_MINUTES;

  const retry = raw["retry"] !== undefined ? parseRetry(raw["retry"], label) : undefined;

  return { name, schedule, command, args, env, jitterMinutes, timeoutMinutes, retry };
}

/**
 * Validates and normalizes an already-parsed JSON value into an OrchestratorConfig. No I/O —
 * but not perfectly deterministic: each job's schedule is checked for satisfiability via
 * `nextRun(schedule, new Date())`, so it reads the system clock (see parseJob). This never
 * affects the OUTPUT shape (the returned config is the same regardless of when validation
 * ran) — it only affects whether a genuinely-impossible schedule throws, and that answer
 * doesn't depend on the anchor date in practice (see the comment at the nextRun call site).
 */
export function parseOrchestratorConfig(raw: unknown): OrchestratorConfig {
  if (!isPlainObject(raw)) {
    throw new Error("orchestrator config: must be a JSON object");
  }
  const jobsRaw = raw["jobs"];
  if (!Array.isArray(jobsRaw)) {
    throw new Error(`orchestrator config: "jobs" is required and must be an array`);
  }

  const jobs = jobsRaw.map((j, i) => parseJob(j, i));

  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.name)) {
      throw new Error(`orchestrator config: duplicate job name "${job.name}"`);
    }
    seen.add(job.name);
  }

  return { jobs };
}

/** Reads and validates orchestrator.config.json from disk. Fail-closed: any error throws. */
export function loadOrchestratorConfig(path: string): OrchestratorConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`orchestrator config: cannot read "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`orchestrator config: "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseOrchestratorConfig(raw);
}
