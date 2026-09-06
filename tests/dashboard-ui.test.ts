// tests/dashboard-ui.test.ts
import { describe, expect, test } from "bun:test";
import { getDashboardHTML } from "../src/dashboard-ui";

const html = getDashboardHTML();

// Extract the inline <script> block from the dashboard HTML.
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

/**
 * Extract the escapeHtml() function from the generated dashboard script
 * and evaluate it so we can unit test its behavior.
 */
function extractEscapeHtml(): (value: unknown) => string {
  const match = script.match(
    /function escapeHtml\(unsafe\)\s*\{[\s\S]*?\n\s*\}/
  );

  if (!match) {
    throw new Error("escapeHtml() not found in dashboard script");
  }

  const factory = new Function(`${match[0]}; return escapeHtml;`);
  return factory() as (value: unknown) => string;
}

describe("Dashboard XSS protection", () => {
  test("includes escapeHtml helper", () => {
    expect(script).toContain("function escapeHtml(unsafe)");

    expect(script).toContain('.replace(/&/g, "&amp;")');
    expect(script).toContain('.replace(/</g, "&lt;")');
    expect(script).toContain('.replace(/>/g, "&gt;")');
    expect(script).toContain('.replace(/"/g, "&quot;")');
    expect(script).toContain(".replace(/'/g, \"&#039;\")");
  });

  test("escapeHtml escapes dangerous values", () => {
    const escapeHtml = extractEscapeHtml();

    // Non-string values should be safely coerced to strings.
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(0)).toBe("0");
    expect(escapeHtml(42)).toBe("42");

    // Basic HTML escaping.
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml(`"`)).toBe("&quot;");
    expect(escapeHtml(`'`)).toBe("&#039;");

    // XSS payloads.
    expect(escapeHtml("<img src=x onerror=alert(1)>")).toBe(
      "&lt;img src=x onerror=alert(1)&gt;"
    );

    expect(escapeHtml(`<script>alert("xss")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
    );

    expect(escapeHtml(`"><svg onload=alert(1)>`)).toBe(
      "&quot;&gt;&lt;svg onload=alert(1)&gt;"
    );
  });

  test("escapes process-controlled values before HTML insertion", () => {
    // Process names and statuses should be escaped before rendering.
    expect(script).toMatch(/escapeHtml\(p\.name/);
    expect(script).toMatch(/escapeHtml\(p\.status/);
  });

  test("does not embed process names inside inline JavaScript handlers", () => {
    // Unsafe old pattern should not exist.
    expect(script).not.toContain("viewLogs(${p.pm_id},'${p.name}')");
    expect(script).not.toContain('viewLogs(${p.pm_id},"${p.name}")');

    // More generic guard against putting p.name into onclick handlers.
    expect(script).not.toMatch(/onclick="[^"]*viewLogs\([^)]*p\.name/);
    expect(script).not.toMatch(
      /onclick="[^"]*viewLogs\([^)]*\$\{p\.name\}/
    );
  });

  test("uses ID-based log button handlers instead of passing names", () => {
    // viewLogs should only need the process ID.
    expect(script).toMatch(/function viewLogs\(id\)/);

    // It should safely coerce the ID to a number.
    expect(script).toContain("Number(id)");
  });

  test("log rendering escapes log lines", () => {
    // Each log line should be escaped before being inserted into HTML.
    expect(script).toMatch(/escapeHtml\(line\)/);
  });

  test("log rendering uses real newline splitting", () => {
    // The generated dashboard script should contain:
    // .split('\n')
    //
    // In this test file, we write it as "\\n" because we are matching
    // a backslash + n in the generated JavaScript source.
    expect(script).toContain(".split('\\n')");
    expect(script).toContain(".join('\\n')");

    // The old buggy version used:
    // .split('n')
    expect(script).not.toContain(".split('n')");
  });
});
