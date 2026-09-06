import { describe, test, expect } from "bun:test";

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex !== -1) {
        const key = arg.slice(2, eqIndex);
        const value = arg.slice(eqIndex + 1);
        flags[key] = value;
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (i + 1 < argv.length && next && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (i + 1 < argv.length && next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(arg);
    }
  }

  return { flags, args };
}

describe("CLI Argument Parser", () => {
  test("parses long flags with = syntax", () => {
    const result = parseArgs(["--name=myapp", "--instances=4"]);
    expect(result.flags["name"]).toBe("myapp");
    expect(result.flags["instances"]).toBe("4");
    expect(result.args).toEqual([]);
  });

  test("parses long flags with space-separated values", () => {
    const result = parseArgs(["--name", "myapp", "--instances", "4"]);
    expect(result.flags["name"]).toBe("myapp");
    expect(result.flags["instances"]).toBe("4");
    expect(result.args).toEqual([]);
  });

  test("parses boolean flags", () => {
    const result = parseArgs(["--watch", "--force"]);
    expect(result.flags["watch"]).toBe(true);
    expect(result.flags["force"]).toBe(true);
  });

  test("parses short flags with values", () => {
    const result = parseArgs(["-n", "myapp", "-i", "4"]);
    expect(result.flags["n"]).toBe("myapp");
    expect(result.flags["i"]).toBe("4");
  });

  test("parses short boolean flags", () => {
    const result = parseArgs(["-w", "-f"]);
    expect(result.flags["w"]).toBe(true);
    expect(result.flags["f"]).toBe(true);
  });

  test("parses positional arguments", () => {
    const result = parseArgs(["start", "app.js"]);
    expect(result.args).toEqual(["start", "app.js"]);
    expect(Object.keys(result.flags)).toHaveLength(0);
  });

  test("parses mixed flags and positional args", () => {
    const result = parseArgs(["start", "app.js", "--name", "myapp", "-i", "4", "--watch"]);
    expect(result.args).toEqual(["start", "app.js"]);
    expect(result.flags["name"]).toBe("myapp");
    expect(result.flags["i"]).toBe("4");
    expect(result.flags["watch"]).toBe(true);
  });

  test("handles empty argv", () => {
    const result = parseArgs([]);
    expect(result.args).toEqual([]);
    expect(Object.keys(result.flags)).toHaveLength(0);
  });

  test("flag value that starts with - is treated as boolean", () => {
    const result = parseArgs(["--verbose", "--name", "app"]);
    expect(result.flags["verbose"]).toBe(true);
    expect(result.flags["name"]).toBe("app");
  });
});
