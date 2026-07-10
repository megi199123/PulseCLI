// ============================================================
// PulseCLI — src/core/context.ts
// Shared context type passed to command registrars (CLI) and tool
// handlers (MCP). Commander-free, stdout-free.
// ============================================================

import type { PulseClient } from "./client.js";

export interface CliContext {
  client: PulseClient;
  json: boolean;
}
