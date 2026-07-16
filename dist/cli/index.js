#!/usr/bin/env node
// ============================================================
// PulseCLI — src/cli/index.ts
// Entry point. Commander program setup, global options, ctx construction.
// ============================================================
import { execSync } from "node:child_process";
import { Command } from "commander";
import { loadConfig } from "../core/config.js";
import { PulseClient } from "../core/client.js";
import { setJsonMode } from "./output.js";
import { printError } from "./output.js";
import { register as registerAuth } from "./commands/auth.js";
import { register as registerIssues } from "./commands/issues.js";
import { register as registerLookups } from "./commands/lookups.js";
import { register as registerAttachments } from "./commands/attachments.js";
import { register as registerLinks } from "./commands/links.js";
import { register as registerComments } from "./commands/comments.js";
import { register as registerCodeRefs } from "./commands/code-refs.js";
import { register as registerMcp } from "./commands/mcp.js";
// ---- UTF-8 console (Windows) ----
// Node already writes UTF-8, but a legacy Windows console code page (e.g. 437 or
// 1252) renders it as mojibake (em-dashes/accents in issue data show as "â€"").
// The console code page is shared with child processes, so `chcp 65001` here
// switches the attached console to UTF-8 for our subsequent output. Gated to an
// interactive TTY so piped/`--json` output (the agent path) is never touched.
// CLI-side only — must never run under the MCP server (src/mcp/), which speaks
// JSON-RPC over stdio.
if (process.platform === "win32" && process.stdout.isTTY) {
    try {
        execSync("chcp 65001", { stdio: "ignore" });
    }
    catch {
        /* best-effort — non-fatal if chcp is unavailable */
    }
}
// ---- Program setup ----
const program = new Command();
program
    .name("pulse")
    .description("Atlas Pulse CLI — scriptable task tracker interface")
    .version("0.4.1", "-v, --version")
    .helpOption("-h, --help", "Display help")
    // Global options — available to every subcommand via optsWithGlobals()
    .option("-j, --json", "Output raw JSON (for agent/script consumers)", false)
    .option("--base <url>", "Override Pulse base URL for this invocation");
// Print help when no subcommand is provided
program.addHelpCommand(false);
// ---- Shared, lazily-populated context ----
// IMPORTANT: global options (--json, --base) are NOT known until commander has
// parsed argv. So we expose a single mutable `ctx` object that command
// registrars capture by reference at registration time, and a `preAction` hook
// fills it in right before the invoked command's action runs. Reading
// program.opts() before parseAsync() would always yield defaults.
const ctx = { client: undefined, json: false };
program.hook("preAction", (thisCommand, actionCommand) => {
    // optsWithGlobals merges root (global) options with the action command's own
    const opts = actionCommand.optsWithGlobals();
    const cfg = loadConfig();
    const overrideBase = opts.base;
    if (overrideBase) {
        cfg.baseUrl = overrideBase;
    }
    // Under a --base override, keep the session ephemeral: don't persist cookies
    // or clobber the stored baseUrl on disk.
    ctx.client = new PulseClient(cfg, { persist: !overrideBase });
    ctx.json = Boolean(opts.json);
    setJsonMode(ctx.json);
});
// ============================================================
// Register command groups. Each registrar attaches subcommands whose actions
// close over the shared `ctx` (populated by the preAction hook above before
// any action executes).
// ============================================================
// Register command groups
registerAuth(program, ctx);
registerIssues(program, ctx);
registerLookups(program, ctx);
registerAttachments(program, ctx);
registerLinks(program, ctx);
registerComments(program, ctx);
registerCodeRefs(program, ctx);
registerMcp(program, ctx);
// ---- Parse and dispatch ----
try {
    await program.parseAsync(process.argv);
}
catch (err) {
    printError(err);
}
