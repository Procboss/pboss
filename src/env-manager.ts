/**
 * ProcBoss (pboss) — JavaScript & TypeScript Process Manager
 * A production-grade, runtime-agnostic process manager — Bun, Node.js and Deno.
 *
 * Features:
 * - Fork & cluster execution modes
 * - Auto-restart & crash recovery
 * - Health checks & monitoring
 * - Log management & rotation
 * - Deployment support
 *
 * https://procboss.com
 * https://github.com/procboss/pboss
 * License: GPL-3.0-only
 */
 
import { join } from "path";
import { PBOSS_HOME } from "./constants";
import { warn } from "./error-handling";
import { getRuntime } from "./runtime";
const R = getRuntime();

export class EnvManager {
  private envFile = join(PBOSS_HOME, "env-registry.json");

  async getEnvs(): Promise<Record<string, Record<string, string>>> {
    try {
      if (await R.filesystem.exists(this.envFile))
        return (await R.filesystem.readJSON(this.envFile)) as Record<string, Record<string, string>>;
    } catch (err) {
      // A present-but-unreadable registry is a real problem (corrupt JSON,
      // permissions) — the user should see it, not silently lose all envs.
      warn(`read env registry ${this.envFile}`, err);
    }
    return {};
  }

  async setEnv(name: string, key: string, value: string): Promise<void> {
    const envs = await this.getEnvs();
    if (!envs[name]) envs[name] = {};
    envs[name][key] = value;
    await R.filesystem.write(this.envFile, JSON.stringify(envs, null, 2));
  }

  async getEnv(name: string): Promise<Record<string, string>> {
    const envs = await this.getEnvs();
    return envs[name] || {};
  }

  async deleteEnv(name: string, key?: string): Promise<void> {
    const envs = await this.getEnvs();
    if (key) {
      delete envs[name]?.[key];
    } else {
      delete envs[name];
    }
    await R.filesystem.write(this.envFile, JSON.stringify(envs, null, 2));
  }

  async loadDotEnv(filePath: string): Promise<Record<string, string>> {
    if (!(await R.filesystem.exists(filePath))) return {};

    const content = await R.filesystem.readText(filePath);
    const env: Record<string, string> = {};

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let value = trimmed.substring(eqIdx + 1).trim();
      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }

    return env;
  }
}
