// ============================================================
// PulseCLI — src/cli/commands/mcp.ts
// Commands: mcp setup
//
// Interactive one-shot onboarding for the pulse-mcp server: pick the Pulse
// deployment, log in, mint a scoped API token via the cookie session, store
// it in the CLI config (where pulse-mcp finds it), and register the server
// with the Claude Code CLI.
// ============================================================

import { Command } from "commander";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { PulseClient } from "../../core/client.js";
import { loadConfig, saveConfig } from "../../core/config.js";
import { login, getSession } from "../../core/auth-flow.js";
import { mintApiToken } from "../../core/tokens.js";
import type { SessionUser } from "../../core/types.js";
import { printJson, ok, info } from "../output.js";
import { promptVisible, promptHidden, promptConfirm } from "../prompt.js";
import type { CliContext } from "../../core/context.js";

const DEFAULT_LIVE_URL = "https://pulse.example.com";
const REGISTER_COMMAND = "claude mcp add --scope user pulse -- pulse-mcp";

interface SetupOptions {
  url?: string;
  email?: string;
  password?: string;
  tokenName?: string;
  readOnly?: boolean;
  /** commander --no-register → register defaults to true */
  register: boolean;
}

export function register(program: Command, ctx: CliContext): void {
  const mcpCmd = program
    .command("mcp")
    .description("pulse-mcp server helpers");

  mcpCmd
    .command("setup")
    .description(
      "Interactive setup for the pulse-mcp server: log in, mint an API token, " +
        "store it in the CLI config, and register with Claude Code",
    )
    .option("--url <url>", "Pulse base URL (skips the prompt)")
    .option("--email <email>", "Email for login (or set PULSE_EMAIL)")
    .option("--password <password>", "Password for login (or set PULSE_PASSWORD)")
    .option("--token-name <name>", "Name for the minted token (default: pulse-mcp on <hostname>)")
    .option("--read-only", "Mint a read-only token (skip the CODE_REF_WRITE scope)")
    .option("--no-register", "Skip registering the server with the Claude Code CLI")
    .action(async (opts: SetupOptions) => {
      await runSetup(ctx, opts);
    });
}

