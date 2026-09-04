import { describe, test, expect } from "bun:test";

interface ProcessMetrics {
  name: string;
  pid: number;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
  status: string;
  timestamp: number;
}

function formatPrometheusMetric(
  name: string,
  value: number,
  labels: Record<string, string> = {}
): string {
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  return labelStr
    ? `${name}{${labelStr}} ${value}`
    : `${name} ${value}`;
}

function generatePrometheusOutput(processes: ProcessMetrics[]): string {
  const lines: string[] = [];

  lines.push("# HELP pboss_process_cpu CPU usage percentage");
  lines.push("# TYPE pboss_process_cpu gauge");
  lines.push("# HELP pboss_process_memory Memory usage in bytes");
  lines.push("# TYPE pboss_process_memory gauge");
  lines.push("# HELP pboss_process_uptime Process uptime in seconds");
  lines.push("# TYPE pboss_process_uptime gauge");
  lines.push("# HELP pboss_process_restarts Total restart count");
  lines.push("# TYPE pboss_process_restarts counter");
  lines.push("# HELP pboss_process_status Process status (1=online, 0=offline)");
  lines.push("# TYPE pboss_process_status gauge");

  for (const proc of processes) {
    const labels = { name: proc.name, pid: String(proc.pid) };
    lines.push(formatPrometheusMetric("pboss_process_cpu", proc.cpu, labels));
    lines.push(formatPrometheusMetric("pboss_process_memory", proc.memory, labels));
    lines.push(formatPrometheusMetric("pboss_process_uptime", proc.uptime, labels));
    lines.push(formatPrometheusMetric("pboss_process_restarts", proc.restarts, labels));
    lines.push(
      formatPrometheusMetric(
        "pboss_process_status",
        proc.status === "online" ? 1 : 0,
        labels
      )
    );
  }

  return lines.join("\n");
}

describe("Prometheus Metric Formatting", () => {
  test("should format metric without labels", () => {
    const result = formatPrometheusMetric("pboss_total_processes", 5);
    expect(result).toBe("pboss_total_processes 5");
  });

  test("should format metric with labels", () => {
    const result = formatPrometheusMetric("pboss_process_cpu", 25.5, {
      name: "api",
      pid: "1234",
    });
    expect(result).toBe('pboss_process_cpu{name="api",pid="1234"} 25.5');
  });

  test("should handle zero values", () => {
    const result = formatPrometheusMetric("pboss_process_restarts", 0, {
      name: "app",
    });
    expect(result).toBe('pboss_process_restarts{name="app"} 0');
  });
});

describe("Prometheus Output Generation", () => {
  test("should generate valid prometheus output for single process", () => {
    const processes: ProcessMetrics[] = [
      {
        name: "api",
        pid: 1234,
        cpu: 12.5,
        memory: 104857600,
        uptime: 3600,
        restarts: 2,
        status: "online",
        timestamp: Date.now(),
      },
    ];

    const output = generatePrometheusOutput(processes);

    expect(output).toContain("# HELP pboss_process_cpu");
    expect(output).toContain("# TYPE pboss_process_cpu gauge");
    expect(output).toContain('pboss_process_cpu{name="api",pid="1234"} 12.5');
    expect(output).toContain('pboss_process_memory{name="api",pid="1234"} 104857600');
    expect(output).toContain('pboss_process_uptime{name="api",pid="1234"} 3600');
    expect(output).toContain('pboss_process_restarts{name="api",pid="1234"} 2');
    expect(output).toContain('pboss_process_status{name="api",pid="1234"} 1');
  });

  test("should output status 0 for offline process", () => {
    const processes: ProcessMetrics[] = [
      {
        name: "worker",
        pid: 5678,
        cpu: 0,
        memory: 0,
        uptime: 0,
        restarts: 5,
        status: "stopped",
        timestamp: Date.now(),
      },
    ];

    const output = generatePrometheusOutput(processes);
    expect(output).toContain('pboss_process_status{name="worker",pid="5678"} 0');
  });

  test("should handle multiple processes", () => {
    const processes: ProcessMetrics[] = [
      {
        name: "api",
        pid: 100,
        cpu: 10,
        memory: 50000000,
        uptime: 1000,
        restarts: 0,
        status: "online",
        timestamp: Date.now(),
      },
      {
        name: "worker",
        pid: 200,
        cpu: 45,
        memory: 200000000,
        uptime: 500,
        restarts: 3,
        status: "online",
        timestamp: Date.now(),
      },
    ];

    const output = generatePrometheusOutput(processes);
    expect(output).toContain('name="api"');
    expect(output).toContain('name="worker"');

    // Count occurrences of the metric names (one per process)
    const cpuMatches = output.match(/pboss_process_cpu\{/g);
    expect(cpuMatches).toHaveLength(2);
  });

  test("should generate empty metrics section for no processes", () => {
    const output = generatePrometheusOutput([]);
    expect(output).toContain("# HELP");
    expect(output).toContain("# TYPE");
    // Should only have header lines, no data lines
    expect(output).not.toContain('name="');
  });
});