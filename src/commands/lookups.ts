// ============================================================
// PulseCLI — src/commands/lookups.ts
// Commands: users list, labels list
// Also exports name→id resolution helpers used by issues.ts
// ============================================================

import { Command } from "commander";
import { printJson, printTable } from "../output.js";
import type { CliContext } from "../index.js";
import type { PulseClient } from "../client.js";
import type { UserLookup, Label } from "../types.js";

// ---- Cuid heuristic ----
// Cuids start with "c" and are ~25 lowercase alphanumeric characters.
// Values containing a space, or not matching this pattern, are treated as names.

function looksLikeCuid(s: string): boolean {
  return /^c[a-z0-9]{20,}$/i.test(s) && !s.includes(" ");
}

// ---- Name→id resolution helpers ----

/**
 * Resolve a user value that may be a cuid OR a display name.
 * - If it already looks like a cuid, returns it as-is.
 * - Otherwise, fetches /api/users and does a case-insensitive exact name match.
 * - Throws if no match or multiple matches.
 */
export async function resolveUserId(
  client: PulseClient,
  value: string,
): Promise<string> {
  if (looksLikeCuid(value)) return value;

  const users = await client.get<UserLookup[]>("/api/users");
  const lower = value.toLowerCase();
  const matches = users.filter((u) => u.name.toLowerCase() === lower);
  if (matches.length === 0) {
    throw new Error(
      `No user found with name "${value}". Use --assignee with a user id or exact display name.`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((u) => `${u.name} (${u.id})`).join(", ");
    throw new Error(
      `Multiple users match name "${value}": ${ids}. Use the cuid id instead.`,
    );
  }
  return matches[0]!.id;
}

/**
 * Resolve a label value that may be a cuid OR a label name.
 * - If it already looks like a cuid, returns it as-is.
 * - Otherwise, fetches /api/labels and does a case-insensitive exact name match.
 * - Throws if no match or multiple matches.
 */
export async function resolveLabelId(
  client: PulseClient,
  value: string,
): Promise<string> {
  if (looksLikeCuid(value)) return value;

  const labels = await client.get<Label[]>("/api/labels");
  const lower = value.toLowerCase();
  const matches = labels.filter((l) => l.name.toLowerCase() === lower);
  if (matches.length === 0) {
    throw new Error(
      `No label found with name "${value}". Use --label with a label id or exact label name.`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((l) => `${l.name} (${l.id})`).join(", ");
    throw new Error(
      `Multiple labels match name "${value}": ${ids}. Use the cuid id instead.`,
    );
  }
  return matches[0]!.id;
}

// ---- Registrar ----

export function register(program: Command, ctx: CliContext): void {
  // ---- pulse users list ----
  const usersCmd = program
    .command("users")
    .description("User lookup commands");

  usersCmd
    .command("list")
    .description("List all users")
    .action(async () => {
      const users = await ctx.client.get<UserLookup[]>("/api/users");
      if (ctx.json) {
        printJson(users);
      } else {
        printTable(
          users.map((u) => ({ id: u.id, name: u.name })),
          [
            { key: "id", header: "ID" },
            { key: "name", header: "Name" },
          ],
        );
      }
    });

  // ---- pulse labels list ----
  const labelsCmd = program
    .command("labels")
    .description("Label lookup commands");

  labelsCmd
    .command("list")
    .description("List all labels")
    .action(async () => {
      const labels = await ctx.client.get<Label[]>("/api/labels");
      if (ctx.json) {
        printJson(labels);
      } else {
        printTable(
          labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
          [
            { key: "id", header: "ID" },
            { key: "name", header: "Name" },
            { key: "color", header: "Color" },
          ],
        );
      }
    });
}
