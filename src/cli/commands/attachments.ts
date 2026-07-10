// ============================================================
// PulseCLI — src/cli/commands/attachments.ts
// Commands:
//   pulse attachment list <issueKeyOrId>    — list attachments for an issue
//   pulse attachment add <issueKeyOrId> <filePath>  — upload a file
//   pulse attachment download <attachmentId> [--out <path>]  — download
//   pulse attachment remove <attachmentId>  — delete (with confirm)
// ============================================================

import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import { Command } from "commander";
import { printJson, printTable, ok, info } from "../output.js";
import { formatDate, resolveIssueId } from "../../core/util.js";
import type { CliContext } from "../../core/context.js";
import type { Attachment, IssueDetail } from "../../core/types.js";

// ---- Constants ----

const ALLOWED_EXTENSIONS = new Set([
  ".txt", ".log", ".ps1", ".py", ".sql", ".md", ".csv", ".pdf",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".rar",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
]);

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// ---- Helpers ----

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ---- Registrar ----

export function register(program: Command, ctx: CliContext): void {
  const attachmentCmd = program
    .command("attachment")
    .description("Attachment operations (list, add, download, remove)");

  // ===========================================================
  // pulse attachment list <issueKeyOrId>
  // ===========================================================
  attachmentCmd
    .command("list <issueKeyOrId>")
    .description("List attachments for an issue")
    .action(async (ref: string) => {
      const detail = await ctx.client.get<IssueDetail>(
        `/api/issues/${encodeURIComponent(ref)}`,
      );
      const attachments = detail.attachments;

      if (ctx.json) {
        printJson(attachments);
      } else {
        if (attachments.length === 0) {
          info("No attachments.");
          return;
        }
        printTable(
          attachments.map((a) => ({
            id: a.id,
            name: a.originalName,
            size: humanSize(a.size),
            type: a.mimeType,
            created: formatDate(a.createdAt),
          })),
          [
            { key: "id", header: "ID" },
            { key: "name", header: "Name" },
            { key: "size", header: "Size" },
            { key: "type", header: "Type" },
            { key: "created", header: "Created" },
          ],
        );
      }
    });

  // ===========================================================
  // pulse attachment add <issueKeyOrId> <filePath>
  // ===========================================================
  attachmentCmd
    .command("add <issueKeyOrId> <filePath>")
    .description("Upload a file as an attachment to an issue")
    .action(async (ref: string, filePath: string) => {
      // Verify file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const ext = path.extname(filePath).toLowerCase();
      const stat = fs.statSync(filePath);

      // Client-side warnings (non-json only) — server is source of truth
      if (!ctx.json) {
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          info(`Warning: extension "${ext}" may not be allowed by the server.`);
        }
        if (stat.size > MAX_SIZE_BYTES) {
          info(
            `Warning: file is ${humanSize(stat.size)}, which exceeds the 10 MB limit. The server may reject it.`,
          );
        }
      }

      // Resolve issue ref → cuid id
      const ticketId = await resolveIssueId(ctx.client, ref);

      const attachment = await ctx.client.uploadFile<Attachment>(
        "/api/attachments",
        filePath,
        { ticketId },
      );

      if (ctx.json) {
        printJson(attachment);
      } else {
        ok(`Uploaded ${attachment.originalName} (id ${attachment.id})`);
      }
    });

  // ===========================================================
  // pulse attachment download <attachmentId> [--out <path>]
  // ===========================================================
  attachmentCmd
    .command("download <attachmentId>")
    .description("Download an attachment by its ID")
    .option("--out <path>", "Destination file path (default: server filename in cwd)")
    .action(async (attachmentId: string, opts: { out?: string }) => {
      const hasExplicitOut = Boolean(opts.out);

      // If --out provided, use it directly. Otherwise, use attachmentId as temp name in cwd.
      const tempPath = hasExplicitOut
        ? opts.out!
        : path.join(process.cwd(), attachmentId);

      const { filename } = await ctx.client.downloadFile(
        `/api/attachments/${attachmentId}?download=1`,
        tempPath,
      );

      // If no --out was given, rename the temp file to the server-reported filename.
      let finalPath = tempPath;
      if (!hasExplicitOut && filename !== attachmentId) {
        const renamedPath = path.join(process.cwd(), filename);
        fs.renameSync(tempPath, renamedPath);
        finalPath = renamedPath;
      }

      if (ctx.json) {
        printJson({ id: attachmentId, file: finalPath, filename });
      } else {
        ok(`Downloaded to ${finalPath}`);
      }
    });

  // ===========================================================
  // pulse attachment remove <attachmentId> [--yes]
  // ===========================================================
  attachmentCmd
    .command("remove <attachmentId>")
    .description("Delete an attachment (irreversible)")
    .option("--yes", "Skip confirmation prompt")
    .action(async (attachmentId: string, opts: { yes?: boolean }) => {
      if (ctx.json && !opts.yes) {
        throw new Error("Refusing to remove without --yes in --json mode");
      }

      if (!opts.yes && !ctx.json) {
        const confirmed = await promptConfirm(
          `Remove attachment ${attachmentId}?`,
        );
        if (!confirmed) {
          info("Aborted.");
          return;
        }
      }

      const result = await ctx.client.del<{ message: string }>(
        `/api/attachments/${attachmentId}`,
      );

      if (ctx.json) {
        printJson({ ok: true, message: result.message });
      } else {
        ok(`Removed attachment ${attachmentId}`);
      }
    });
}
