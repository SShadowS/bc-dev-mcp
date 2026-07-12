import { describe, expect, test } from "bun:test";
import { matches, nextRun, parseCron } from "../../../src/core/orchestrate/cron";

describe("parseCron: field forms", () => {
  test("'*' matches every value in the field's range", () => {
    const p = parseCron("* * * * *");
    for (let h = 0; h <= 23; h++) {
      expect(matches(new Date(2026, 0, 1, h, 0), p)).toBe(true);
    }
  });

  test("a bare number matches only that value", () => {
    const p = parseCron("30 * * * *");
    expect(matches(new Date(2026, 0, 1, 10, 30), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 10, 31), p)).toBe(false);
    expect(matches(new Date(2026, 0, 1, 10, 29), p)).toBe(false);
  });

  test("a range N-M matches every value inside, inclusive, nothing outside", () => {
    const p = parseCron("* 9-17 * * *");
    expect(matches(new Date(2026, 0, 1, 9, 0), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 17, 0), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 13, 0), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 8, 0), p)).toBe(false);
    expect(matches(new Date(2026, 0, 1, 18, 0), p)).toBe(false);
  });

  test("a step */S matches every S-th value starting at the field minimum", () => {
    const p = parseCron("*/15 * * * *");
    expect(matches(new Date(2026, 0, 1, 0, 0), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 15), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 30), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 45), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 1), p)).toBe(false);
    expect(matches(new Date(2026, 0, 1, 0, 50), p)).toBe(false);
  });

  test("a range-step N-M/S matches every S-th value starting at N, capped at M", () => {
    const p = parseCron("10-30/5 * * * *");
    expect(matches(new Date(2026, 0, 1, 0, 10), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 15), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 20), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 25), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 30), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 35), p)).toBe(false); // past M
    expect(matches(new Date(2026, 0, 1, 0, 9), p)).toBe(false); // before N
  });

  test("a comma list matches the union of its members, each any form", () => {
    const p = parseCron("1,15,30-32,*/20 * * * *");
    expect(matches(new Date(2026, 0, 1, 0, 1), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 15), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 30), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 31), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 32), p)).toBe(true);
    expect(matches(new Date(2026, 0, 1, 0, 40), p)).toBe(true); // from */20
    expect(matches(new Date(2026, 0, 1, 0, 2), p)).toBe(false);
  });
});

describe("parseCron: day-of-week 7 is an alias for 0 (Sunday)", () => {
  test("dow field '7' matches the same days as '0'", () => {
    const pZero = parseCron("* * * * 0");
    const pSeven = parseCron("* * * * 7");
    // Walk a week of dates; both parses must agree on every day.
    for (let d = 0; d < 7; d++) {
      const date = new Date(2026, 0, 4 + d, 0, 0); // 2026-01-04 is a Sunday
      expect(matches(date, pSeven)).toBe(matches(date, pZero));
    }
  });

  test("a list mixing 0 and 7 for Sunday still matches Sunday exactly once (no double semantics issue)", () => {
    const p = parseCron("* * * * 0,7");
    let sunday = new Date(2026, 0, 4); // known Sunday
    expect(matches(sunday, p)).toBe(true);
    let monday = new Date(2026, 0, 5);
    expect(matches(monday, p)).toBe(false);
  });
});

