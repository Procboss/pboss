/**
 * ProcBoss (pboss) — Bun Process Manager
 * A production-grade process manager for Bun.
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

export class EnvManager {
  private envFile = join(PBOSS_HOME, "env-registry.json");

  async getEnvs(): Promise<Record<string, Record<string, string>>> {
    try {
      const file = Bun.file(this.envFile);
      if (await file.exists()) return await file.json();
    } catch {}
    return {};
  }

  async setEnv(name: string, key: string, value: string): Promise<void> {
    const envs = await this.getEnvs();
    if (!envs[name]) envs[name] = {};
    envs[name][key] = value;
    await Bun.write(this.envFile, JSON.stringify(envs, null, 2));
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
    await Bun.write(this.envFile, JSON.stringify(envs, null, 2));
  }

  async loadDotEnv(filePath: string): Promise<Record<string, string>> {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return {};

    const content = await file.text();
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
