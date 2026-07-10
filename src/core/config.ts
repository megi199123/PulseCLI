// ============================================================
// PulseCLI — src/core/config.ts
// Config stored at ~/.pulse-cli/config.json
// ============================================================

import fs from "fs";
import os from "os";
import path from "path";

export interface Config {
  baseUrl: string;
  cookies: Record<string, string>;
  /**
   * Optional bearer token. When set, PulseClient sends
   * `Authorization: Bearer <token>` on every request IN ADDITION TO the
   * cookie header, so a cookie-only Pulse deployment keeps working.
   */
  token?: string;
  user?: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
}

// Config location. Defaults to ~/.pulse-cli, but PULSE_CONFIG_DIR lets a
// deployment keep its own isolated session (base URL + cookies + user) so
// multiple copies — e.g. a local-dev "admin" install and a live "as me"
// install — never share or clobber each other's state.
const CONFIG_DIR = process.env.PULSE_CONFIG_DIR
  ? path.resolve(process.env.PULSE_CONFIG_DIR)
  : path.join(os.homedir(), ".pulse-cli");
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
      token: parsed.token,
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
