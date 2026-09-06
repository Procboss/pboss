/**
 * ProcBoss (pboss) — Bun Process Manager
 * A production-grade process manager for Bun.
 *
 * Human-friendly schedule expressions for cron jobs.
 *
 * This module converts the friendly syntax accepted by `pboss cron run …`
 * and the `crons` array in ecosystem files into either a standard 5-field
 * cron expression (recurring jobs) or an absolute timestamp (one-shot
 * jobs). Cron math is delegated to the mature `cron-parser` library, which
 * also validates raw cron expressions passed through as an escape hatch.
 *
 * Grammar
 * ───────
 * Recurring (converted to cron):
 *
 *   everyday [daily]                every day at 00:00
 *   everyday@10                     every day at 10:00
 *   everyday@9:11                   every day at 09:11
 *   everyday@24:30                  every day at 00:30 (24:xx = next day)
 *
 *   everyhour [hourly]              every hour at :00
 *   everyhour@30                    every hour at :30
 *   everyminute                     every minute
 *
 *   everyweek [weekly]              every Sunday at 00:00
 *   everyweek@10:10                 every Sunday at 10:10
 *
 *   every-sunday                    every Sunday at 00:00
 *   everySunday@10:10               every Sunday at 10:10
 *   onSunday@23:10                  same (the "on" prefix is an alias)
 *   every-sat / onSat               3-letter weekday names work too
 *
 *   everymonth [monthly]            every 1st at 00:00
 *   every-15th [@10:10]             every 15th at 00:00 / 10:10
 *
 *   every-6-hours [@30]             every 6 hours at :00 / :30
 *   every-30-minutes                every 30 minutes
 *   every-2-days [@8]               every 2nd day at 00:00 / 08:00
 *
 * One-shot (converted to a timestamp):
 *
 *   today@23:10                     today at 23:10 (must be in the future)
 *   tomorrow@8:00                   tomorrow at 08:00
 *   onDate@24-10-2026               24 Oct 2026 at 00:00  (day-month-year)
 *   onDate@24-10-2026-23:10         24 Oct 2026 at 23:10
 *
 * Escape hatch:
 *
 *   30 2 * * 1-5                  any raw 5-field cron expression
 *
 * Times use the 24-hour clock. Hour 24 is accepted and means "the following
 * day" (24:30 = 00:30 the next day; 24:00 = midnight rolling into the next
 * day). Dates are day-month-year, e.g. 24-10-2026 = October 24, 2026.
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */

import { CronExpressionParser } from "cron-parser";

/** A parsed schedule: either a recurring cron expression or a one-shot time. */
export interface ParsedSchedule {
  /** "cron" = recurring, "once" = one-shot timestamp. */
  kind: "cron" | "once";
  /** Standard 5-field cron expression (kind === "cron"). */
  cron?: string;
  /** Absolute execution time in epoch ms (kind === "once"). */
  at?: number;
  /** Human-readable expansion, e.g. "every day at 09:11". */
  description: string;
  /** The original input string, echoed back in listings. */
  source: string;
}

/** Weekday name → cron day-of-week number (0 = Sunday). */
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/**
 * Fields that look like a raw cron expression (5 whitespace-separated fields
 * of digits, `*`, `,`, `-`, `/`).
 */
const RAW_CRON_RE = /^[\d*,\-\/]+(\s+[\d*,\-\/]+){4}$/;

/**
 * Validate a 5-field cron expression with cron-parser. Throws a readable
 * error when invalid.
 */
export function validateCron(expression: string): string {
  try {
    CronExpressionParser.parse(expression, { currentDate: new Date() });
    return expression;
  } catch (err: any) {
    throw new Error(
      `Invalid cron expression "${expression}": ${err?.message ?? "parse error"}`
    );
  }
}

/** Compute the next occurrence of a cron expression strictly after `from`. */
export function nextCronRun(cron: string, from: Date = new Date()): number {
  const itr = CronExpressionParser.parse(cron, { currentDate: from });
  return itr.next().toDate().getTime();
}

/** Compute the next `count` occurrences of a cron expression after `from`. */
export function nextCronRuns(
  cron: string,
  count: number,
  from: Date = new Date()
): number[] {
  const itr = CronExpressionParser.parse(cron, { currentDate: from });
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    try {
      times.push(itr.next().toDate().getTime());
    } catch {
      break; // exhausted
    }
  }
  return times;
}