async function runSetup(ctx: CliContext, opts: SetupOptions): Promise<void> {
  // JSON mode is treated as non-interactive: never prompt, fail fast instead.
  const interactive = process.stdin.isTTY === true && !ctx.json;

  // ---- Step 1: choose the Pulse deployment ----
  const cfg = loadConfig();
  let baseUrl = opts.url;
  if (!baseUrl) {
    // Suggest the stored URL when it points somewhere real; otherwise the
    // live deployment (a teammate running setup for the first time has the
    // localhost default stored, which is almost never what they want).
    const suggested = /localhost|127\.0\.0\.1/.test(cfg.baseUrl)
      ? DEFAULT_LIVE_URL
      : cfg.baseUrl;
    if (interactive) {
      const answer = await promptVisible(`Pulse URL [${suggested}]: `);
      baseUrl = answer.trim() || suggested;
    } else {
      baseUrl = suggested;
    }
  }
  baseUrl = baseUrl.replace(/\/+$/, "");
  cfg.baseUrl = baseUrl;
  saveConfig(cfg);
  info(`Using Pulse at ${baseUrl}`);

  const client = new PulseClient(cfg);

  // ---- Step 2: cookie login (token minting is cookie-session only) ----
  let user: SessionUser | null = null;
  if (!opts.email) {
    user = await getSession(client);
    if (user) {
      info(`Already logged in as ${user.name} (${user.email}).`);
      if (
        interactive &&
        !(await promptConfirm("Mint the MCP token as this user?", true))
      ) {
        user = null;
      }
    }
  }
  if (!user) {
    let email = opts.email ?? process.env.PULSE_EMAIL ?? "";
    let password = opts.password ?? process.env.PULSE_PASSWORD ?? "";
    if (!interactive && (!email || !password)) {
      throw new Error(
        "Not logged in — run `pulse mcp setup` in an interactive terminal, " +
          "or pass --email/--password (or PULSE_EMAIL/PULSE_PASSWORD).",
      );
    }
    if (!email) email = await promptVisible("Email: ");
    if (!password) password = await promptHidden("Password: ");
    user = await login(client, email.trim(), password.trim());
    ok(`Logged in as ${user.name} (${user.email})`);
  }

  // ---- Step 3: decide scopes ----
  // Reads need no scope at all; CODE_REF_WRITE is the one write the MCP
  // server exposes (pulse_add_code_ref) and is a token-only scope every user
  // may grant. Default to granting it — that is the point of the server.
  let grantCodeRefs = !opts.readOnly;
  if (grantCodeRefs && interactive) {
    grantCodeRefs = await promptConfirm(
      "Allow the MCP server to attach PR/commit links to issues (CODE_REF_WRITE scope)?",
      true,
    );
  }
  const scopes = grantCodeRefs ? ["CODE_REF_WRITE"] : [];

  // ---- Step 4: mint the token ----
  const tokenName = opts.tokenName ?? `pulse-mcp on ${os.hostname()}`;
  const minted = await mintApiToken(client, { name: tokenName, scopes });
  ok(
    `Minted API token "${minted.name}" (${minted.tokenPrefix}…) — ` +
      (scopes.length ? `scopes: ${scopes.join(", ")}` : "read-only"),
  );

  // ---- Step 5: store it where pulse-mcp looks ----
  // Reload rather than reusing `cfg`: the login flow persisted fresh cookies
  // through the client, and a stale in-memory copy would clobber them.
  const updated = loadConfig();
  updated.token = minted.token;
  saveConfig(updated);
  info(
    "Token stored in the CLI config — pulse-mcp uses it automatically " +
      "whenever PULSE_TOKEN is not set.",
  );

  // ---- Step 6: verify the bearer path end-to-end ----
  // Fresh client with NO cookies: proves the token alone authenticates,
  // exactly how pulse-mcp will use it on someone else's machine.
  const bearerClient = new PulseClient(
    { baseUrl, cookies: {}, token: minted.token },
    { persist: false },
  );
  const modules = await bearerClient.get<unknown[]>("/api/modules");
  ok(
    `Verified: bearer token works against ${baseUrl} ` +
      `(${modules.length} modules visible).`,
  );

  // ---- Step 7: register with Claude Code ----
  let registered = false;
  if (opts.register) {
    let doRegister = true;
    if (interactive) {
      doRegister = await promptConfirm(
        "Register pulse-mcp with Claude Code now (user scope)?",
        true,
      );
    }
    if (doRegister) registered = registerWithClaude();
  }

  info(
    "Done. Start a NEW Claude Code session (MCP servers spawn at session " +
      "start), then run /mcp to confirm 'pulse' is connected.",
  );

  if (ctx.json) {
    // Deliberately NEVER include the raw token — it is already stored in the
    // config file; echoing it invites pasting into logs/transcripts.
    printJson({
      ok: true,
      baseUrl,
      user: { id: user.id, name: user.name, email: user.email },
      token: {
        id: minted.id,
        name: minted.name,
        tokenPrefix: minted.tokenPrefix,
        scopes: minted.scopes,
      },
      registeredWithClaude: registered,
    });
  }
}

/**
 * Shell out to `claude mcp add`. Best-effort: any failure degrades to
 * printing the manual command, never aborts the wizard (the token work
 * above has already succeeded and is worth keeping).
 */
function registerWithClaude(): boolean {
  const result = spawnSync(REGISTER_COMMAND, {
    shell: true, // resolves claude.cmd / shell shims on Windows
    encoding: "utf-8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (!result.error && result.status === 0) {
    ok("Registered with Claude Code (user scope).");
    return true;
  }

  if (/already exists/i.test(output)) {
    info(
      "A 'pulse' MCP server is already registered with Claude Code — kept as-is.\n" +
        "  If it still uses the old -e PULSE_TOKEN registration, re-add it token-free:\n" +
        `  claude mcp remove pulse -s user && ${REGISTER_COMMAND}`,
    );
    return true;
  }

  info(
    "Could not run the Claude Code CLI (is `claude` on your PATH?). " +
      "Register manually with:\n  " +
      REGISTER_COMMAND,
  );
  return false;
}
