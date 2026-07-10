// ============================================================
// PulseCLI — src/cli/commands/comments.ts
// Commands:
//   pulse comment list <issueKeyOrId>           — list comments for an issue
//   pulse comment add <issueKeyOrId> [text]     — add a comment (text or --file)
// ============================================================

import fs from "node:fs";
import { Command } from "commander";
import { printJson, printTable, ok, info } from "../output.js";
import { formatDate, truncate, stripHtml, resolveIssueId } from "../../core/util.js";
import type { CliContext } from "../../core/context.js";
import type { Comment, IssueDetail } from "../../core/types.js";

// ---- Registrar ----

export function register(program: Command, ctx: CliContext): void {
  const commentCmd = program
    .command("comment")
    .description("Comment operations (list, add)");

  // ===========================================================
  // pulse comment list <issueKeyOrId>
  // ===========================================================
  commentCmd
    .command("list <issueKeyOrId>")
    .description("List comments for an issue")
    .action(async (ref: string) => {
      const detail = await ctx.client.get<IssueDetail>(
        `/api/issues/${encodeURIComponent(ref)}`,
      );
      const comments = detail.comments;

      if (ctx.json) {
        printJson(comments);
      } else {
        if (comments.length === 0) {
          info("No comments.");
          return;
        }
        printTable(
          comments.map((c) => ({
            author: c.author.name,
            date: formatDate(c.createdAt),
            comment: truncate(stripHtml(c.content), 60),
          })),
          [
            { key: "author", header: "Author" },
            { key: "date", header: "Date" },
            { key: "comment", header: "Comment", width: 60 },
          ],
        );
      }
    });

  // ===========================================================
  // pulse comment add <issueKeyOrId> [text] [--file <path>]
  // ===========================================================
  commentCmd
    .command("add <issueKeyOrId> [text]")
    .description("Add a comment to an issue (supply text inline or via --file)")
    .option("--file <path>", "Read comment content from a file")
    .action(
      async (
        ref: string,
        text: string | undefined,
        opts: { file?: string },
      ) => {
        // Resolve content — --file takes precedence over positional text
        let content: string;
        if (opts.file) {
          if (!fs.existsSync(opts.file)) {
            throw new Error(`File not found: ${opts.file}`);
          }
          content = fs.readFileSync(opts.file, "utf-8");
        } else if (text) {
          content = text;
        } else {
          throw new Error(
            "Comment content is required — supply inline text or use --file <path>.",
          );
        }

        // Resolve issue ref → cuid id
        const ticketId = await resolveIssueId(ctx.client, ref);

        const comment = await ctx.client.post<Comment>("/api/comments", {
          ticketId,
          content,
        });

        if (ctx.json) {
          printJson(comment);
        } else {
          ok(`Comment added to ${ref}`);
        }
      },
    );
}
