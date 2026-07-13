// ============================================================
// PulseCLI — src/cli/commands/issues.ts
// Commands:
//   pulse issues list     — filtered issue list
//   pulse issue view      — detail view
//   pulse issue create    — create a new issue
//   pulse issue edit      — update an existing issue
//   pulse issue delete    — delete an issue (with confirm)
// ============================================================
import fs from "node:fs";
import * as readline from "node:readline";
import { printJson, printTable, ok, info } from "../output.js";
import { truncate, formatDate, parseDueDate } from "../../core/util.js";
import { resolveUserId, resolveLabelId, resolveModuleSlug } from "../../core/lookups.js";
import { formatCodeRefLabel } from "./code-refs.js";
// ---- Readline confirm helper ----
function promptConfirm(question) {
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
function humanSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
// ---- Registrar ----
export function register(program, ctx) {
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
        .option("--status <status>", "Filter by status (BACKLOG|OPEN|IN_PROGRESS|STAGING|IN_REVIEW|RESOLVED|CLOSED)")
        .option("--module <module>", "Filter by module slug (see `pulse modules list`)")
        .option("--assignee <id>", "Filter by assignee id or name")
        .option("--reporter <id>", "Filter by reporter id or name")
        .option("--search <text>", "Full-text search")
        .option("--label <id>", "Filter by label id or name")
        .option("--milestone <id>", "Filter by milestone id (also reveals RELEASED-milestone issues)")
        .option("--sprint <id>", "Filter by sprint id")
        .option("--limit <n>", "Maximum number of results", parseInt)
        .option("--overdue", "Show only overdue issues")
        .option("--stale", "Show only stale issues")
        .option("--has-attachments", "Only issues with attachments")
        .option("--has-comments", "Only issues with comments")
        .option("--has-links", "Only issues with links")
        .option("--unassigned", "Only unassigned issues (assigneeId=null)")
        .option("--sprint-none", "Only issues without a sprint (sprintId=null)")
        .option("--include-released", "Include issues in RELEASED milestones (hidden by default)")
        .action(async (opts) => {
        // Resolve name→id for assignee/reporter/label
        let assigneeId;
        if (opts.unassigned) {
            assigneeId = "null";
        }
        else if (opts.assignee) {
            assigneeId = await resolveUserId(ctx.client, opts.assignee);
        }
        let reporterId;
        if (opts.reporter) {
            reporterId = await resolveUserId(ctx.client, opts.reporter);
        }
        let labelId;
        if (opts.label) {
            labelId = await resolveLabelId(ctx.client, opts.label);
        }
        let sprintId;
        if (opts.sprintNone) {
            sprintId = "null";
        }
        else if (opts.sprint) {
            sprintId = opts.sprint;
        }
        const query = {
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
            includeReleased: opts.includeReleased ? true : undefined,
        };
        const issues = await ctx.client.get("/api/issues", query);
        if (ctx.json) {
            printJson(issues);
        }
        else {
            printTable(issues.map((i) => ({
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
            })), [
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
            ]);
        }
    });
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
        .action(async (ref) => {
        const detail = await ctx.client.get(`/api/issues/${encodeURIComponent(ref)}`);
        if (ctx.json) {
            printJson(detail);
            return;
        }
        // Header block
        const lines = [
            `Key       : ${detail.key}`,
            `Title     : ${detail.title}`,
            `Status    : ${detail.status}   Priority: ${detail.priority}   Category: ${detail.category}`,
            `Module    : ${detail.module ?? "—"}`,
            `Reporter  : ${detail.reporter ? `${detail.reporter.name} (${detail.reporter.email})` : "—"}`,
            `Assignee  : ${detail.assignee ? `${detail.assignee.name} (${detail.assignee.email})` : "—"}`,
            `Created   : ${formatDate(detail.createdAt)}   Updated: ${formatDate(detail.updatedAt)}`,
            `Due       : ${formatDate(detail.dueDate) || "—"}`,
            `Dev       : ${formatDate(detail.devStartDate) || "—"} → ${formatDate(detail.devDueDate) || "—"}`,
            `EUS Test  : ${formatDate(detail.eusStartDate) || "—"} → ${formatDate(detail.eusDueDate) || "—"}`,
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
            printTable(detail.attachments.map((a) => ({
                id: a.id,
                name: a.originalName,
                size: humanSize(a.size),
                created: formatDate(a.createdAt),
            })), [
                { key: "id", header: "ID" },
                { key: "name", header: "Name" },
                { key: "size", header: "Size" },
                { key: "created", header: "Created" },
            ]);
            console.log("");
        }
        // Links
        if (detail.links.length > 0) {
            console.log("Links:");
            printTable(detail.links.map((l) => ({
                type: l.type,
                dir: l.direction,
                title: truncate(l.otherIssue.title, 40),
                status: l.otherIssue.status,
                id: l.otherIssue.id,
            })), [
                { key: "type", header: "Type" },
                { key: "dir", header: "Dir" },
                { key: "title", header: "Other Issue", width: 40 },
                { key: "status", header: "Status" },
                { key: "id", header: "ID" },
            ]);
            console.log("");
        }
        // Code references
        if (detail.codeRefs.length > 0) {
            console.log("Code:");
            printTable(detail.codeRefs.map((c) => ({
                ref: formatCodeRefLabel(c),
                title: truncate(c.title ?? "", 40),
                addedBy: c.addedBy?.name ?? "—",
                created: formatDate(c.createdAt),
            })), [
                { key: "ref", header: "Ref" },
                { key: "title", header: "Title", width: 40 },
                { key: "addedBy", header: "Added By" },
                { key: "created", header: "Created" },
            ]);
            console.log("");
        }
        // Comments
        if (detail.comments.length > 0) {
            console.log("Comments:");
            printTable(detail.comments.map((c) => ({
                author: c.author.name,
                date: formatDate(c.createdAt),
                comment: truncate(stripHtmlSimple(c.content), 60),
            })), [
                { key: "author", header: "Author" },
                { key: "date", header: "Date" },
                { key: "comment", header: "Comment", width: 60 },
            ]);
            console.log("");
        }
        // Activity (last 10)
        const activity = detail.activity.slice(-10);
        if (activity.length > 0) {
            console.log("Recent Activity:");
            printTable(activity.map((a) => ({
                date: formatDate(a.createdAt),
                kind: a.kind,
                change: a.oldValue != null || a.newValue != null
                    ? `${a.oldValue ?? "—"} → ${a.newValue ?? "—"}`
                    : "",
                actor: a.actor?.name ?? "—",
            })), [
                { key: "date", header: "Date" },
                { key: "kind", header: "Kind" },
                { key: "change", header: "Change" },
                { key: "actor", header: "Actor" },
            ]);
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
        .option("--status <status>", "Status (BACKLOG|OPEN|IN_PROGRESS|STAGING|IN_REVIEW|RESOLVED|CLOSED); omitting this yields BACKLOG (the server default, matching the web UI)")
        .option("--priority <priority>", "Priority: LOW|MEDIUM|HIGH|CRITICAL")
        .option("--module <module>", "Module slug (see `pulse modules list`); defaults to the configured default module")
        .option("--assignee <id>", "Assignee user id or name")
        .option("--milestone <id>", "Milestone id")
        .option("--sprint <id>", "Sprint id")
        .option("--due <date>", "Due date (YYYY-MM-DD or ISO)")
        .option("--label <id...>", "Label id(s) or name(s) — repeatable")
        .action(async (opts) => {
        // Validate category
        const category = opts.category.toUpperCase();
        if (category !== "TASK" && category !== "BUG") {
            throw new Error(`Invalid category "${opts.category}". Must be TASK or BUG.`);
        }
        // Resolve description
        let description;
        if (opts.descriptionFile) {
            description = fs.readFileSync(opts.descriptionFile, "utf-8");
        }
        else if (opts.description) {
            description = opts.description;
        }
        else {
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
        const body = {
            title: opts.title,
            description,
            category,
        };
        if (opts.status)
            body.status = opts.status.toUpperCase();
        if (opts.priority)
            body.priority = opts.priority.toUpperCase();
        if (opts.module)
            body.module = await resolveModuleSlug(ctx.client, opts.module);
        if (assigneeId)
            body.assigneeId = assigneeId;
        if (opts.milestone)
            body.milestoneId = opts.milestone;
        if (opts.sprint)
            body.sprintId = opts.sprint;
        if (dueDate)
            body.dueDate = dueDate;
        if (labelIds)
            body.labelIds = labelIds;
        const created = await ctx.client.post("/api/issues", body);
        if (ctx.json) {
            printJson(created);
        }
        else {
            ok(`Created ${created.key}`);
        }
    });
    // ---- pulse issue edit <keyOrId> ----
    issueCmd
        .command("edit <keyOrId>")
        .description("Update an existing issue")
        .option("--title <title>", "New title")
        .option("--description <text>", "New description")
        .option("--description-file <path>", "Read new description from a file")
        .option("--category <category>", "Category: TASK or BUG")
        .option("--status <status>", "Status (BACKLOG|OPEN|IN_PROGRESS|STAGING|IN_REVIEW|RESOLVED|CLOSED)")
        .option("--priority <priority>", "Priority (LOW|MEDIUM|HIGH|CRITICAL)")
        .option("--module <module>", "Module slug to reassign (see `pulse modules list`)")
        .option("--assignee <id>", "Assignee id or name (empty string to unassign)")
        .option("--milestone <id>", "Milestone id (empty string to clear)")
        .option("--sprint <id>", "Sprint id (empty string to clear)")
        .option("--due <date>", "Overall due date YYYY-MM-DD or ISO (empty string to clear)")
        .option("--dev-start <date>", "Development start date YYYY-MM-DD or ISO (empty string to clear)")
        .option("--dev-due <date>", "Development due date YYYY-MM-DD or ISO (empty string to clear)")
        .option("--eus-start <date>", "EUS testing start date YYYY-MM-DD or ISO (empty string to clear)")
        .option("--eus-due <date>", "EUS testing due date YYYY-MM-DD or ISO (empty string to clear)")
        .action(async (ref, opts) => {
        const body = {};
        if (opts.title !== undefined)
            body.title = opts.title;
        // Description (file takes precedence)
        if (opts.descriptionFile !== undefined) {
            body.description = fs.readFileSync(opts.descriptionFile, "utf-8");
        }
        else if (opts.description !== undefined) {
            body.description = opts.description;
        }
        if (opts.category !== undefined)
            body.category = opts.category.toUpperCase();
        if (opts.status !== undefined)
            body.status = opts.status.toUpperCase();
        if (opts.priority !== undefined)
            body.priority = opts.priority.toUpperCase();
        // Module is NOT NULL on the issue — it can be reassigned but not cleared.
        if (opts.module !== undefined) {
            if (opts.module === "") {
                throw new Error("Module cannot be cleared — provide a valid slug (see `pulse modules list`).");
            }
            body.module = await resolveModuleSlug(ctx.client, opts.module);
        }
        if (opts.assignee !== undefined) {
            if (opts.assignee === "") {
                body.assigneeId = null;
            }
            else {
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
            }
            else {
                body.dueDate = parseDueDate(opts.due) || null;
            }
        }
        // Phase scheduling dates — same empty-string→null clearing as --due.
        const phaseDateOpts = [
            [opts.devStart, "devStartDate"],
            [opts.devDue, "devDueDate"],
            [opts.eusStart, "eusStartDate"],
            [opts.eusDue, "eusDueDate"],
        ];
        for (const [value, field] of phaseDateOpts) {
            if (value === undefined)
                continue;
            body[field] = value === "" ? null : parseDueDate(value) || null;
        }
        if (Object.keys(body).length === 0) {
            throw new Error("No fields specified to update. Use at least one option.");
        }
        const updated = await ctx.client.put(`/api/issues/${encodeURIComponent(ref)}`, body);
        if (ctx.json) {
            printJson(updated);
        }
        else {
            ok(`Updated ${ref}`);
        }
    });
    // ---- pulse issue delete <keyOrId> ----
    issueCmd
        .command("delete <keyOrId>")
        .description("Delete an issue (irreversible)")
        .option("--yes", "Skip confirmation prompt")
        .action(async (ref, opts) => {
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
        const result = await ctx.client.del(`/api/issues/${encodeURIComponent(ref)}`);
        if (ctx.json) {
            printJson({ ok: true, message: result.message });
        }
        else {
            ok(`Deleted ${ref}`);
        }
    });
}
// ---- Internal helper ----
/** Strip HTML tags for display (mirrors util.stripHtml but local to avoid circular deps) */
function stripHtmlSimple(s) {
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