describe("parseCron: vixie dom-OR-dow rule when both restricted", () => {
  test("'0 0 13 * 5': a 13th that is not a Friday still matches (dom side of the OR)", () => {
    const p = parseCron("0 0 13 * 5");
    let d = new Date(2026, 0, 13);
    while (d.getDay() === 5) d = new Date(d.getFullYear(), d.getMonth() + 1, 13);
    expect(matches(d, p)).toBe(true);
  });

  test("'0 0 13 * 5': a Friday that is not the 13th still matches (dow side of the OR)", () => {
    const p = parseCron("0 0 13 * 5");
    let d = new Date(2026, 0, 1);
    while (d.getDay() !== 5 || d.getDate() === 13) {
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
    expect(matches(d, p)).toBe(true);
  });

  test("'0 0 13 * 5': a day that is neither the 13th nor a Friday does not match", () => {
    const p = parseCron("0 0 13 * 5");
    let d = new Date(2026, 0, 1);
    while (d.getDay() === 5 || d.getDate() === 13) {
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
    expect(matches(d, p)).toBe(false);
  });

  test("when only dom is restricted (dow='*'), dow is ignored entirely", () => {
    const p = parseCron("0 0 13 * *");
    let notThirteenth = new Date(2026, 0, 14);
    expect(matches(notThirteenth, p)).toBe(false);
    let thirteenth = new Date(2026, 0, 13);
    expect(matches(thirteenth, p)).toBe(true);
  });

  test("when only dow is restricted (dom='*'), dom is ignored entirely", () => {
    const p = parseCron("0 0 * * 5");
    let d = new Date(2026, 0, 1);
    while (d.getDay() !== 5) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    expect(matches(d, p)).toBe(true);
    const notFriday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    expect(matches(notFriday, p)).toBe(false);
  });

  test("when neither is restricted ('*' '*'), every day matches", () => {
    const p = parseCron("0 0 * * *");
    for (let day = 1; day <= 28; day++) {
      expect(matches(new Date(2026, 0, day), p)).toBe(true);
    }
  });
});

describe("nextRun: strictly after `from`", () => {
  test("when `from` exactly equals a matching instant, the next match is the following occurrence, not `from` itself", () => {
    const from = new Date(2026, 6, 12, 10, 0, 0, 0); // exactly 10:00:00
    const result = nextRun("0 10 * * *", from);
    expect(result).toEqual(new Date(2026, 6, 13, 10, 0, 0, 0));
  });

  test("seconds/ms within the `from` minute do not cause an earlier or duplicate match", () => {
    const from = new Date(2026, 6, 12, 9, 59, 45, 500);
    const result = nextRun("0 10 * * *", from);
    expect(result).toEqual(new Date(2026, 6, 12, 10, 0, 0, 0));
  });

  test("a plain forward search within the same hour finds the very next minute match", () => {
    const from = new Date(2026, 6, 12, 10, 15, 0, 0);
    const result = nextRun("45 * * * *", from);
    expect(result).toEqual(new Date(2026, 6, 12, 10, 45, 0, 0));
  });
});

describe("nextRun: boundary rollovers", () => {
  test("minute -> hour rollover: due minute already passed this hour, rolls to next hour", () => {
    const from = new Date(2026, 6, 12, 10, 59, 0, 0);
    const result = nextRun("30 * * * *", from);
    expect(result).toEqual(new Date(2026, 6, 12, 11, 30, 0, 0));
  });

  test("hour -> day rollover: due hour already passed today, rolls to tomorrow", () => {
    const from = new Date(2026, 6, 12, 23, 30, 0, 0);
    const result = nextRun("0 1 * * *", from);
    expect(result).toEqual(new Date(2026, 6, 13, 1, 0, 0, 0));
  });

  test("day -> month rollover: last day of month rolls into the 1st of next month", () => {
    const from = new Date(2026, 6, 31, 23, 59, 0, 0); // July 31
    const result = nextRun("0 0 1 * *", from);
    expect(result).toEqual(new Date(2026, 7, 1, 0, 0, 0, 0)); // Aug 1
  });

  test("month -> year rollover: December rolls into January of the next year", () => {
    const from = new Date(2026, 11, 31, 23, 59, 0, 0); // Dec 31, 2026
    const result = nextRun("0 0 1 1 *", from);
    expect(result).toEqual(new Date(2027, 0, 1, 0, 0, 0, 0)); // Jan 1, 2027
  });

  test("Feb 29 (leap day) is correctly skipped in non-leap years and found on the next leap year", () => {
    const from = new Date(2027, 0, 1, 0, 0, 0, 0); // 2027 is not a leap year
    const result = nextRun("0 0 29 2 *", from);
    expect(result).toEqual(new Date(2028, 1, 29, 0, 0, 0, 0)); // 2028 is a leap year
  });

  test("month lengths: the 31st is skipped entirely in 30-day months", () => {
    const from = new Date(2026, 3, 15, 0, 0, 0, 0); // April 15 (April has 30 days)
    const result = nextRun("0 0 31 * *", from);
    // March 31 already passed; April has no 31st; next is May 31.
    expect(result).toEqual(new Date(2026, 4, 31, 0, 0, 0, 0));
  });
});

describe("nextRun: unsatisfiable expressions", () => {
  test("Feb 31st never occurs; nextRun throws once the 4-year search bound is exhausted", () => {
    expect(() => nextRun("0 0 31 2 *", new Date(2026, 0, 1))).toThrow(/unsatisfiable/i);
  });
});

describe("parseCron: malformed input throws naming the field position", () => {
  test("wrong field count (6 fields) throws", () => {
    expect(() => parseCron("0 0 * * * *")).toThrow(/5 fields/i);
  });

  test("wrong field count (4 fields) throws", () => {
    expect(() => parseCron("0 0 * *")).toThrow(/5 fields/i);
  });

  test("out-of-range minute (60) throws naming the minute field", () => {
    expect(() => parseCron("60 0 * * *")).toThrow(/minute/i);
  });

  test("out-of-range hour (24) throws naming the hour field", () => {
    expect(() => parseCron("0 24 * * *")).toThrow(/hour/i);
  });

  test("out-of-range day-of-month (0) throws naming the day-of-month field", () => {
    expect(() => parseCron("0 0 0 * *")).toThrow(/day-of-month/i);
  });

  test("out-of-range day-of-month (32) throws naming the day-of-month field", () => {
    expect(() => parseCron("0 0 32 * *")).toThrow(/day-of-month/i);
  });

  test("out-of-range month (13) throws naming the month field", () => {
    expect(() => parseCron("0 0 * 13 *")).toThrow(/month/i);
  });

  test("out-of-range day-of-week (8) throws naming the day-of-week field", () => {
    expect(() => parseCron("0 0 * * 8")).toThrow(/day-of-week/i);
  });

  test("garbage text in a field throws naming that field", () => {
    expect(() => parseCron("abc 0 * * *")).toThrow(/minute/i);
  });

  test("a malformed step (zero) throws", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow();
  });

  test("a range with start > end throws", () => {
    expect(() => parseCron("30-10 * * * *")).toThrow();
  });

  test("'*' combined with an explicit range ('*-5') throws rather than silently ignoring the range", () => {
    expect(() => parseCron("*-5 * * * *")).toThrow();
  });

  test("an empty field (trailing comma) throws", () => {
    expect(() => parseCron("1, * * * *")).toThrow();
  });

  test("a step attached to a bare value (N/S, no range) is rejected rather than silently collapsing to {N}", () => {
    expect(() => parseCron("5/15 * * * *")).toThrow(/minute/i);
    expect(() => parseCron("5/15 * * * *")).toThrow(/step/i);
  });

  test("'*/S' and 'N-M/S' remain valid — only the bare-value form is rejected", () => {
    expect(() => parseCron("*/15 * * * *")).not.toThrow();
    expect(() => parseCron("5-59/15 * * * *")).not.toThrow();
  });
});
