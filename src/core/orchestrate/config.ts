// Fail-closed loader for orchestrator.config.json (D1 of the orchestrator-daemon
// plan). Every malformed field throws, naming the offending job (by name once
// known, else by index) and the field — startup-time config errors must be loud
// and specific, never a silent default or a generic "invalid config" message.
//
// SECURITY: job.env values are secrets-bearing (BC credentials, tokens, ...) —
// the config file on disk must be ACL-protected the same way the .cmd recipes
// it supersedes are. This loader never logs env values, only keys.
import { readFileSync } from "node:fs";
import { parseCron } from "./cron";

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
  readonly timeoutMinutes: number;
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

function parseRetry(raw: unknown, label: string): RetryConfig {
  if (!isPlainObject(raw)) {
    throw new Error(`${label}: "retry" must be an object with "attempts" and "delayMinutes"`);
  }
  const attempts = requireNonNegativeNumber(raw["attempts"], `${label}: "retry.attempts"`);
  if (!Number.isInteger(attempts)) {
    throw new Error(`${label}: "retry.attempts" must be an integer, got ${attempts}`);
  }
  const delayMinutes = requireNonNegativeNumber(raw["delayMinutes"], `${label}: "retry.delayMinutes"`);
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
      ? requireNonNegativeNumber(raw["timeoutMinutes"], `${label}: "timeoutMinutes"`)
      : DEFAULT_TIMEOUT_MINUTES;

  const retry = raw["retry"] !== undefined ? parseRetry(raw["retry"], label) : undefined;

  return { name, schedule, command, args, env, jitterMinutes, timeoutMinutes, retry };
}

/** Validates and normalizes an already-parsed JSON value into an OrchestratorConfig. Pure — no I/O. */
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
