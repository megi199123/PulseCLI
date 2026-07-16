#!/usr/bin/env node
// ============================================================
// PulseCLI — src/mcp/index.ts
// MCP stdio server entry point (`pulse-mcp` bin).
//
// Speaks JSON-RPC over stdio — NEVER write to stdout, here or anywhere under
// src/mcp/. Every diagnostic must go to console.error. Never call
// process.exit() from inside a tool handler (only a fatal startup failure,
// below, may exit).
// ============================================================
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../core/config.js";
import { PulseClient } from "../core/client.js";
import { registerTools } from "./tools.js";
// Mirrors package.json's version (kept in sync manually, same convention as
// the `-v/--version` string hardcoded in src/cli/index.ts, and the
// SERVER_VERSION constant in src/mcp-http/index.ts).
const SERVER_VERSION = "0.4.1";
function buildClient() {
    const config = loadConfig();
    // PULSE_BASE_URL is an explicit override: it wins over whatever baseUrl is
    // stored in the on-disk config, mirroring how the CLI's `--base` flag
    // overrides the stored baseUrl in src/cli/index.ts's preAction hook.
    const baseUrlOverride = process.env.PULSE_BASE_URL;
    if (baseUrlOverride) {
        config.baseUrl = baseUrlOverride;
    }
    // Token resolution order: PULSE_TOKEN env (explicit override) → token
    // stored in the config file by `pulse mcp setup` → cookie-jar fallback.
    const token = process.env.PULSE_TOKEN ?? config.token;
    if (token) {
        // Bearer auth: never touch the cookie jar / config file on disk.
        return new PulseClient({ ...config, token }, { persist: false });
    }
    // No token anywhere — fall back to the cookie-jar session left behind by
    // `pulse login` (~/.pulse-cli or PULSE_CONFIG_DIR). This path DOES persist
    // (refreshed cookies get written back), matching normal CLI behavior.
    console.error("[pulse-mcp] No API token found (PULSE_TOKEN env or config) — falling " +
        "back to the cookie-jar session from `pulse login`. Run `pulse mcp " +
        "setup` to mint + store a token for a dedicated, non-persisting " +
        "bearer session instead.");
    return new PulseClient(config);
}
async function main() {
    const client = buildClient();
    const server = new McpServer({ name: "pulse-mcp", version: SERVER_VERSION });
    registerTools(server, client);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error("[pulse-mcp] fatal error during startup:", err);
    process.exit(1);
});
