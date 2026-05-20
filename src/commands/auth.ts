// ============================================================
// PulseCLI — src/commands/auth.ts
// Commands: login, logout, whoami, config get, config set-url
// ============================================================

import { Command } from "commander";
import * as readline from "node:readline";
import { Writable } from "node:stream";
import { login, getSession } from "../auth-flow.js";
import { clearSession, setBaseUrl, loadConfig } from "../config.js";
import { printJson, printTable, ok, info } from "../output.js";
import type { CliContext } from "../index.js";

// ---- Readline helpers ----

/** Prompt for visible input via readline. */
function promptVisible(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for hidden (password) input.
 * Mutes stdout output during typing by using a no-op Writable as the rl output.
 * Restores newline after the user presses Enter.
 * Falls back to visible input when stdin is not a TTY (pipe/CI).
 */
function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Non-interactive: read from pipe visibly
    return promptVisible(question);
  }
  return new Promise((resolve) => {
    process.stdout.write(question);

    // Muted writable: accepts writes but prints nothing
    const muted = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    });

    rl.once("line", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

// ---- Registrar ----

export function register(program: Command, ctx: CliContext): void {
  // ---- pulse login ----
  program
    .command("login")
    .description("Log in to Atlas Pulse")
    .option("--email <email>", "Email address (or set PULSE_EMAIL env var)")
    .option("--password <password>", "Password (or set PULSE_PASSWORD env var)")
    .action(async (opts: { email?: string; password?: string }) => {
      let email = opts.email ?? process.env.PULSE_EMAIL ?? "";
      let password = opts.password ?? process.env.PULSE_PASSWORD ?? "";

      if (!email) {
        email = await promptVisible("Email: ");
      }
      if (!password) {
        password = await promptHidden("Password: ");
      }

      const user = await login(ctx.client, email.trim(), password.trim());

      if (ctx.json) {
        printJson({ ok: true, user });
      } else {
        ok(`Logged in as ${user.name} (${user.email})`);
      }
    });

  // ---- pulse logout ----
  program
    .command("logout")
    .description("Clear local session cookies")
    .action(async () => {
      clearSession();
      if (ctx.json) {
        printJson({ ok: true });
      } else {
        ok("Logged out.");
      }
    });

  // ---- pulse whoami ----
  program
    .command("whoami")
    .description("Show the currently logged-in user")
    .action(async () => {
      const user = await getSession(ctx.client);
      if (user) {
        if (ctx.json) {
          printJson({ user });
        } else {
          printTable(
            [
              {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
              },
            ],
            [
              { key: "id", header: "ID" },
              { key: "name", header: "Name" },
              { key: "email", header: "Email" },
              { key: "role", header: "Role" },
            ],
          );
        }
      } else {
        if (ctx.json) {
          printJson({ user: null });
        } else {
          ok("Not logged in.");
        }
      }
    });

  // ---- pulse config ----
  const configCmd = program
    .command("config")
    .description("Manage CLI configuration");

  configCmd
    .command("get")
    .description("Show current base URL and login status")
    .action(async () => {
      const cfg = loadConfig();
      const loggedIn = Boolean(cfg.user);
      if (ctx.json) {
        printJson({ baseUrl: cfg.baseUrl, loggedIn, user: cfg.user ?? null });
      } else {
        info(`Base URL : ${cfg.baseUrl}`);
        if (loggedIn) {
          info(`Logged in: yes (${cfg.user!.name} — ${cfg.user!.email})`);
        } else {
          info("Logged in: no");
        }
      }
    });

  configCmd
    .command("set-url <url>")
    .description("Persist a new Pulse base URL to ~/.pulse-cli/config.json")
    .action(async (url: string) => {
      setBaseUrl(url);
      if (ctx.json) {
        printJson({ ok: true, baseUrl: url });
      } else {
        ok(`Base URL set to ${url}`);
      }
    });
}