/**
 * A parsed time-of-day. `dayShift` carries the "hour 24" convention:
 * 24:30 → hour 0, minute 30, dayShift 1 (the following day).
 */
interface TimeOfDay {
  hour: number;
  minute: number;
  dayShift: number;
}

/** Parse a minute-only value (for hourly contexts: everyhour@30). */
function parseMinute(raw: string, context: string): number {
  const m = raw.match(/^(\d{1,2})$/);
  if (!m) {
    throw new Error(
      `Invalid time "${raw}" in "${context}" — expected a minute 0-59, e.g. everyhour@30`
    );
  }
  const minute = parseInt(m[1]!, 10);
  if (minute > 59) {
    throw new Error(`Invalid minute in "${context}" — minutes are 0-59`);
  }
  return minute;
}

function parseTime(raw: string, context: string): TimeOfDay {
  const m = raw.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) {
    throw new Error(
      `Invalid time "${raw}" in "${context}" — expected H or H:M (24-hour clock), e.g. 9, 9:11, 23:10`
    );
  }
  let hour = parseInt(m[1]!, 10);
  const minute = m[2] ? parseInt(m[2]!, 10) : 0;
  let dayShift = 0;

  if (hour === 24) {
    // 24:xx = 00:xx of the following day (24:00 rolls into the next day).
    hour = 0;
    dayShift = 1;
  } else if (hour > 24) {
    throw new Error(
      `Invalid hour in "${context}" — hours are 0-24 (24:30 means 00:30 the next day)`
    );
  }
  if (minute > 59) {
    throw new Error(`Invalid minute in "${context}" — minutes are 0-59`);
  }

  return { hour, minute, dayShift };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Render a TimeOfDay back as HH:MM. */
