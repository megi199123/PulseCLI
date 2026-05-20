// ============================================================
// PulseCLI — src/config.ts
// Config stored at ~/.pulse-cli/config.json
// ============================================================

import fs from "fs";
import os from "os";
import path from "path";

export interface Config {
  baseUrl: string;
  cookies: Record<string, string>;
  user?: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
}

const CONFIG_DIR = path.join(os.homedir(), ".pulse-cli");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  ensureConfigDir();
  const defaults: Config = {
    baseUrl: process.env.PULSE_BASE_URL ?? "http://localhost:3000",
    cookies: {},
  };
  if (!fs.existsSync(CONFIG_PATH)) {
    return defaults;
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      baseUrl: parsed.baseUrl ?? defaults.baseUrl,
      cookies: parsed.cookies ?? {},
      user: parsed.user,
    };
  } catch {
    return defaults;
  }
}

export function saveConfig(cfg: Config): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

export function setBaseUrl(url: string): void {
  const cfg = loadConfig();
  cfg.baseUrl = url;
  saveConfig(cfg);
}

export function clearSession(): void {
  const cfg = loadConfig();
  cfg.cookies = {};
  delete cfg.user;
  saveConfig(cfg);
}
