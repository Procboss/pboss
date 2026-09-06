import { describe, test, expect } from "bun:test";
import { parseSchedule, nextCronRun, validateCron } from "../src/cron-expr";

// Fixed "now" so assertions are deterministic:
// 2026-09-06 (Sunday) 08:00 local time.
const NOW = new Date(2026, 8, 6, 8, 0, 0, 0);

describe("parseSchedule — recurring friendly syntax", () => {
  test("everyday (bare) → daily at 00:00", () => {
    const s = parseSchedule("everyday", NOW);
    expect(s.kind).toBe("cron");
    expect(s.cron).toBe("0 0 * * *");
    expect(s.description).toContain("00:00");
  });

  test("everyday@10 → daily at 10:00", () => {
    const s = parseSchedule("everyday@10", NOW);
    expect(s.cron).toBe("0 10 * * *");
  });

  test("everyday@9:11 → daily at 09:11", () => {
    const s = parseSchedule("everyday@9:11", NOW);
    expect(s.cron).toBe("11 9 * * *");
    expect(s.description).toBe("every day at 09:11");
  });

  test("everyday@09:11 zero-padded", () => {
    const s = parseSchedule("everyday@09:11", NOW);
    expect(s.cron).toBe("11 9 * * *");
  });

  test("everyday@24:30 → 00:30 (hour 24 = next day; same daily cycle)", () => {
    const s = parseSchedule("everyday@24:30", NOW);
    expect(s.cron).toBe("30 0 * * *");
  });

  test("daily / eachday aliases", () => {
    expect(parseSchedule("daily@7", NOW).cron).toBe("0 7 * * *");
    expect(parseSchedule("eachday@7", NOW).cron).toBe("0 7 * * *");
  });

  test("everyhour → every hour at :00", () => {
    const s = parseSchedule("everyhour", NOW);
    expect(s.cron).toBe("0 * * * *");
  });

  test("everyhour@30 → every hour at :30", () => {
    const s = parseSchedule("everyhour@30", NOW);
    expect(s.cron).toBe("30 * * * *");
  });

  test("hourly alias", () => {
    expect(parseSchedule("hourly@15", NOW).cron).toBe("15 * * * *");
  });

  test("everyhour rejects H:M (minute only)", () => {
    expect(() => parseSchedule("everyhour@10:30", NOW)).toThrow(/minute 0-59/i);
  });

  test("everyminute", () => {
    expect(parseSchedule("everyminute", NOW).cron).toBe("* * * * *");
  });

  test("everyweek → Sunday 00:00", () => {
    const s = parseSchedule("everyweek", NOW);
    expect(s.cron).toBe("0 0 * * 0");
  });

  test("everyweek@10:10 → Sunday 10:10", () => {
    const s = parseSchedule("everyweek@10:10", NOW);
    expect(s.cron).toBe("10 10 * * 0");
  });

  test("every-sunday → cron dow 0", () => {
    const s = parseSchedule("every-sunday", NOW);
    expect(s.cron).toBe("0 0 * * 0");
  });

  test("everySunday@10:10 camelCase", () => {
    const s = parseSchedule("everyMonday@10:10", NOW);
    expect(s.cron).toBe("10 10 * * 1");
  });

  test("onSunday@23:10 — the 'on' prefix", () => {
    const s = parseSchedule("onSunday@23:10", NOW);
    expect(s.cron).toBe("10 23 * * 0");
  });

  test("onTuesday@23:10", () => {
    const s = parseSchedule("onTuesday@23:10", NOW);
    expect(s.cron).toBe("10 23 * * 2");
  });

  test("3-letter weekday abbreviations", () => {
    expect(parseSchedule("every-sat@22:00", NOW).cron).toBe("0 22 * * 6");
    expect(parseSchedule("onFri@12", NOW).cron).toBe("0 12 * * 5");
    expect(parseSchedule("every-thu", NOW).cron).toBe("0 0 * * 4");
  });

  test("plural 'sundays' form", () => {
    expect(parseSchedule("sundays@9", NOW).cron).toBe("0 9 * * 0");
  });

  test("weekday with hour 24 shifts to next day", () => {
    // Sunday 24:30 = Monday 00:30
    const s = parseSchedule("every-sunday@24:30", NOW);
    expect(s.cron).toBe("30 0 * * 1");
  });

  test("everymonth → 1st at 00:00", () => {
    expect(parseSchedule("everymonth", NOW).cron).toBe("0 0 1 * *");
  });

  test("everymonth@10:10", () => {
    expect(parseSchedule("everymonth@10:10", NOW).cron).toBe("10 10 1 * *");
  });

  test("every-15th → monthly on the 15th", () => {
    const s = parseSchedule("every-15th", NOW);
    expect(s.cron).toBe("0 0 15 * *");
    expect(s.description).toContain("15th");
  });

  test("every-15 with time", () => {
    expect(parseSchedule("every-15@10:10", NOW).cron).toBe("10 10 15 * *");
  });

  test("every-6-hours → 0 */6 * * *", () => {
    expect(parseSchedule("every-6-hours", NOW).cron).toBe("0 */6 * * *");
  });

  test("every-6-hours@30 → minute 30", () => {
    expect(parseSchedule("every-6-hours@30", NOW).cron).toBe("30 */6 * * *");
  });

  test("every-30-minutes → */30 * * * *", () => {
    expect(parseSchedule("every-30-minutes", NOW).cron).toBe("*/30 * * * *");
  });

  test("every-2-days@8", () => {
    expect(parseSchedule("every-2-days@8", NOW).cron).toBe("0 8 */2 * *");
  });
});

