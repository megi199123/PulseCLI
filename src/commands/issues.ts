// ============================================================
// PulseCLI — src/commands/issues.ts
// Commands:
//   pulse issues list     — filtered issue list
//   pulse issue view      — detail view
//   pulse issue create    — create a new issue
//   pulse issue edit      — update an existing issue
//   pulse issue delete    — delete an issue (with confirm)
// ============================================================

import fs from "node:fs";
import * as readline from "node:readline";
import { Command } from "commander";
import { printJson, printTable, ok, info } from "../output.js";
import { truncate, formatDate, parseDueDate } from "../util.js";
import { resolveUserId, resolveLabelId } from "./lookups.js";
import type { CliContext } from "../index.js";
import type {
  IssueListItem,
  IssueDetail,
  Category,
} from "../types.js";

// ---- Readline confirm helper ----

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

// ---- Human-readable file size ----

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- Registrar ----

export function register(program: Command, ctx: CliContext): void {
  // ===========================================================
  // pulse issues list
  // ===========================================================
  const issuesCmd = program
    .command("issues")
    .description("Issue list commands");

  issuesCmd
    .command("list")
    .description("List issues with optional filters")
    .option("--category <category>", "Filter by category (TASK|BUG)")
    .option("--priority <priority>", "Filter by priority (LOW|MEDIUM|HIGH|CRITICAL)")
    .option("--status <status>", "Filter by status (OPEN|IN_PROGRESS|STAGING|RESOLVED|CLOSED)")
    .option("--module <module>", "Filter by module")
    .option("--assignee <id>", "Filter by assignee id or name")
    .option("--reporter <id>", "Filter by reporter id or name")
    .option("--search <text>", "Full-text search")
    .option("--label <id>", "Filter by label id or name")
    .option("--milestone <id>", "Filter by milestone id")
    .option("--sprint <id>", "Filter by sprint id")
    .option("--limit <n>", "Maximum number of results", parseInt)
    .option("--overdue", "Show only overdue issues")
    .option("--stale", "Show only stale issues")
    .option("--has-attachments", "Only issues with attachments")
    .option("--has-comments", "Only issues with comments")
    .option("--has-links", "Only issues with links")
    .option("--unassigned", "Only unassigned issues (assigneeId=null)")
    .option("--sprint-none", "Only issues without a sprint (sprintId=null)")
    .action(
      async (opts: {
        category?: string;
        priority?: string;
        status?: string;
        module?: string;
        assignee?: string;
        reporter?: string;
        search?: string;
        label?: string;
        milestone?: string;
        sprint?: string;
        limit?: number;
        overdue?: boolean;
        stale?: boolean;
        hasAttachments?: boolean;
        hasComments?: boolean;
        hasLinks?: boolean;
        unassigned?: boolean;
        sprintNone?: boolean;
      }) => {
        // Resolve name→id for assignee/reporter/label
        let assigneeId: string | "null" | undefined;
        if (opts.unassigned) {
          assigneeId = "null";
        } else if (opts.assignee) {
          assigneeId = await resolveUserId(ctx.client, opts.assignee);
        }

        let reporterId: string | undefined;
        if (opts.reporter) {
          reporterId = await resolveUserId(ctx.client, opts.reporter);
        }

        let labelId: string | undefined;
        if (opts.label) {
          labelId = await resolveLabelId(ctx.client, opts.label);
        }

        let sprintId: string | "null" | undefined;
        if (opts.sprintNone) {
          sprintId = "null";
        } else if (opts.sprint) {
          sprintId = opts.sprint;
        }

        const query: Record<string, string | number | boolean | undefined | null> = {
          category: opts.category,
          status: opts.status,
          priority: opts.priority,
          module: opts.module,
          assigneeId,
          reporterId,
          search: opts.search,
          milestoneId: opts.milestone,
          sprintId,
          labelId,
          limit: opts.limit,
          overdue: opts.overdue ? true : undefined,
          stale: opts.stale ? true : undefined,
          hasAttachments: opts.hasAttachments ? true : undefined,
          hasComments: opts.hasComments ? true : undefined,
          hasLinks: opts.hasLinks ? true : undefined,
        };

        const issues = await ctx.client.get<IssueListItem[]>("/api/issues", query);

        if (ctx.json) {
          printJson(issues);
        } else {
          printTable(
            issues.map((i) => ({
              key: i.key,
              status: i.status,
              priority: i.priority,
              category: i.category,
              module: i.module ?? "",
              title: truncate(i.title, 40),
              assignee: i.assignee?.name ?? "—",
              att: i._count.attachments,
              cmt: i._count.comments,
              links: i._count.linkedIssues,
            })),
            [
              { key: "key", header: "Key" },
              { key: "status", header: "Status" },
              { key: "priority", header: "Priority" },
              { key: "category", header: "Category" },
              { key: "module", header: "Module" },
              { key: "title", header: "Title", width: 40 },
              { key: "assignee", header: "Assignee" },
              { key: "att", header: "Att" },
              { key: "cmt", header: "Cmt" },
              { key: "links", header: "Links" },
            ],
          );
        }
      },
    );

  // ===========================================================
  // pulse issue <subcommand>
  // ===========================================================
  const issueCmd = program
    .command("issue")
    .description("Issue operations (view, create, edit, delete)");

  // ---- pulse issue view <keyOrId> ----
  issueCmd
    .command("view <keyOrId>")
    .description("Show full details for an issue")
    .action(async (ref: string) => {
      const detail = await ctx.client.get<IssueDetail>(`/api/issues/${encodeURIComponent(ref)}`);

      if (ctx.json) {
        printJson(detail);
        return;
      }

      // Header block
      const lines: string[] = [
        `Key       : ${detail.key}`,
        `Title     : ${detail.title}`,
        `Status    : ${detail.status}   Priority: ${detail.priority}   Category: ${detail.category}`,
        `Module    : ${detail.module ?? "—"}`,
        `Reporter  : ${detail.reporter ? `${detail.reporter.name} (${detail.reporter.email})` : "—"}`,
        `Assignee  : ${detail.assignee ? `${detail.assignee.name} (${detail.assignee.email})` : "—"}`,
        `Created   : ${formatDate(detail.createdAt)}   Updated: ${formatDate(detail.updatedAt)}`,
        `Due       : ${formatDate(detail.dueDate)}`,
        `Milestone : ${detail.milestone?.name ?? "—"}`,
        `Sprint    : ${detail.sprint?.name ?? "—"}`,
        `Labels    : ${detail.labels.length > 0 ? detail.labels.map((l) => l.name).join(", ") : "—"}`,
      ];
      console.log(lines.join("\n"));
      console.log("");

      // Description
      if (detail.description) {
        console.log("Description:");
        console.log(stripHtmlSimple(detail.description));
        console.log("");
      }

      // Attachments
      if (detail.attachments.length > 0) {
        console.log("Attachments:");
        printTable(
          detail.attachments.map((a) => ({
            id: a.id,
            name: a.originalName,
            size: humanSize(a.size),
            created: formatDate(a.createdAt),
          })),
          [
            { key: "id", header: "ID" },
            { key: "name", header: "Name" },
            { key: "size", header: "Size" },
            { key: "created", header: "Created" },
          ],
        );
        console.log("");
      }

      // Links
      if (detail.links.length > 0) {
        console.log("Links:");
        printTable(
          detail.links.map((l) => ({
            type: l.type,
            dir: l.direction,
            title: truncate(l.otherIssue.title, 40),
            status: l.otherIssue.status,
            id: l.otherIssue.id,
          })),
          [
            { key: "type", header: "Type" },
            { key: "dir", header: "Dir" },
            { key: "title", header: "Other Issue", width: 40 },
            { key: "status", header: "Status" },
            { key: "id", header: "ID" },
          ],
        );
        console.log("");
      }

      // Comments
      if (detail.comments.length > 0) {
        console.log("Comments:");
        printTable(
          detail.comments.map((c) => ({
            author: c.author.name,
            date: formatDate(c.createdAt),
            comment: truncate(stripHtmlSimple(c.content), 60),
          })),
          [
            { key: "author", header: "Author" },
            { key: "date", header: "Date" },
            { key: "comment", header: "Comment", width: 60 },
          ],
        );
        console.log("");
      }

      // Activity (last 10)
      const activity = detail.activity.slice(-10);
      if (activity.length > 0) {
        console.log("Recent Activity:");
        printTable(
          activity.map((a) => ({
            date: formatDate(a.createdAt),
            kind: a.kind,
            change: a.oldValue != null || a.newValue != null
              ? `${a.oldValue ?? "—"} → ${a.newValue ?? "—"}`
              : "",
            actor: a.actor?.name ?? "—",
          })),
          [
            { key: "date", header: "Date" },
            { key: "kind", header: "Kind" },
            { key: "change", header: "Change" },
            { key: "actor", header: "Actor" },
          ],
        );
      }
    });

  // ---- pulse issue create ----
  issueCmd
    .command("create")
    .description("Create a new issue")
    .requiredOption("--title <title>", "Issue title")
    .option("--description <text>", "Issue description (body text)")
    .option("--description-file <path>", "Read description from a file")
    .requiredOption("--category <category>", "Category: TASK or BUG")
    .option("--priority <priority>", "Priority: LOW|MEDIUM|HIGH|CRITICAL")
    .option("--module <module>", "Module enum value")
    .option("--assignee <id>", "Assignee user id or name")
    .option("--milestone <id>", "Milestone id")
    .option("--sprint <id>", "Sprint id")
    .option("--due <date>", "Due date (YYYY-MM-DD or ISO)")
    .option("--label <id...>", "Label id(s) or name(s) — repeatable")
    .action(
      async (opts: {
        title: string;
        description?: string;
        descriptionFile?: string;
        category: string;
        priority?: string;
        module?: string;
        assignee?: string;
        milestone?: string;
        sprint?: string;
        due?: string;
        label?: string[];
      }) => {
        // Validate category
        const category = opts.category.toUpperCase() as Category;
        if (category !== "TASK" && category !== "BUG") {
          throw new Error(`Invalid category "${opts.category}". Must be TASK or BUG.`);
        }

        // Resolve description
        let description: string;
        if (opts.descriptionFile) {
          description = fs.readFileSync(opts.descriptionFile, "utf-8");
        } else if (opts.description) {
          description = opts.description;
        } else {
          throw new Error("One of --description or --description-file is required.");
        }

        // Resolve optional fields
        const assigneeId = opts.assignee
          ? await resolveUserId(ctx.client, opts.assignee)
          : undefined;

        const labelIds = opts.label && opts.label.length > 0
          ? await Promise.all(opts.label.map((l) => resolveLabelId(ctx.client, l)))
          : undefined;

        const dueDate = opts.due ? parseDueDate(opts.due) || undefined : undefined;

        const body: Record<string, unknown> = {
          title: opts.title,
          description,
          category,
        };
        if (opts.priority) body.priority = opts.priority.toUpperCase();
        if (opts.module) body.module = opts.module.toUpperCase();
        if (assigneeId) body.assigneeId = assigneeId;
        if (opts.milestone) body.milestoneId = opts.milestone;
        if (opts.sprint) body.sprintId = opts.sprint;
        if (dueDate) body.dueDate = dueDate;
        if (labelIds) body.labelIds = labelIds;

        const created = await ctx.client.post<IssueDetail>("/api/issues", body);

        if (ctx.json) {
          printJson(created);
        } else {
          ok(`Created ${created.key}`);
        }
      },
    );

  // ---- pulse issue edit <keyOrId> ----
  issueCmd
    .command("edit <keyOrId>")
    .description("Update an existing issue")
    .option("--title <title>", "New title")
    .option("--description <text>", "New description")
    .option("--description-file <path>", "Read new description from a file")
    .option("--category <category>", "Category: TASK or BUG")
    .option("--status <status>", "Status (OPEN|IN_PROGRESS|STAGING|RESOLVED|CLOSED)")
    .option("--priority <priority>", "Priority (LOW|MEDIUM|HIGH|CRITICAL)")
    .option("--module <module>", "Module (empty string to clear)")
    .option("--assignee <id>", "Assignee id or name (empty string to unassign)")
    .option("--milestone <id>", "Milestone id (empty string to clear)")
    .option("--sprint <id>", "Sprint id (empty string to clear)")
    .option("--due <date>", "Due date YYYY-MM-DD or ISO (empty string to clear)")
    .action(
      async (
        ref: string,
        opts: {
          title?: string;
          description?: string;
          descriptionFile?: string;
          category?: string;
          status?: string;
          priority?: string;
          module?: string;
          assignee?: string;
          milestone?: string;
          sprint?: string;
          due?: string;
        },
      ) => {
        const body: Record<string, unknown> = {};

        if (opts.title !== undefined) body.title = opts.title;

        // Description (file takes precedence)
        if (opts.descriptionFile !== undefined) {
          body.description = fs.readFileSync(opts.descriptionFile, "utf-8");
        } else if (opts.description !== undefined) {
          body.description = opts.description;
        }

        if (opts.category !== undefined) body.category = opts.category.toUpperCase();
        if (opts.status !== undefined) body.status = opts.status.toUpperCase();
        if (opts.priority !== undefined) body.priority = opts.priority.toUpperCase();

        // Nullable fields: empty string → null
        if (opts.module !== undefined) {
          body.module = opts.module === "" ? null : opts.module.toUpperCase();
        }
        if (opts.assignee !== undefined) {
          if (opts.assignee === "") {
            body.assigneeId = null;
          } else {
            body.assigneeId = await resolveUserId(ctx.client, opts.assignee);
          }
        }
        if (opts.milestone !== undefined) {
          body.milestoneId = opts.milestone === "" ? null : opts.milestone;
        }
        if (opts.sprint !== undefined) {
          body.sprintId = opts.sprint === "" ? null : opts.sprint;
        }
        if (opts.due !== undefined) {
          if (opts.due === "") {
            body.dueDate = null;
          } else {
            body.dueDate = parseDueDate(opts.due) || null;
          }
        }

        if (Object.keys(body).length === 0) {
          throw new Error("No fields specified to update. Use at least one option.");
        }

        const updated = await ctx.client.put<IssueDetail>(
          `/api/issues/${encodeURIComponent(ref)}`,
          body,
        );

        if (ctx.json) {
          printJson(updated);
        } else {
          ok(`Updated ${ref}`);
        }
      },
    );

  // ---- pulse issue delete <keyOrId> ----
  issueCmd
    .command("delete <keyOrId>")
    .description("Delete an issue (irreversible)")
    .option("--yes", "Skip confirmation prompt")
    .action(async (ref: string, opts: { yes?: boolean }) => {
      if (ctx.json && !opts.yes) {
        throw new Error("Refusing to delete without --yes in --json mode");
      }

      if (!opts.yes && !ctx.json) {
        const confirmed = await promptConfirm(`Delete issue ${ref}?`);
        if (!confirmed) {
          info("Aborted.");
          return;
        }
      }

      const result = await ctx.client.del<{ message: string }>(
        `/api/issues/${encodeURIComponent(ref)}`,
      );

      if (ctx.json) {
        printJson({ ok: true, message: result.message });
      } else {
        ok(`Deleted ${ref}`);
      }
    });
}

// ---- Internal helper ----

/** Strip HTML tags for display (mirrors util.stripHtml but local to avoid circular deps) */
function stripHtmlSimple(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
