// Dependency-free 5-field cron parser (min hour dom mon dow) — D2 of the
// orchestrator-daemon plan. Standard vixie(8) semantics: when BOTH
// day-of-month and day-of-week are restricted (neither is "*"), a day
// matches if EITHER field matches (OR, not AND); if only one is restricted,
// that field alone decides; if both are "*", every day matches.
//
// Time handling: nextRun operates entirely in the process's LOCAL time zone
// — the conventional interpretation for cron expressions ("30 2 * * *" means
// 2:30 AM on the machine running the daemon, matching cron(8) and Windows
// Task Scheduler). It never reads the system clock: `from` is the caller's
// sole time source, so nextRun is a pure function of (expr, from) and is
// fully unit-testable with fixed dates. DST transitions are a known,
// undocumented-behavior edge case of this choice (a "spring forward" can
// skip local wall-clock minutes; a "fall back" can revisit them) — accepted
// as the honest cost of local-time cron semantics rather than pretending
// UTC is what operators mean when they write a schedule.

interface FieldDef {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const FIELDS: readonly [FieldDef, FieldDef, FieldDef, FieldDef, FieldDef] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

const FIELD_TERM_RE = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

export interface ParsedCron {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

function parseField(raw: string, def: FieldDef): Set<number> {
  const values = new Set<number>();
  for (const term of raw.split(",")) {
    if (term.length === 0) {
      throw new Error(`cron ${def.name} field: empty term in "${raw}"`);
    }
    const m = FIELD_TERM_RE.exec(term);
    if (!m) {
      throw new Error(`cron ${def.name} field: malformed term "${term}"`);
    }
    const [, base, rangeEnd, stepRaw] = m;
    let start: number;
    let end: number;
    if (base === "*") {
      if (rangeEnd !== undefined) {
        throw new Error(`cron ${def.name} field: "*" cannot be combined with a range in "${term}"`);
      }
      start = def.min;
      end = def.max;
    } else {
      start = Number(base);
      end = rangeEnd !== undefined ? Number(rangeEnd) : start;
    }
    const step = stepRaw !== undefined ? Number(stepRaw) : 1;
    if (step <= 0) {
      throw new Error(`cron ${def.name} field: step must be a positive integer in "${term}"`);
    }
    if (start > end) {
      throw new Error(`cron ${def.name} field: range start ${start} is greater than end ${end} in "${term}"`);
    }
    for (let v = start; v <= end; v += step) {
      if (v < def.min || v > def.max) {
        throw new Error(`cron ${def.name} field: value ${v} out of range ${def.min}-${def.max} in "${term}"`);
      }
      // dow 7 is an alias for 0 (Sunday) — normalize at parse time so matching
      // never has to special-case it.
      values.add(def.name === "day-of-week" && v === 7 ? 0 : v);
    }
  }
  return values;
}

/** Parses a 5-field cron expression. Throws, naming the offending field, on any malformed input. */
export function parseCron(expr: string): ParsedCron {
  const rawFields = expr.trim().split(/\s+/);
  if (rawFields.length !== 5) {
    throw new Error(
      `cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${rawFields.length}: "${expr}"`,
    );
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = rawFields as [string, string, string, string, string];
  return {
    minute: parseField(minuteRaw, FIELDS[0]),
    hour: parseField(hourRaw, FIELDS[1]),
    dom: parseField(domRaw, FIELDS[2]),
    month: parseField(monthRaw, FIELDS[3]),
    dow: parseField(dowRaw, FIELDS[4]),
    domRestricted: domRaw !== "*",
    dowRestricted: dowRaw !== "*",
  };
}

/** True if `date` (read in local time) satisfies the parsed cron expression, per the vixie dom/dow OR rule. */
export function matches(date: Date, p: ParsedCron): boolean {
  if (!p.minute.has(date.getMinutes())) return false;
  if (!p.hour.has(date.getHours())) return false;
  if (!p.month.has(date.getMonth() + 1)) return false;

  const domMatch = p.dom.has(date.getDate());
  const dowMatch = p.dow.has(date.getDay());
  if (p.domRestricted && p.dowRestricted) return domMatch || dowMatch;
  if (p.domRestricted) return domMatch;
  if (p.dowRestricted) return dowMatch;
  return true;
}

const SEARCH_BOUND_YEARS = 4;

/**
 * The earliest local-time instant strictly after `from` that satisfies `expr`, at
 * minute granularity. Throws if none is found within a 4-year search bound (an
 * expression like "0 0 31 2 *" — Feb 31st — is unsatisfiable at any distance).
 */
export function nextRun(expr: string, from: Date): Date {
  const parsed = parseCron(expr);

  // Floor `from` to the minute, then step forward one minute — this is what
  // makes the search strictly-after regardless of `from`'s seconds/ms, and
  // guarantees `from` itself (even an exact match) is never returned.
  const floored = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes(), 0, 0);
  let candidate = new Date(floored.getTime() + 60_000);
  const bound = new Date(from.getFullYear() + SEARCH_BOUND_YEARS, from.getMonth(), from.getDate(), from.getHours(), from.getMinutes(), 0, 0);

  while (candidate.getTime() <= bound.getTime()) {
    if (matches(candidate, parsed)) return candidate;
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new Error(`cron expression "${expr}" is unsatisfiable: no match found within ${SEARCH_BOUND_YEARS} years of ${from.toISOString()}`);
}