describe("parseSchedule — one-shot syntax", () => {
  test("today@23:10 → today at 23:10", () => {
    const s = parseSchedule("today@23:10", NOW);
    expect(s.kind).toBe("once");
    expect(s.at).toBe(new Date(2026, 8, 6, 23, 10).getTime());
  });

  test("today@7:59 (already passed) → error suggesting tomorrow", () => {
    expect(() => parseSchedule("today@7:59", NOW)).toThrow(/already past/i);
  });

  test("today@8:00 (exactly now) → error", () => {
    expect(() => parseSchedule("today@8:00", NOW)).toThrow(/already past/i);
  });

  test("tomorrow@8:00 → tomorrow 08:00", () => {
    const s = parseSchedule("tomorrow@8:00", NOW);
    expect(s.at).toBe(new Date(2026, 8, 7, 8, 0).getTime());
  });

  test("onDate@24-10-2026 → that date at 00:00", () => {
    const s = parseSchedule("onDate@24-10-2026", NOW);
    expect(s.kind).toBe("once");
    expect(s.at).toBe(new Date(2026, 9, 24, 0, 0).getTime());
  });

  test("onDate@24-10-2026-23:10 → that date at 23:10", () => {
    const s = parseSchedule("onDate@24-10-2026-23:10", NOW);
    expect(s.at).toBe(new Date(2026, 9, 24, 23, 10).getTime());
  });

  test("onDate rejects past dates", () => {
    expect(() => parseSchedule("onDate@1-1-2020-10:00", NOW)).toThrow(/past/i);
  });

  test("onDate rejects calendar-invalid dates (31 Feb)", () => {
    expect(() => parseSchedule("onDate@31-02-2026", NOW)).toThrow(/does not exist/i);
  });

  test("onDate honors leap years", () => {
    const s = parseSchedule("onDate@29-02-2028", NOW);
    expect(s.at).toBe(new Date(2028, 1, 29, 0, 0).getTime());
  });

  test("onDate rejects non-leap 29 Feb", () => {
    expect(() => parseSchedule("onDate@29-02-2027", NOW)).toThrow(/does not exist/i);
  });

  test("onDate rejects month 13", () => {
    expect(() => parseSchedule("onDate@5-13-2026", NOW)).toThrow(/month/i);
  });

  test("today@24:30 → tomorrow 00:30", () => {
    const s = parseSchedule("today@24:30", NOW);
    expect(s.at).toBe(new Date(2026, 8, 7, 0, 30).getTime());
  });
});

describe("parseSchedule — raw cron escape hatch", () => {
  test("5-field cron passes through", () => {
    const s = parseSchedule("*/5 * * * *", NOW);
    expect(s.kind).toBe("cron");
    expect(s.cron).toBe("*/5 * * * *");
  });

  test("complex cron passes through", () => {
    const s = parseSchedule("30 2 * * 1-5", NOW);
    expect(s.cron).toBe("30 2 * * 1-5");
  });

  test("invalid cron expression rejected", () => {
    expect(() => parseSchedule("61 * * * *", NOW)).toThrow(/Invalid cron/i);
    expect(() => parseSchedule("* * * *", NOW)).toThrow(/Unknown schedule/i);
  });
});

describe("parseSchedule — errors", () => {
  test("garbage input gets helpful message with examples", () => {
    expect(() => parseSchedule("sometime", NOW)).toThrow(/Unknown schedule/i);
  });

  test("empty schedule", () => {
    expect(() => parseSchedule("", NOW)).toThrow(/Empty/i);
  });

  test("hour > 24 rejected", () => {
    expect(() => parseSchedule("everyday@25:00", NOW)).toThrow(/0-24/i);
  });

  test("minutes > 59 rejected", () => {
    expect(() => parseSchedule("everyday@10:75", NOW)).toThrow(/0-59/i);
  });

  test("monthly with hour 24 rejected (would push 1st → 2nd)", () => {
    expect(() => parseSchedule("everymonth@24:30", NOW)).toThrow(/monthly/i);
  });

  test("day-of-month out of range", () => {
    expect(() => parseSchedule("every-32nd", NOW)).toThrow(/1-31/i);
  });
});

describe("next-run computation (cron-parser)", () => {
  test("everyday@9:11 from 08:00 → today 09:11", () => {
    const s = parseSchedule("everyday@9:11", NOW)!;
    const next = nextCronRun(s.cron!, NOW);
    expect(new Date(next).getHours()).toBe(9);
    expect(new Date(next).getMinutes()).toBe(11);
    expect(new Date(next).getDate()).toBe(6);
  });

  test("everyday@9:11 from 10:00 → tomorrow 09:11", () => {
    const later = new Date(2026, 8, 6, 10, 0);
    const next = nextCronRun("11 9 * * *", later);
    expect(new Date(next).getDate()).toBe(7);
  });

  test("every-sunday from Sunday 08:00 → same Sunday (00:00 already passed → next week)", () => {
    const s = parseSchedule("every-sunday@10:10", NOW);
    const next = nextCronRun(s.cron!, NOW);
    // 10:10 hasn't passed yet (now = 08:00), so it fires today.
    expect(new Date(next).getDate()).toBe(6);
    const next2 = nextCronRun(s.cron!, new Date(2026, 8, 6, 11, 0));
    expect(new Date(next2).getDate()).toBe(13);
  });

  test("validateCron accepts and rejects", () => {
    expect(validateCron("0 0 * * *")).toBe("0 0 * * *");
    expect(() => validateCron("not a cron")).toThrow();
  });
});
