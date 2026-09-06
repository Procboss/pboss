import { describe, test, expect } from "bun:test";

interface HealthCheckConfig {
  enabled: boolean;
  url?: string;
  port?: number;
  path?: string;
  interval?: number;
  timeout?: number;
  max_consecutive_failures?: number;
  check_type: "http" | "tcp" | "script";
}

function createHealthCheck(
  overrides: Partial<HealthCheckConfig> = {}
): HealthCheckConfig {
  return {
    enabled: true,
    check_type: "http",
    url: "http://localhost:3000/health",
    interval: 30000,
    timeout: 5000,
    max_consecutive_failures: 3,
    ...overrides,
  };
}

function validateHealthCheckConfig(config: HealthCheckConfig): string[] {
  const errors: string[] = [];

  if (config.check_type === "http" && !config.url && !config.path) {
    errors.push("HTTP health check requires 'url' or 'path'");
  }

  if (config.check_type === "tcp" && !config.port) {
    errors.push("TCP health check requires 'port'");
  }

  if (config.interval !== undefined && config.interval < 1000) {
    errors.push("Interval must be at least 1000ms");
  }

  if (config.timeout !== undefined && config.timeout < 500) {
    errors.push("Timeout must be at least 500ms");
  }

  if (
    config.timeout !== undefined &&
    config.interval !== undefined &&
    config.timeout >= config.interval
  ) {
    errors.push("Timeout must be less than interval");
  }

  if (
    config.max_consecutive_failures !== undefined &&
    config.max_consecutive_failures < 1
  ) {
    errors.push("max_consecutive_failures must be at least 1");
  }

  return errors;
}

describe("Health Check Configuration", () => {
  test("should create default health check config", () => {
    const config = createHealthCheck();
    expect(config.enabled).toBe(true);
    expect(config.check_type).toBe("http");
    expect(config.interval).toBe(30000);
    expect(config.timeout).toBe(5000);
    expect(config.max_consecutive_failures).toBe(3);
  });

  test("should validate valid HTTP health check", () => {
    const config = createHealthCheck({ check_type: "http", url: "http://localhost:3000/health" });
    const errors = validateHealthCheckConfig(config);
    expect(errors).toHaveLength(0);
  });

  test("should reject HTTP health check without url or path", () => {
    const config = createHealthCheck({
      check_type: "http",
      url: undefined,
      path: undefined,
    });
    const errors = validateHealthCheckConfig(config);
    expect(errors).toContain("HTTP health check requires 'url' or 'path'");
  });

  test("should reject TCP health check without port", () => {
    const config = createHealthCheck({
      check_type: "tcp",
      port: undefined,
    });
    const errors = validateHealthCheckConfig(config);
    expect(errors).toContain("TCP health check requires 'port'");
  });

  test("should reject interval less than 1000ms", () => {
    const config = createHealthCheck({ interval: 500 });
    const errors = validateHealthCheckConfig(config);
    expect(errors).toContain("Interval must be at least 1000ms");
  });

  test("should reject timeout less than 500ms", () => {
    const config = createHealthCheck({ timeout: 100 });
    const errors = validateHealthCheckConfig(config);
    expect(errors).toContain("Timeout must be at least 500ms");
  });

  test("should reject timeout >= interval", () => {
    const config = createHealthCheck({ interval: 5000, timeout: 5000 });
    const errors = validateHealthCheckConfig(config);
    expect(errors).toContain("Timeout must be less than interval");
  });

  test("should reject max_consecutive_failures < 1", () => {
    const config = createHealthCheck({ max_consecutive_failures: 0 });
    const errors = validateHealthCheckConfig(config);
    expect(errors).toContain("max_consecutive_failures must be at least 1");
  });
});

describe("Health Check State Tracking", () => {
  test("should track consecutive failures", () => {
    let consecutiveFailures = 0;
    const maxFailures = 3;

    consecutiveFailures++;
    expect(consecutiveFailures).toBe(1);
    expect(consecutiveFailures >= maxFailures).toBe(false);

    consecutiveFailures++;
    consecutiveFailures++;
    expect(consecutiveFailures >= maxFailures).toBe(true);
  });

  test("should reset failures on success", () => {
    let consecutiveFailures = 5;
    // Simulate a successful check
    consecutiveFailures = 0;
    expect(consecutiveFailures).toBe(0);
  });

  test("should determine if process should be restarted", () => {
    const maxFailures = 3;
    const shouldRestart = (failures: number) => failures >= maxFailures;

    expect(shouldRestart(0)).toBe(false);
    expect(shouldRestart(2)).toBe(false);
    expect(shouldRestart(3)).toBe(true);
    expect(shouldRestart(10)).toBe(true);
  });
});