function timeString(t: TimeOfDay): string {
  return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

/**
 * Parse a day-month-year date, optionally with a trailing time
 * (`D-M-Y` or `D-M-Y-H:M`). Validates the real calendar (rejects
 * 31-02-2026, honors leap years) by round-tripping through Date.
 */
function parseDateTime(raw: string, context: string, now: Date): number {
  const m = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:-(\d{1,2}):(\d{1,2}))?$/);
  if (!m) {
    throw new Error(
      `Invalid date "${raw}" in "${context}" — expected day-month-year[-HH:MM], e.g. 24-10-2026 or 24-10-2026-23:10`
    );
  }

  const day = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10);
  const year = parseInt(m[3]!, 10);
  let hour = m[4] !== undefined ? parseInt(m[4]!, 10) : 0;
  let minute = m[5] !== undefined ? parseInt(m[5]!, 10) : 0;
  let dayShift = 0;

  if (hour === 24) {
    hour = 0;
    dayShift = 1;
  } else if (hour > 24) {
    throw new Error(
      `Invalid hour in "${context}" — hours are 0-24 (24:30 means 00:30 the next day)`
    );
  }
  if (minute > 59) {
    throw new Error(`Invalid minute in "${context}" — minutes are 0-59`);
  }

  // Month sanity up-front (Date would silently roll 13 → January next year).
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month in "${context}" — months are 1-12 (day-month-year order)`);
  }

  const date = new Date(year, month - 1, day + dayShift, hour, minute, 0, 0);

  // Round-trip check: Date auto-rolls invalid dates, so verify every field.
  if (
    date.getDate() !== day + dayShift ||
    date.getMonth() !== month - 1 ||
    date.getFullYear() !== year
  ) {
    throw new Error(
      `Invalid date "${raw}" — ${day}-${month}-${year} does not exist on the calendar`
    );
  }

  if (date.getTime() <= now.getTime()) {
    throw new Error(
      `"${context}" is in the past — one-shot schedules must be in the future. ` +
        `Try tomorrow@${pad2(hour)}:${pad2(minute)} or a later onDate@day-month-year`
    );
  }

  return date.getTime();
}

/**
 * Parse a friendly schedule string into a ParsedSchedule.
 * Throws a descriptive Error when the input is not valid.
 */
export function parseSchedule(input: string, now: Date = new Date()): ParsedSchedule {
  const source = input.trim();
  if (!source) {
    throw new Error("Empty schedule");
  }

  // Escape hatch: a raw 5-field cron expression.
  if (RAW_CRON_RE.test(source)) {
    validateCron(source);
    return {
      kind: "cron",
      cron: source,
      description: `cron: ${source}`,
      source,
    };
  }

  // Split off the optional "@time" suffix.
  const atPos = source.indexOf("@");
  const baseRaw = atPos === -1 ? source : source.slice(0, atPos);
  const timeRaw = atPos === -1 ? undefined : source.slice(atPos + 1);

  // Normalize: lowercase, strip separators, collapse the every/on prefixes.
  const base = baseRaw.toLowerCase().replace(/[\s_-]+/g, "");

  const requireTime = (): string => {
    if (!timeRaw) {
      throw new Error(`"${source}" needs a time — e.g. ${baseRaw}@9:11`);
    }
    return timeRaw!;
  };

  const noTimeAllowed = () => {
    if (timeRaw !== undefined) {
      throw new Error(`"${source}" does not take an @time part`);
    }
  };

  // ── one-shot keywords ──────────────────────────────────────────────────

  if (base === "today" || base === "tonight") {
    const t = parseTime(requireTime(), source);
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + t.dayShift, t.hour, t.minute, 0, 0);
    if (date.getTime() <= now.getTime()) {
      throw new Error(
        `"${source}" is already past — use tomorrow@${timeString(t)} or onDate@day-month-year[-HH:MM] instead`
      );
    }
    return {
      kind: "once",
      at: date.getTime(),
      description: `today at ${timeString(t)}`,
      source,
    };
  }

  if (base === "tomorrow" || base === "tmr") {
    const t = parseTime(requireTime(), source);
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1 + t.dayShift, t.hour, t.minute, 0, 0);
    return {
      kind: "once",
      at: date.getTime(),
      description: `tomorrow at ${timeString(t)}`,
      source,
    };
  }

  if (base === "ondate" || base === "atdate" || base === "on") {
    const at = parseDateTime(requireTime(), source, now);
    return {
      kind: "once",
      at,
      description: `once at ${new Date(at).toLocaleString()}`,
      source,
    };
  }

  // ── recurring keywords ─────────────────────────────────────────────────

  // everyday / daily
  if (base === "everyday" || base === "daily" || base === "eachday") {
    const t = parseTime(timeRaw ?? "0", source);
    // For a daily cycle, a day shift is a no-op (00:30 next day == 00:30 daily).
    return {
      kind: "cron",
      cron: `${t.minute} ${t.hour} * * *`,
      description: `every day at ${timeString(t)}`,
      source,
    };
  }

  // everyhour / hourly
  if (base === "everyhour" || base === "hourly") {
    const minute = timeRaw !== undefined ? parseMinute(timeRaw, source) : 0;
    return {
      kind: "cron",
      cron: `${minute} * * * *`,
      description: `every hour at :${pad2(minute)}`,
      source,
    };
  }

  // everyminute
  if (base === "everyminute" || base === "everymin") {
    noTimeAllowed();
    return { kind: "cron", cron: "* * * * *", description: "every minute", source };
  }

  // everyweek / weekly (Sunday by default)
  if (base === "everyweek" || base === "weekly" || base === "eachweek") {
    const t = parseTime(timeRaw ?? "0", source);
    const dow = (0 + t.dayShift) % 7;
    const desc =
      t.dayShift === 0
        ? `every week (Sunday) at ${timeString(t)}`
        : `every week (Monday) at ${timeString(t)}`;
    return {
      kind: "cron",
      cron: `${t.minute} ${t.hour} * * ${dow}`,
      description: desc,
      source,
    };
  }

  // everymonth / monthly (1st by default)
  if (base === "everymonth" || base === "monthly" || base === "eachmonth") {
    const t = parseTime(timeRaw ?? "0", source);
    if (t.dayShift) {
      throw new Error(
        `Hour 24 would push the 1st into the 2nd — use hours 0-23 for monthly, e.g. everymonth@0:30`
      );
    }
    return {
      kind: "cron",
      cron: `${t.minute} ${t.hour} 1 * *`,
      description: `every month (1st) at ${timeString(t)}`,
      source,
    };
  }

  // every-N-minutes / every-N-mins
  {
    const m = base.match(/^every(\d+)(minutes|mins|min)$/);
    if (m) {
      noTimeAllowed();
      const step = parseInt(m[1]!, 10);
      if (step < 1 || step > 59) {
        throw new Error(`Step out of range in "${source}" — use every-2-minutes … every-59-minutes`);
      }
      return {
        kind: "cron",
        cron: `*/${step} * * * *`,
        description: `every ${step} minutes`,
        source,
      };
    }
  }

  // every-N-hours
  {
    const m = base.match(/^every(\d+)hours?$/);
    if (m) {
      const step = parseInt(m[1]!, 10);
      if (step < 1 || step > 23) {
        throw new Error(`Step out of range in "${source}" — use every-2-hours … every-23-hours`);
      }
      const minute = timeRaw !== undefined ? parseMinute(timeRaw, source) : 0;
      return {
        kind: "cron",
        cron: `${minute} */${step} * * *`,
        description: `every ${step} hours at :${pad2(minute)}`,
        source,
      };
    }
  }

  // every-N-days
  {
    const m = base.match(/^every(\d+)days?$/);
    if (m) {
      const step = parseInt(m[1]!, 10);
      if (step < 1 || step > 30) {
        throw new Error(`Step out of range in "${source}" — use every-2-days … every-30-days`);
      }
      const t = parseTime(timeRaw ?? "0", source);
      if (t.dayShift) {
        throw new Error(
          `Hour 24 cannot shift a day step — use hours 0-23, e.g. every-2-days@8`
        );
      }
      return {
        kind: "cron",
        cron: `${t.minute} ${t.hour} */${step} * *`,
        description: `every ${step} days at ${timeString(t)}`,
        source,
      };
    }
  }

  // every-15th / every-15 (monthly day-of-month)
  {
    const m = base.match(/^every(\d+)(?:st|nd|rd|th)?$/);
    if (m) {
      const dom = parseInt(m[1]!, 10);
      if (dom < 1 || dom > 31) {
        throw new Error(`Day out of range in "${source}" — days of the month are 1-31`);
      }
      const t = parseTime(timeRaw ?? "0", source);
      const shifted = dom + t.dayShift;
      if (shifted > 31) {
        throw new Error(`Hour 24 would push day ${dom} past the month end — use hours 0-23`);
      }
      return {
        kind: "cron",
        cron: `${t.minute} ${t.hour} ${shifted} * *`,
        description: `every month on the ${dom}${ordinalSuffix(dom)} at ${timeString(t)}`,
        source,
      };
    }
  }

  // weekdays: every-sunday / everySunday / onSunday / sundays
  {
    let wd = base;
    for (const prefix of ["every", "on", "each"]) {
      if (wd.startsWith(prefix) && wd.length > prefix.length) {
        const rest = wd.slice(prefix.length);
        if (rest in WEEKDAYS) {
          wd = rest;
          break;
        }
      }
    }
    if (wd.endsWith("s") && !(wd in WEEKDAYS) && wd.slice(0, -1) in WEEKDAYS) {
      wd = wd.slice(0, -1); // accept "sundays"
    }
    if (wd in WEEKDAYS) {
      const dow = WEEKDAYS[wd]!;
      const t = parseTime(timeRaw ?? "0", source);
      const shifted = (dow + t.dayShift) % 7;
      const dayName = DAY_NAMES[dow]!;
      const descDay = DAY_NAMES[shifted]!;
      return {
        kind: "cron",
        cron: `${t.minute} ${t.hour} * * ${shifted}`,
        description:
          t.dayShift === 0
            ? `every ${dayName} at ${timeString(t)}`
            : `every ${dayName} at ${timeString(t)} (fires ${descDay} 00:${pad2(t.minute)})`,
        source,
      };
    }
  }

  // Nothing matched.
  throw new Error(
    `Unknown schedule "${source}". Examples: everyday@9:11 · every-sunday@10:10 · everyweek · ` +
      `everymonth · every-15th@10:10 · every-6-hours@30 · today@23:10 · tomorrow@8:00 · ` +
      `onDate@24-10-2026-23:10 · "*/5 * * * *"`
  );
}

/** 1 → "st", 2 → "nd", 3 → "rd", 4 → "th", 11/12/13 → "th", … */
function ordinalSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
