import { describe, test, expect } from "bun:test";

function parseCronField(field: string, min: number, max: number): number[] | null {
  if (field === "*") {
    const values: number[] = [];
    for (let i = min; i <= max; i++) values.push(i);
    return values;
  }

  if (field.includes("/")) {
    const [rangeStr, stepStr] = field.split("/");
    if (!rangeStr || !stepStr) return null;
    const step = parseInt(stepStr);
    if (isNaN(step) || step <= 0) return null;

    let start = min;
    let end = max;
    if (rangeStr !== "*") {
      if (rangeStr.includes("-")) {
        const [startStr, endStr] = rangeStr.split("-");
        if (!startStr || !endStr) return null;
        start = parseInt(startStr);
        end = parseInt(endStr);
      } else {
        start = parseInt(rangeStr);
      }
    }

    const values: number[] = [];
    for (let i = start; i <= end; i += step) values.push(i);
    return values;
  }

  if (field.includes(",")) {
    const values = field.split(",").map((v) => parseInt(v.trim()));
    if (values.some((v) => isNaN(v) || v < min || v > max)) return null;
    return values;
  }

  if (field.includes("-")) {
    const [startStr, endStr] = field.split("-");
    if (!startStr || !endStr) return null;
    const start = parseInt(startStr);
    const end = parseInt(endStr);
    if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) return null;
    const values: number[] = [];
    for (let i = start; i <= end; i++) values.push(i);
    return values;
  }

  const value = parseInt(field);
  if (isNaN(value) || value < min || value > max) return null;
  return [value];
}

function parseCron(expression: string): number[][] | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const ranges: [number, number][] = [
    [0, 59],  // minute
    [0, 23],  // hour
    [1, 31],  // day of month
    [1, 12],  // month
    [0, 6],   // day of week
  ];

  const result: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const part = parts[i]!;
    const range = ranges[i]!;
    const parsed = parseCronField(part, range[0], range[1]);
    if (!parsed) return null;
    result.push(parsed);
  }

  return result;
}

function matchesCron(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];

  const dateValues = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];

  for (let i = 0; i < 5; i++) {
    const part = parts[i]!;
    const range = ranges[i]!;
    const dateValue = dateValues[i]!;
    const allowed = parseCronField(part, range[0], range[1]);
    if (!allowed || !allowed.includes(dateValue)) return false;
  }

  return true;
}

describe("Cron Parser", () => {
  describe("parseCronField", () => {
    test("wildcard returns all values", () => {
      const result = parseCronField("*", 0, 59);
      expect(result).toHaveLength(60);
      expect(result![0]).toBe(0);
      expect(result![59]).toBe(59);
    });

    test("single value", () => {
      expect(parseCronField("5", 0, 59)).toEqual([5]);
    });

    test("range", () => {
      expect(parseCronField("1-5", 0, 59)).toEqual([1, 2, 3, 4, 5]);
    });

    test("comma separated", () => {
      expect(parseCronField("1,3,5", 0, 59)).toEqual([1, 3, 5]);
    });

    test("step values", () => {
      expect(parseCronField("*/15", 0, 59)).toEqual([0, 15, 30, 45]);
    });

    test("range with step", () => {
      expect(parseCronField("0-30/10", 0, 59)).toEqual([0, 10, 20, 30]);
    });

    test("rejects out of range values", () => {
      expect(parseCronField("60", 0, 59)).toBeNull();
    });

    test("rejects invalid range", () => {
      expect(parseCronField("5-3", 0, 59)).toBeNull();
    });
  });

  describe("parseCron", () => {
    test("parses every minute", () => {
      const result = parseCron("* * * * *");
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(5);
      expect(result![0]).toHaveLength(60);
    });

    test("parses specific time", () => {
      const result = parseCron("30 9 * * 1-5");
      expect(result).not.toBeNull();
      expect(result![0]).toEqual([30]);
      expect(result![1]).toEqual([9]);
      expect(result![4]).toEqual([1, 2, 3, 4, 5]);
    });

    test("rejects invalid expression", () => {
      expect(parseCron("* * *")).toBeNull();
    });

    test("rejects invalid field", () => {
      expect(parseCron("60 * * * *")).toBeNull();
    });
  });

  describe("matchesCron", () => {
    test("matches every minute", () => {
      const date = new Date(2024, 0, 15, 10, 30);
      expect(matchesCron("* * * * *", date)).toBe(true);
    });

    test("matches specific minute and hour", () => {
      const date = new Date(2024, 0, 15, 9, 30);
      expect(matchesCron("30 9 * * *", date)).toBe(true);
    });

    test("does not match wrong minute", () => {
      const date = new Date(2024, 0, 15, 9, 15);
      expect(matchesCron("30 9 * * *", date)).toBe(false);
    });

    test("matches day of week", () => {
      const monday = new Date(2024, 0, 15, 9, 30); // Jan 15 2024 is Monday
      expect(matchesCron("30 9 * * 1", monday)).toBe(true);
      expect(matchesCron("30 9 * * 0", monday)).toBe(false);
    });

    test("matches with step", () => {
      const date = new Date(2024, 0, 15, 10, 0);
      expect(matchesCron("*/15 * * * *", date)).toBe(true);

      const date2 = new Date(2024, 0, 15, 10, 7);
      expect(matchesCron("*/15 * * * *", date2)).toBe(false);
    });
  });
});
