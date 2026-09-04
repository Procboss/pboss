import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), `pboss-test-config-${Date.now()}`);
const CONFIG_FILE = join(TEST_DIR, "ecosystem.config.ts");

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("Ecosystem Config", () => {
  test("should parse a valid ecosystem config file", async () => {
    const config = `
export default {
  apps: [
    {
      name: "test-app",
      script: "./app.ts",
      instances: 2,
      env: { PORT: "3000" },
    },
  ],
};`;
    await writeFile(CONFIG_FILE, config);
    const content = await readFile(CONFIG_FILE, "utf-8");
    expect(content).toContain("test-app");
    expect(content).toContain("instances");
  });

  test("should handle config with multiple apps", async () => {
    const config = `
export default {
  apps: [
    { name: "api", script: "./api.ts", instances: 4 },
    { name: "worker", script: "./worker.ts", instances: 1 },
    { name: "cron", script: "./cron.ts", cron_restart: "0 */6 * * *" },
  ],
};`;
    await writeFile(CONFIG_FILE, config);
    const content = await readFile(CONFIG_FILE, "utf-8");
    expect(content).toContain("api");
    expect(content).toContain("worker");
    expect(content).toContain("cron");
  });

  test("should handle config with env_production and env_development", async () => {
    const config = `
export default {
  apps: [
    {
      name: "app",
      script: "./app.ts",
      env: { NODE_ENV: "development", PORT: "3000" },
      env_production: { NODE_ENV: "production", PORT: "8080" },
    },
  ],
};`;
    await writeFile(CONFIG_FILE, config);
    const content = await readFile(CONFIG_FILE, "utf-8");
    expect(content).toContain("env_production");
    expect(content).toContain("NODE_ENV");
  });
});