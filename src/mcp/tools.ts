// ============================================================
// PulseCLI — src/mcp/tools.ts
// The five MCP tools exposed by the Pulse MCP server. Tool names are a fixed
// contract — do not rename. Each handler returns { content: [{ type: "text",
// text: JSON.stringify(...) }] }. NEVER write to stdout here — JSON-RPC runs
// over stdio and a stray byte corrupts the protocol. Diagnostics (if ever
// needed) must go to console.error, never to stdout.
// ============================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PulseClient, PulseApiError } from "../core/client.js";
import { resolveIssueId, stripHtml, parseDueDate } from "../core/util.js";
import { resolveUserId, resolveLabelId, resolveModuleSlug } from "../core/lookups.js";
import type {
  IssueListItem,
  IssueDetail,
  CodeReference,
  CodeRefReportItem,
  Comment,
  Label,
} from "../core/types.js";

// ---- Shared helpers ----

/** Cap applied to pulse_search_issues — keeps responses from blowing the agent's context. */
const MAX_SEARCH_LIMIT = 200;

/** Server-side cap on GET /api/code-refs (take: 1000); used to detect truncation. */
const CODE_REFS_REPORT_CAP = 1000;

function textResult(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Compact projection of an issue list item — full IssueListItem objects are too heavy for bulk results. */
function compactIssue(i: IssueListItem) {
  return {
    id: i.id,
    key: i.key,
    title: i.title,
    status: i.status,
    priority: i.priority,
    category: i.category,
    module: i.module,
    assignee: i.assignee?.name ?? null,
    reporter: i.reporter?.name ?? null,
    sprint: i.sprint?.name ?? null,
    milestoneId: i.milestoneId,
    dueDate: i.dueDate,
    labels: i.labels.map((l) => l.name),
    attachments: i._count.attachments,
    comments: i._count.comments,
    links: i._count.linkedIssues,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

/**
 * Convert an optional date-clearing string param into the tri-state value the
 * issue update route expects: undefined (field not sent — leave alone), null
 * (explicit clear, passed as ""), or a parsed ISO datetime string.
 */
function clearableDate(v: string): string | null {
  if (v === "") return null;
  return parseDueDate(v) || null;
}

/** Minimal shape of a GET /api/admin/modules row — enough for id resolution. */
interface AdminModuleRow {
  id: string;
  slug: string;
  label: string;
}

/**
 * Resolve a module value (cuid id, slug, or label) to its cuid id via the
 * ADMIN modules list (GET /api/admin/modules). Unlike the public
 * /api/modules endpoint behind resolveModuleSlug (which only lists active
 * modules and has no admin-only id-bearing use case here), this list
 * includes INACTIVE modules too, so a MODULE_MANAGE caller can still target
 * a module they just deactivated. Requires MODULE_MANAGE — the same
 * permission every caller of this helper already needs for its write call.
 */
async function resolveAdminModuleId(client: PulseClient, value: string): Promise<string> {
  const modules = await client.get<AdminModuleRow[]>("/api/admin/modules");
  const lower = value.trim().toLowerCase();
  const match = modules.find(
    (m) => m.id === value || m.slug.toLowerCase() === lower || m.label.toLowerCase() === lower,
  );
  if (!match) {
    const valid = modules
      .map((m) => m.slug)
      .sort()
      .join(", ");
    throw new Error(`Unknown module "${value}". Valid modules: ${valid || "(none configured)"}.`);
  }
  return match.id;
}

// ---- Registrar ----

export function registerTools(server: McpServer, client: PulseClient): void {
  // ===========================================================
  // pulse_search_issues
  // ===========================================================
  server.tool(
    "pulse_search_issues",
    "Search/filter Pulse issues by status, priority, category, module, assignee, " +
      "text search, milestone, or sprint. By default, issues " +
      "in RELEASED milestones are HIDDEN from results — set includeReleased=true " +
      "(or pass a milestone id) to see them; omitting it silently undercounts. " +
      "Results are compacted to key fields and capped at 200 to avoid blowing " +
      "context — use milestone/sprint/module/assignee/search filters to narrow " +
      "instead of relying on a large limit.",
    {
      status: z
        .string()
        .optional()
        .describe(
          "Filter by status (BACKLOG|OPEN|IN_PROGRESS|STAGING|IN_REVIEW|RESOLVED|CLOSED). Passed through as-is — the server is authoritative.",
        ),
      priority: z.string().optional().describe("Filter by priority (LOW|MEDIUM|HIGH|CRITICAL)"),
      category: z.string().optional().describe("Filter by category (TASK|BUG)"),
      module: z
        .string()
        .optional()
        .describe('Filter by module slug — see pulse_list_lookups(kind: "modules") for valid slugs'),
      assignee: z.string().optional().describe("Filter by assignee — user id or exact display name"),
      search: z.string().optional().describe("Full-text search across title/description"),
      milestone: z
        .string()
        .optional()
        .describe("Filter by milestone id (also reveals RELEASED-milestone issues for that milestone)"),
      sprint: z.string().optional().describe("Filter by sprint id"),
      includeReleased: z
        .boolean()
        .optional()
        .describe(
          "Include issues in RELEASED milestones. Pulse hides these by default in every other filter combination. Default false.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Maximum number of results (default 200, hard-capped at ${MAX_SEARCH_LIMIT})`),
    },
    async ({ status, priority, category, module, assignee, search, milestone, sprint, includeReleased, limit }) => {
      const assigneeId = assignee ? await resolveUserId(client, assignee) : undefined;

      const effectiveLimit = Math.min(limit ?? MAX_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

      const query = {
        status,
        priority,
        category,
        module,
        assigneeId,
        search,
        milestoneId: milestone,
        sprintId: sprint,
        includeReleased: includeReleased ? true : undefined,
        limit: effectiveLimit,
      };

      const issues = await client.get<IssueListItem[]>("/api/issues", query);
      return textResult({ count: issues.length, issues: issues.map(compactIssue) });
    },
  );

  // ===========================================================
  // pulse_get_issue
  // ===========================================================
  server.tool(
    "pulse_get_issue",
    "Fetch full details for a single Pulse issue by key (e.g. PULSE-0001) or id. " +
      "Description HTML is stripped to plain text. Includes attachments, comments, " +
      "activity, links, and codeRefs.",
    {
      issue: z.string().describe("Issue key (e.g. PULSE-0001) or cuid id"),
    },
    async ({ issue }) => {
      const id = await resolveIssueId(client, issue);
      const detail = await client.get<IssueDetail>(`/api/issues/${encodeURIComponent(id)}`);
      return textResult({
        ...detail,
        description: stripHtml(detail.description ?? ""),
      });
    },
  );

  // ===========================================================
  // pulse_list_lookups
  // ===========================================================
  server.tool(
    "pulse_list_lookups",
    "List reference data used to resolve filter/create values: modules, users, " +
      "labels, milestones, or sprints.",
    {
      kind: z
        .enum(["modules", "users", "labels", "milestones", "sprints"])
        .describe("Which lookup list to fetch"),
    },
    async ({ kind }) => {
      const path: Record<typeof kind, string> = {
        modules: "/api/modules",
        users: "/api/users",
        labels: "/api/labels",
        milestones: "/api/milestones",
        sprints: "/api/sprints",
      };
      const data = await client.get<unknown[]>(path[kind]);
      return textResult(data);
    },
  );

  // ===========================================================
  // pulse_code_refs_report
  // ===========================================================
  server.tool(
    "pulse_code_refs_report",
    "Flat report of code references (PRs/MRs/commits) linked to issues, joined " +
      "with issue key/status/assignee/module, for KPI-style joins. Filterable by " +
      "date range, provider, and repo. The server caps results at 1000 rows — " +
      "when exactly 1000 come back the payload includes truncated:true, meaning " +
      "the true result set may be larger; narrow the date range to be sure you " +
      "have everything.",
    {
      from: z.string().optional().describe("ISO date/datetime lower bound (inclusive)"),
      to: z.string().optional().describe("ISO date/datetime upper bound (inclusive)"),
      provider: z.string().optional().describe("Filter by provider (GITHUB|GITLAB)"),
      repo: z.string().optional().describe("Filter by repo name/path"),
    },
    async ({ from, to, provider, repo }) => {
      const items = await client.get<CodeRefReportItem[]>("/api/code-refs", {
        from,
        to,
        provider,
        repo,
      });
      const payload: { count: number; items: CodeRefReportItem[]; truncated?: boolean } = {
        count: items.length,
        items,
      };
      if (items.length === CODE_REFS_REPORT_CAP) {
        payload.truncated = true;
      }
      return textResult(payload);
    },
  );

  // ===========================================================
  // pulse_add_code_ref
  // ===========================================================
  server.tool(
    "pulse_add_code_ref",
    "Attach a PR/MR/commit URL to a Pulse issue as a code reference. Accepts an " +
      "issue key or id. On failure (e.g. 403 missing CODE_REF_WRITE scope, 400 " +
      "unparseable URL, 409 duplicate), the Pulse API's error message is returned " +
      "as the result text rather than as a tool failure — read it to see why.",
    {
      issue: z.string().describe("Issue key (e.g. PULSE-0001) or cuid id to attach the code reference to"),
      url: z.string().describe("PR/MR/commit URL (GitHub or GitLab)"),
      title: z.string().optional().describe("Optional title/label for the code reference"),
    },
    async ({ issue, url, title }) => {
      try {
        const id = await resolveIssueId(client, issue);
        const body: Record<string, unknown> = { url };
        if (title !== undefined) body.title = title;
        const created = await client.post<CodeReference>(
          `/api/issues/${encodeURIComponent(id)}/code-refs`,
          body,
        );
        return textResult(created);
      } catch (err) {
        if (err instanceof PulseApiError) {
          // Return the API's error string as plain text (not JSON-encoded) so
          // the agent reads it directly, rather than as a wrapped tool failure.
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // ===================  ISSUE WRITE TOOLS  ====================
  // ===========================================================

  // ===========================================================
  // pulse_update_issue
  // ===========================================================
  server.tool(
    "pulse_update_issue",
    "Update fields on an existing Pulse issue. Only the fields you pass are " +
      "changed — omitted fields are left untouched. Pass an empty string for " +
      "assignee/milestone/sprint/dueDate/devStartDate/devDueDate/eusStartDate/" +
      "eusDueDate to clear that field; module cannot be cleared, only " +
      "reassigned. Labels are NOT settable here — use pulse_set_issue_labels. " +
      "Permission-gated per field (e.g. assignee changes require ISSUE_ASSIGN; " +
      "others require ISSUE_EDIT_OWN/ISSUE_EDIT_ANY) — on failure (403 missing " +
      "permission, 400 invalid value, 404 not found) the Pulse API's error " +
      "message is returned as the result text rather than as a tool failure.",
    {
      issue: z.string().describe("Issue key (e.g. PULSE-0001) or cuid id to update"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description (plain text or HTML)"),
      category: z.string().optional().describe("New category (TASK|BUG)"),
      status: z
        .string()
        .optional()
        .describe("New status (BACKLOG|OPEN|IN_PROGRESS|STAGING|IN_REVIEW|RESOLVED|CLOSED)"),
      priority: z.string().optional().describe("New priority (LOW|MEDIUM|HIGH|CRITICAL)"),
      module: z
        .string()
        .optional()
        .describe(
          'New module slug or label to reassign the issue to — see pulse_list_lookups(kind: "modules"). Cannot be cleared, only reassigned; an empty string is rejected.',
        ),
      assignee: z
        .string()
        .optional()
        .describe('New assignee — user id or exact display name. Pass "" to unassign.'),
      milestone: z.string().optional().describe('Milestone id. Pass "" to clear.'),
      sprint: z.string().optional().describe('Sprint id. Pass "" to clear.'),
      dueDate: z
        .string()
        .optional()
        .describe('Overall due date (YYYY-MM-DD or ISO datetime). Pass "" to clear.'),
      devStartDate: z
        .string()
        .optional()
        .describe('Development start date (YYYY-MM-DD or ISO datetime). Pass "" to clear.'),
      devDueDate: z
        .string()
        .optional()
        .describe('Development due date (YYYY-MM-DD or ISO datetime). Pass "" to clear.'),
      eusStartDate: z
        .string()
        .optional()
        .describe('EUS testing start date (YYYY-MM-DD or ISO datetime). Pass "" to clear.'),
      eusDueDate: z
        .string()
        .optional()
        .describe('EUS testing due date (YYYY-MM-DD or ISO datetime). Pass "" to clear.'),
    },
    async ({
      issue,
      title,
      description,
      category,
      status,
      priority,
      module,
      assignee,
      milestone,
      sprint,
      dueDate,
      devStartDate,
      devDueDate,
      eusStartDate,
      eusDueDate,
    }) => {
      try {
        const id = await resolveIssueId(client, issue);

        const body: Record<string, unknown> = {};
        if (title !== undefined) body.title = title;
        if (description !== undefined) body.description = description;
        if (category !== undefined) body.category = category.toUpperCase();
        if (status !== undefined) body.status = status.toUpperCase();
        if (priority !== undefined) body.priority = priority.toUpperCase();
        if (module !== undefined) {
          if (module === "") {
            throw new Error(
              'Module cannot be cleared — provide a valid slug (see pulse_list_lookups(kind: "modules")).',
            );
          }
          body.module = await resolveModuleSlug(client, module);
        }
        if (assignee !== undefined) {
          body.assigneeId = assignee === "" ? null : await resolveUserId(client, assignee);
        }
        if (milestone !== undefined) body.milestoneId = milestone === "" ? null : milestone;
        if (sprint !== undefined) body.sprintId = sprint === "" ? null : sprint;
        if (dueDate !== undefined) body.dueDate = clearableDate(dueDate);
        if (devStartDate !== undefined) body.devStartDate = clearableDate(devStartDate);
        if (devDueDate !== undefined) body.devDueDate = clearableDate(devDueDate);
        if (eusStartDate !== undefined) body.eusStartDate = clearableDate(eusStartDate);
        if (eusDueDate !== undefined) body.eusDueDate = clearableDate(eusDueDate);

        if (Object.keys(body).length === 0) {
          throw new Error("No fields provided to update — pass at least one field.");
        }

        const updated = await client.put<unknown>(`/api/issues/${encodeURIComponent(id)}`, body);
        return textResult(updated);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_create_issue
  // ===========================================================
  server.tool(
    "pulse_create_issue",
    "Create a new Pulse issue. Title, description, and category are " +
      "required. Status CANNOT be set on create — the server always starts " +
      "new issues at BACKLOG; use pulse_update_issue afterward to move it. " +
      "Module defaults to the server-configured default module when omitted. " +
      "Requires the ISSUE_CREATE permission — on failure (403, 400 invalid " +
      "field) the Pulse API's error message is returned as the result text " +
      "rather than as a tool failure.",
    {
      title: z.string().describe("Issue title"),
      description: z.string().describe("Issue description (plain text or HTML)"),
      category: z.string().describe("Category: TASK or BUG"),
      priority: z
        .string()
        .optional()
        .describe("Priority (LOW|MEDIUM|HIGH|CRITICAL); server defaults to MEDIUM if omitted"),
      module: z
        .string()
        .optional()
        .describe(
          'Module slug or label to file the issue under — see pulse_list_lookups(kind: "modules"). Defaults to the server-configured default module.',
        ),
      assignee: z.string().optional().describe("Assignee — user id or exact display name"),
      milestone: z.string().optional().describe("Milestone id"),
      sprint: z.string().optional().describe("Sprint id"),
      dueDate: z.string().optional().describe("Due date (YYYY-MM-DD or ISO datetime)"),
      labels: z
        .array(z.string())
        .optional()
        .describe("Label ids or exact label names to attach at creation time"),
    },
    async ({ title, description, category, priority, module, assignee, milestone, sprint, dueDate, labels }) => {
      try {
        const body: Record<string, unknown> = {
          title,
          description,
          category: category.toUpperCase(),
        };
        if (priority !== undefined) body.priority = priority.toUpperCase();
        if (module !== undefined) body.module = await resolveModuleSlug(client, module);
        if (assignee !== undefined) body.assigneeId = await resolveUserId(client, assignee);
        if (milestone !== undefined) body.milestoneId = milestone;
        if (sprint !== undefined) body.sprintId = sprint;
        if (dueDate !== undefined) body.dueDate = parseDueDate(dueDate) || undefined;
        if (labels !== undefined && labels.length > 0) {
          body.labelIds = await Promise.all(labels.map((l) => resolveLabelId(client, l)));
        }

        const created = await client.post<unknown>("/api/issues", body);
        return textResult(created);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_add_comment
  // ===========================================================
  server.tool(
    "pulse_add_comment",
    "Add a comment to a Pulse issue. Plain text is auto-wrapped in a <p> " +
      "tag since comments are stored as Tiptap HTML — pass HTML directly if " +
      "you need richer formatting. Requires the COMMENT_CREATE permission — " +
      "on failure (403, 404 issue not found) the Pulse API's error message is " +
      "returned as the result text rather than as a tool failure.",
    {
      issue: z.string().describe("Issue key (e.g. PULSE-0001) or cuid id to comment on"),
      content: z.string().describe("Comment text — plain text (auto-wrapped in <p>) or Tiptap HTML"),
    },
    async ({ issue, content }) => {
      try {
        const id = await resolveIssueId(client, issue);
        const html = /^\s*</.test(content) ? content : `<p>${content}</p>`;
        const created = await client.post<Comment>("/api/comments", {
          ticketId: id,
          content: html,
        });
        return textResult(created);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_set_issue_labels
  // ===========================================================
  server.tool(
    "pulse_set_issue_labels",
    "Replace the full label set on a Pulse issue. This is a full REPLACE, " +
      "not additive — pass the complete desired list of labels every time " +
      "(an empty array removes all labels). Permission-gated — on failure " +
      "(403 missing permission, 404 not found) the Pulse API's error message " +
      "is returned as the result text rather than as a tool failure.",
    {
      issue: z.string().describe("Issue key (e.g. PULSE-0001) or cuid id"),
      labels: z
        .array(z.string())
        .describe(
          'Complete desired list of label ids or exact label names — see pulse_list_lookups(kind: "labels"). Replaces the existing set entirely; pass [] to clear all labels.',
        ),
    },
    async ({ issue, labels }) => {
      try {
        const id = await resolveIssueId(client, issue);
        const labelIds = await Promise.all(labels.map((l) => resolveLabelId(client, l)));
        const result = await client.put<{ labels: Label[] }>(
          `/api/issues/${encodeURIComponent(id)}/labels`,
          { labelIds },
        );
        return textResult(result);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_link_issues
  // ===========================================================
  server.tool(
    "pulse_link_issues",
    "Create a link between two Pulse issues (e.g. mark one as blocking " +
      "another). Valid types per the live schema: RELATED, BLOCKS, " +
      "BLOCKED_BY, DUPLICATES, DUPLICATED_BY — passed through uppercased, " +
      "not validated client-side, so the server is authoritative on new " +
      "values. Requires an authenticated token (the current backend enforces " +
      "no extra scope on links). On failure (400 self-link, 404 target " +
      "not found, 409 duplicate link) the Pulse API's error message is " +
      "returned as the result text rather than as a tool failure.",
    {
      issue: z.string().describe("Source issue key (e.g. PULSE-0001) or cuid id"),
      target: z.string().describe("Target issue key (e.g. PULSE-0002) or cuid id to link to"),
      type: z
        .string()
        .describe("Link type: RELATED | BLOCKS | BLOCKED_BY | DUPLICATES | DUPLICATED_BY"),
    },
    async ({ issue, target, type }) => {
      try {
        const id = await resolveIssueId(client, issue);
        const targetId = await resolveIssueId(client, target);
        const link = await client.post<unknown>(`/api/issues/${encodeURIComponent(id)}/links`, {
          targetId,
          type: type.toUpperCase(),
        });
        return textResult(link);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_unlink_issue
  // ===========================================================
  server.tool(
    "pulse_unlink_issue",
    "Remove a link from a Pulse issue by link id (find the link id via " +
      "pulse_get_issue's links array, or the result of pulse_link_issues). " +
      "Requires an authenticated token (the current backend enforces no " +
      "extra scope on links). On failure (404 link not found or doesn't " +
      "belong to this issue) the Pulse API's error message is returned as " +
      "the result text rather than as a tool failure.",
    {
      issue: z.string().describe("Issue key (e.g. PULSE-0001) or cuid id the link belongs to"),
      linkId: z.string().describe("The link's cuid id to remove"),
    },
    async ({ issue, linkId }) => {
      try {
        const id = await resolveIssueId(client, issue);
        const result = await client.del<{ message: string }>(
          `/api/issues/${encodeURIComponent(id)}/links/${encodeURIComponent(linkId)}`,
        );
        return textResult(result);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_set_assignee
  // ===========================================================
  server.tool(
    "pulse_set_assignee",
    "Set or clear the assignee on a Pulse issue. This is the dedicated " +
      "assignment endpoint, gated specifically on the ISSUE_ASSIGN " +
      "permission (separate from general issue-edit permission). Pass an " +
      "empty string to unassign. On failure (403 missing ISSUE_ASSIGN, 404 " +
      "issue or assignee user not found) the Pulse API's error message is " +
      "returned as the result text rather than as a tool failure.",
    {
      issue: z.string().describe("Issue key (e.g. PULSE-0001) or cuid id"),
      assignee: z
        .string()
        .describe('New assignee — user id or exact display name. Pass "" to unassign.'),
    },
    async ({ issue, assignee }) => {
      try {
        const id = await resolveIssueId(client, issue);
        const assigneeId = assignee === "" ? null : await resolveUserId(client, assignee);
        const result = await client.patch<{
          id: string;
          assignee: { id: string; name: string } | null;
        }>(`/api/issues/${encodeURIComponent(id)}/assignee`, { assigneeId });
        return textResult(result);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_watch_issue
  // ===========================================================
  server.tool(
    "pulse_watch_issue",
    "Start watching a Pulse issue (subscribes the authenticated user/token " +
      "to its notifications). Idempotent — watching an already-watched issue " +
      "is a no-op success. Requires only an authenticated token (no extra " +
      "scope enforced). On failure (401 unauthenticated, 404 not found) the " +
      "Pulse API's error message is returned as the result text rather than " +
      "as a tool failure.",
    {
      issue: z.string().describe("Issue key (e.g. PULSE-0001) or cuid id to watch"),
    },
    async ({ issue }) => {
      try {
        const id = await resolveIssueId(client, issue);
        const result = await client.post<{ watching: boolean; count: number }>(
          `/api/issues/${encodeURIComponent(id)}/watch`,
        );
        return textResult(result);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_unwatch_issue
  // ===========================================================
  server.tool(
    "pulse_unwatch_issue",
    "Stop watching a Pulse issue (unsubscribes the authenticated " +
      "user/token from its notifications). Idempotent — unwatching an " +
      "issue you don't watch is a no-op success. Requires only an " +
      "authenticated token (no extra scope enforced). On failure (401 " +
      "unauthenticated, 404 not found) the Pulse API's error message is " +
      "returned as the result text rather than as a tool failure.",
    {
      issue: z.string().describe("Issue key (e.g. PULSE-0001) or cuid id to stop watching"),
    },
    async ({ issue }) => {
      try {
        const id = await resolveIssueId(client, issue);
        const result = await client.del<{ watching: boolean; count: number }>(
          `/api/issues/${encodeURIComponent(id)}/watch`,
        );
        return textResult(result);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_move_issue
  // ===========================================================
  server.tool(
    "pulse_move_issue",
    "Move a Pulse issue to a different module, re-homing it under a new key " +
      "prefix (the old key is retired — links by id keep working, but the " +
      "old key stops resolving). Optionally reassigns the reporter in the " +
      "same call. Milestone/sprint are auto-cleared by the server when they " +
      "don't belong to the destination module. Permission-gated — on " +
      "failure (403, 400 invalid/same module, 404 reporter not found) the " +
      "Pulse API's error message is returned as the result text rather than " +
      "as a tool failure.",
    {
      issue: z.string().describe("Issue key (e.g. PULSE-0001) or cuid id to move"),
      module: z
        .string()
        .describe('Destination module slug or label — see pulse_list_lookups(kind: "modules")'),
      reporter: z
        .string()
        .optional()
        .describe("New reporter — user id or exact display name; omit to keep the current reporter"),
    },
    async ({ issue, module, reporter }) => {
      try {
        const id = await resolveIssueId(client, issue);
        const targetModule = await resolveModuleSlug(client, module);
        const body: Record<string, unknown> = { module: targetModule };
        if (reporter !== undefined) body.reporterId = await resolveUserId(client, reporter);
        const moved = await client.post<unknown>(
          `/api/issues/${encodeURIComponent(id)}/move`,
          body,
        );
        return textResult(moved);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // ======  MILESTONE / SPRINT / MODULE / MISC WRITE TOOLS  ======
  // ===========================================================

  // ===========================================================
  // pulse_create_milestone
  // ===========================================================
  server.tool(
    "pulse_create_milestone",
    "Create a new Pulse milestone. name, targetDate, and module are " +
      "required. EUS lead defaults to the authenticated user when omitted; " +
      "status defaults to PLANNED. Requires the MILESTONE_MANAGE permission " +
      "— on failure (403, 400 invalid module/date) the Pulse API's error " +
      "message is returned as the result text rather than as a tool failure.",
    {
      name: z.string().min(1).describe("Milestone name"),
      targetDate: z.string().describe("Target date (YYYY-MM-DD or ISO datetime)"),
      module: z
        .string()
        .describe('Module slug or label to file the milestone under — see pulse_list_lookups(kind: "modules")'),
      description: z.string().optional().describe("Optional milestone description"),
      status: z
        .string()
        .optional()
        .describe(
          "Status: PLANNED|ACTIVE|COMPLETED|OPEN|IN_PROGRESS|FOR_TESTING|DONE|FOR_STAGING|FOR_DEPLOYMENT|RELEASED. Defaults to PLANNED.",
        ),
      eusLead: z
        .string()
        .optional()
        .describe("EUS lead — user id or exact display name; defaults to the authenticated user"),
      labels: z
        .array(z.string())
        .optional()
        .describe(
          'Label ids or exact label names to attach at creation time — see pulse_list_lookups(kind: "labels")',
        ),
    },
    async ({ name, targetDate, module, description, status, eusLead, labels }) => {
      try {
        const body: Record<string, unknown> = {
          name,
          targetDate: parseDueDate(targetDate),
          module: await resolveModuleSlug(client, module),
        };
        if (description !== undefined) body.description = description;
        if (status !== undefined) body.status = status.toUpperCase();
        if (eusLead !== undefined) body.eusLeadId = await resolveUserId(client, eusLead);
        if (labels !== undefined && labels.length > 0) {
          body.labelIds = await Promise.all(labels.map((l) => resolveLabelId(client, l)));
        }

        const created = await client.post<unknown>("/api/milestones", body);
        return textResult(created);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_update_milestone
  // ===========================================================
  server.tool(
    "pulse_update_milestone",
    "Update fields on an existing Pulse milestone. Only the fields you " +
      "pass are changed — omitted fields are left untouched. targetDate " +
      "cannot be cleared, only reassigned (an empty string is rejected); " +
      "module cannot be cleared either, only reassigned. Pass an empty " +
      "string for description/eusLead/releaseNotes to clear that field. " +
      "labels is a full REPLACE of the label set (pass [] to clear all). " +
      "Requires the MILESTONE_MANAGE permission — on failure (403, 400 " +
      "invalid value, 404 not found) the Pulse API's error message is " +
      "returned as the result text rather than as a tool failure.",
    {
      milestone: z.string().describe('Milestone id (cuid) to update — see pulse_list_lookups(kind: "milestones")'),
      name: z.string().optional().describe("New name"),
      description: z.string().optional().describe('New description. Pass "" to clear.'),
      targetDate: z
        .string()
        .optional()
        .describe(
          "New target date (YYYY-MM-DD or ISO datetime). Cannot be cleared — omit to leave unchanged.",
        ),
      module: z
        .string()
        .optional()
        .describe(
          'New module slug or label to reassign the milestone to — see pulse_list_lookups(kind: "modules"). Cannot be cleared, only reassigned; an empty string is rejected.',
        ),
      status: z
        .string()
        .optional()
        .describe(
          "New status: PLANNED|ACTIVE|COMPLETED|OPEN|IN_PROGRESS|FOR_TESTING|DONE|FOR_STAGING|FOR_DEPLOYMENT|RELEASED",
        ),
      eusLead: z
        .string()
        .optional()
        .describe('New EUS lead — user id or exact display name. Pass "" to clear.'),
      labels: z
        .array(z.string())
        .optional()
        .describe(
          'Complete desired list of label ids or exact label names — see pulse_list_lookups(kind: "labels"). Replaces the existing set entirely; pass [] to clear all labels.',
        ),
      releaseNotes: z.string().optional().describe('New release notes text. Pass "" to clear.'),
    },
    async ({ milestone, name, description, targetDate, module, status, eusLead, labels, releaseNotes }) => {
      try {
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (description !== undefined) body.description = description === "" ? null : description;
        if (targetDate !== undefined) {
          if (targetDate === "") {
            throw new Error(
              "targetDate cannot be cleared — provide a valid date, or omit this field to leave it unchanged.",
            );
          }
          body.targetDate = parseDueDate(targetDate);
        }
        if (module !== undefined) {
          if (module === "") {
            throw new Error(
              'Module cannot be cleared — provide a valid slug (see pulse_list_lookups(kind: "modules")).',
            );
          }
          body.module = await resolveModuleSlug(client, module);
        }
        if (status !== undefined) body.status = status.toUpperCase();
        if (eusLead !== undefined) {
          body.eusLeadId = eusLead === "" ? null : await resolveUserId(client, eusLead);
        }
        if (labels !== undefined) {
          body.labelIds = await Promise.all(labels.map((l) => resolveLabelId(client, l)));
        }
        if (releaseNotes !== undefined) body.releaseNotes = releaseNotes === "" ? null : releaseNotes;

        if (Object.keys(body).length === 0) {
          throw new Error("No fields provided to update — pass at least one field.");
        }

        const updated = await client.put<unknown>(
          `/api/milestones/${encodeURIComponent(milestone)}`,
          body,
        );
        return textResult(updated);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_delete_milestone
  // ===========================================================
  server.tool(
    "pulse_delete_milestone",
    "Delete a Pulse milestone permanently, including its attachments. " +
      "Issues and sprints referencing it are NOT deleted — their " +
      "milestoneId is simply cleared by the DB's SetNull cascade. Requires " +
      "the MILESTONE_MANAGE permission — on failure (403, 404 not found) " +
      "the Pulse API's error message is returned as the result text rather " +
      "than as a tool failure.",
    {
      milestone: z.string().describe("Milestone id (cuid) to delete"),
    },
    async ({ milestone }) => {
      try {
        const result = await client.del<{ message: string }>(
          `/api/milestones/${encodeURIComponent(milestone)}`,
        );
        return textResult(result);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_create_sprint
  // ===========================================================
  server.tool(
    "pulse_create_sprint",
    "Create a new Pulse sprint. name, startDate, and endDate are " +
      "required; module/milestone are optional. EUS lead defaults to the " +
      "authenticated user when omitted; status defaults to PLANNED. " +
      "Requires the SPRINT_MANAGE permission — on failure (403, 400 " +
      "invalid module/date) the Pulse API's error message is returned as " +
      "the result text rather than as a tool failure.",
    {
      name: z.string().min(1).describe("Sprint name"),
      startDate: z.string().describe("Start date (YYYY-MM-DD or ISO datetime)"),
      endDate: z.string().describe("End date (YYYY-MM-DD or ISO datetime)"),
      module: z
        .string()
        .optional()
        .describe('Module slug or label to scope the sprint to — see pulse_list_lookups(kind: "modules")'),
      milestone: z.string().optional().describe("Milestone id to attach this sprint to"),
      status: z
        .string()
        .optional()
        .describe("Status: PLANNED|ACTIVE|COMPLETED. Defaults to PLANNED."),
      eusLead: z
        .string()
        .optional()
        .describe("EUS lead — user id or exact display name; defaults to the authenticated user"),
      labels: z
        .array(z.string())
        .optional()
        .describe(
          'Label ids or exact label names to attach at creation time — see pulse_list_lookups(kind: "labels")',
        ),
    },
    async ({ name, startDate, endDate, module, milestone, status, eusLead, labels }) => {
      try {
        const body: Record<string, unknown> = {
          name,
          startDate: parseDueDate(startDate),
          endDate: parseDueDate(endDate),
        };
        if (module !== undefined) body.module = await resolveModuleSlug(client, module);
        if (milestone !== undefined) body.milestoneId = milestone;
        if (status !== undefined) body.status = status.toUpperCase();
        if (eusLead !== undefined) body.eusLeadId = await resolveUserId(client, eusLead);
        if (labels !== undefined && labels.length > 0) {
          body.labelIds = await Promise.all(labels.map((l) => resolveLabelId(client, l)));
        }

        const created = await client.post<unknown>("/api/sprints", body);
        return textResult(created);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_update_sprint
  // ===========================================================
  server.tool(
    "pulse_update_sprint",
    "Update fields on an existing Pulse sprint. Only the fields you pass " +
      "are changed — omitted fields are left untouched. startDate/endDate " +
      "cannot be cleared, only reassigned (an empty string is rejected). " +
      "Pass an empty string for module/milestone/eusLead/summaryNotes to " +
      "clear that field. labels is a full REPLACE of the label set (pass " +
      "[] to clear all). Requires the SPRINT_MANAGE permission — on " +
      "failure (403, 400 invalid value, 404 not found) the Pulse API's " +
      "error message is returned as the result text rather than as a tool " +
      "failure.",
    {
      sprint: z.string().describe('Sprint id (cuid) to update — see pulse_list_lookups(kind: "sprints")'),
      name: z.string().optional().describe("New name"),
      startDate: z
        .string()
        .optional()
        .describe("New start date (YYYY-MM-DD or ISO datetime). Cannot be cleared — omit to leave unchanged."),
      endDate: z
        .string()
        .optional()
        .describe("New end date (YYYY-MM-DD or ISO datetime). Cannot be cleared — omit to leave unchanged."),
      module: z
        .string()
        .optional()
        .describe(
          'New module slug or label — see pulse_list_lookups(kind: "modules"). Pass "" to clear (unscope the sprint).',
        ),
      milestone: z.string().optional().describe('New milestone id to attach to. Pass "" to detach.'),
      status: z.string().optional().describe("New status: PLANNED|ACTIVE|COMPLETED"),
      eusLead: z
        .string()
        .optional()
        .describe('New EUS lead — user id or exact display name. Pass "" to clear.'),
      labels: z
        .array(z.string())
        .optional()
        .describe(
          'Complete desired list of label ids or exact label names — see pulse_list_lookups(kind: "labels"). Replaces the existing set entirely; pass [] to clear all labels.',
        ),
      summaryNotes: z.string().optional().describe('New sprint summary notes. Pass "" to clear.'),
    },
    async ({ sprint, name, startDate, endDate, module, milestone, status, eusLead, labels, summaryNotes }) => {
      try {
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (startDate !== undefined) {
          if (startDate === "") {
            throw new Error(
              "startDate cannot be cleared — provide a valid date, or omit this field to leave it unchanged.",
            );
          }
          body.startDate = parseDueDate(startDate);
        }
        if (endDate !== undefined) {
          if (endDate === "") {
            throw new Error(
              "endDate cannot be cleared — provide a valid date, or omit this field to leave it unchanged.",
            );
          }
          body.endDate = parseDueDate(endDate);
        }
        if (module !== undefined) {
          body.module = module === "" ? null : await resolveModuleSlug(client, module);
        }
        if (milestone !== undefined) body.milestoneId = milestone === "" ? null : milestone;
        if (status !== undefined) body.status = status.toUpperCase();
        if (eusLead !== undefined) {
          body.eusLeadId = eusLead === "" ? null : await resolveUserId(client, eusLead);
        }
        if (labels !== undefined) {
          body.labelIds = await Promise.all(labels.map((l) => resolveLabelId(client, l)));
        }
        if (summaryNotes !== undefined) body.summaryNotes = summaryNotes === "" ? null : summaryNotes;

        if (Object.keys(body).length === 0) {
          throw new Error("No fields provided to update — pass at least one field.");
        }

        const updated = await client.put<unknown>(`/api/sprints/${encodeURIComponent(sprint)}`, body);
        return textResult(updated);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_delete_sprint
  // ===========================================================
  server.tool(
    "pulse_delete_sprint",
    "Delete a Pulse sprint permanently, including its attachments. Issues " +
      "referencing it are NOT deleted — their sprintId is simply cleared " +
      "by the DB's SetNull cascade. Requires the SPRINT_MANAGE permission " +
      "— on failure (403, 404 not found) the Pulse API's error message is " +
      "returned as the result text rather than as a tool failure.",
    {
      sprint: z.string().describe("Sprint id (cuid) to delete"),
    },
    async ({ sprint }) => {
      try {
        const result = await client.del<{ message: string }>(`/api/sprints/${encodeURIComponent(sprint)}`);
        return textResult(result);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_add_sprint_issues
  // ===========================================================
  server.tool(
    "pulse_add_sprint_issues",
    "Add one or more Pulse issues to a sprint. The underlying API accepts " +
      "only one ticket per call, so this tool loops per issue and reports " +
      "a PER-ISSUE result — one issue failing (e.g. already resolved, not " +
      "found) does not abort the rest of the batch. A BACKLOG issue added " +
      "to a sprint is auto-promoted to OPEN by the server. Requires the " +
      "SPRINT_MANAGE permission.",
    {
      sprint: z.string().describe('Sprint id (cuid) to add issues to — see pulse_list_lookups(kind: "sprints")'),
      issues: z.array(z.string()).min(1).describe("Issue keys (e.g. PULSE-0001) or cuid ids to add to the sprint"),
    },
    async ({ sprint, issues }) => {
      const results: Array<{ issue: string; ok: boolean; message?: string }> = [];
      for (const issue of issues) {
        try {
          const id = await resolveIssueId(client, issue);
          await client.post(`/api/sprints/${encodeURIComponent(sprint)}/tickets`, { ticketId: id });
          results.push({ issue, ok: true });
        } catch (err) {
          if (err instanceof PulseApiError) {
            results.push({ issue, ok: false, message: err.message });
          } else {
            results.push({ issue, ok: false, message: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      return textResult({ sprint, results });
    },
  );

  // ===========================================================
  // pulse_remove_sprint_issue
  // ===========================================================
  server.tool(
    "pulse_remove_sprint_issue",
    "Remove a single Pulse issue from a sprint (clears its sprintId; the " +
      "issue itself is not deleted). A no-op success if the issue isn't " +
      "currently in that sprint. Requires the SPRINT_MANAGE permission — " +
      "on failure (403, 404 sprint or issue not found) the Pulse API's " +
      "error message is returned as the result text rather than as a tool " +
      "failure.",
    {
      sprint: z.string().describe("Sprint id (cuid) to remove the issue from"),
      issue: z.string().describe("Issue key (e.g. PULSE-0001) or cuid id to remove from the sprint"),
    },
    async ({ sprint, issue }) => {
      try {
        const id = await resolveIssueId(client, issue);
        const result = await client.request<{ message: string }>(
          "DELETE",
          `/api/sprints/${encodeURIComponent(sprint)}/tickets`,
          { jsonBody: { ticketId: id } },
        );
        return textResult(result);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_create_module
  // ===========================================================
  server.tool(
    "pulse_create_module",
    "Create a new Pulse module (admin-level configuration, not a regular " +
      "project entity). slug, label, inkHex, tintHex, and prefix are all " +
      "required — slug must be UPPERCASE letters/digits/underscores " +
      "starting with a letter; prefix must be 2-10 uppercase letters " +
      "(optionally with trailing digits), no hyphens, and unique across " +
      "modules (used for issue key prefixes like PULSE-0001). Requires the " +
      "MODULE_MANAGE permission — on failure (403, 400 invalid format, 409 " +
      "duplicate slug/prefix) the Pulse API's error message is returned as " +
      "the result text rather than as a tool failure.",
    {
      slug: z
        .string()
        .describe("Unique slug — UPPERCASE letters/digits/underscores, starting with a letter (e.g. BILLING)"),
      label: z.string().min(1).describe("Human-readable display label"),
      inkHex: z.string().describe("Text/icon color, 6-digit hex with # (e.g. #FF0000)"),
      tintHex: z.string().describe("Background tint color, 6-digit hex with # (e.g. #FFE5E5)"),
      prefix: z
        .string()
        .describe(
          "Unique issue-key prefix — 2-10 uppercase letters, or 1-8 letters plus 1-2 trailing digits, no hyphens (e.g. BILL)",
        ),
      sortOrder: z.number().int().optional().describe("Display sort order. Defaults to 0."),
      isDefault: z
        .boolean()
        .optional()
        .describe("Make this the default module for new issues (unsets any other module's default). Defaults to false."),
      isActive: z.boolean().optional().describe("Whether the module is active/selectable. Defaults to true."),
      status: z
        .string()
        .optional()
        .describe("Lifecycle status: UNDER_DEVELOPMENT|UAT|LIVE. Defaults to UNDER_DEVELOPMENT."),
    },
    async ({ slug, label, inkHex, tintHex, prefix, sortOrder, isDefault, isActive, status }) => {
      try {
        const body: Record<string, unknown> = { slug, label, inkHex, tintHex, prefix };
        if (sortOrder !== undefined) body.sortOrder = sortOrder;
        if (isDefault !== undefined) body.isDefault = isDefault;
        if (isActive !== undefined) body.isActive = isActive;
        if (status !== undefined) body.status = status.toUpperCase();

        const created = await client.post<unknown>("/api/admin/modules", body);
        return textResult(created);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_update_module
  // ===========================================================
  server.tool(
    "pulse_update_module",
    "Update fields on an existing Pulse module. slug is NOT patchable " +
      "(only label/inkHex/tintHex/prefix/sortOrder/isActive/isDefault/" +
      "status are). Only the fields you pass are changed. Setting " +
      "isDefault true unsets any other module's default. Requires the " +
      "MODULE_MANAGE permission — on failure (403, 400 invalid format, " +
      "404 not found, 409 duplicate prefix) the Pulse API's error message " +
      "is returned as the result text rather than as a tool failure.",
    {
      module: z
        .string()
        .describe('Module cuid id, slug, or label to update — see pulse_list_lookups(kind: "modules")'),
      label: z.string().optional().describe("New display label"),
      inkHex: z.string().optional().describe("New text/icon color, 6-digit hex with # (e.g. #FF0000)"),
      tintHex: z.string().optional().describe("New background tint color, 6-digit hex with # (e.g. #FFE5E5)"),
      prefix: z
        .string()
        .optional()
        .describe(
          "New unique issue-key prefix — 2-10 uppercase letters, or 1-8 letters plus 1-2 trailing digits, no hyphens",
        ),
      sortOrder: z.number().int().optional().describe("New display sort order"),
      isActive: z.boolean().optional().describe("Whether the module is active/selectable"),
      isDefault: z.boolean().optional().describe("Make this the default module for new issues"),
      status: z.string().optional().describe("New lifecycle status: UNDER_DEVELOPMENT|UAT|LIVE"),
    },
    async ({ module, label, inkHex, tintHex, prefix, sortOrder, isActive, isDefault, status }) => {
      try {
        const body: Record<string, unknown> = {};
        if (label !== undefined) body.label = label;
        if (inkHex !== undefined) body.inkHex = inkHex;
        if (tintHex !== undefined) body.tintHex = tintHex;
        if (prefix !== undefined) body.prefix = prefix;
        if (sortOrder !== undefined) body.sortOrder = sortOrder;
        if (isActive !== undefined) body.isActive = isActive;
        if (isDefault !== undefined) body.isDefault = isDefault;
        if (status !== undefined) body.status = status.toUpperCase();

        if (Object.keys(body).length === 0) {
          throw new Error("No fields provided to update — pass at least one field.");
        }

        const id = await resolveAdminModuleId(client, module);
        const updated = await client.patch<unknown>(`/api/admin/modules/${encodeURIComponent(id)}`, body);
        return textResult(updated);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_delete_module
  // ===========================================================
  server.tool(
    "pulse_delete_module",
    "Delete a Pulse module. Blocked with a 409 if any issue, milestone, or " +
      "sprint still references it — reassign or remove those first. " +
      "Requires the MODULE_MANAGE permission — on failure (403, 404 not " +
      "found, 409 still referenced) the Pulse API's error message is " +
      "returned as the result text rather than as a tool failure.",
    {
      module: z
        .string()
        .describe('Module cuid id, slug, or label to delete — see pulse_list_lookups(kind: "modules")'),
    },
    async ({ module }) => {
      try {
        const id = await resolveAdminModuleId(client, module);
        const result = await client.del<{ success: boolean }>(`/api/admin/modules/${encodeURIComponent(id)}`);
        return textResult(result);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_create_feedback
  // ===========================================================
  server.tool(
    "pulse_create_feedback",
    "Submit product feedback (feature request, bug report, or nice-to-have " +
      "idea) — a separate, lighter-weight surface from full Pulse issues. " +
      "Requires the FEEDBACK_CREATE permission/token scope — on failure " +
      "(403, 400 invalid type) the Pulse API's error message is returned " +
      "as the result text rather than as a tool failure.",
    {
      title: z.string().min(1).describe("Feedback title"),
      description: z.string().min(1).describe("Feedback description"),
      type: z.string().describe("Feedback type: FEATURE_REQUEST | BUG | NICE_TO_HAVE"),
    },
    async ({ title, description, type }) => {
      try {
        const created = await client.post<unknown>("/api/feedback", {
          title,
          description,
          type: type.toUpperCase(),
        });
        return textResult(created);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_start_standup
  // ===========================================================
  server.tool(
    "pulse_start_standup",
    "Start a new Pulse daily-standup session for a given date, paging " +
      "through enabled modules. Errors 409 if a non-superseded session " +
      "already exists for that date unless force is set (which supersedes " +
      "it) — and 400 if no modules are enabled for standup. Requires the " +
      "STANDUP_MANAGE permission — on failure the Pulse API's error " +
      "message is returned as the result text rather than as a tool " +
      "failure.",
    {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
        .describe("Standup date (YYYY-MM-DD)"),
      force: z
        .boolean()
        .optional()
        .describe("Supersede any existing non-superseded session for this date instead of erroring with 409"),
      excludedModuleIds: z
        .array(z.string())
        .optional()
        .describe("Module ids to exclude from this session's pages, even if otherwise enabled for standup"),
    },
    async ({ date, force, excludedModuleIds }) => {
      try {
        const body: Record<string, unknown> = { date };
        if (force !== undefined) body.force = force;
        if (excludedModuleIds !== undefined) body.excludedModuleIds = excludedModuleIds;

        const created = await client.post<unknown>("/api/standup/sessions", body);
        return textResult(created);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_set_standup_notes
  // ===========================================================
  server.tool(
    "pulse_set_standup_notes",
    "Write (overwrite) the free-text notes on a daily-standup session page " +
      "— the per-module 'diary' entry recording what a module discussed. " +
      "Pass the page's id (from a standup session's pages, e.g. via " +
      "pulse_start_standup's response or the active session) and the notes " +
      "as an HTML string; pass null to clear. Last-write-wins: concurrent " +
      "edits silently overwrite each other, there is no conflict detection. " +
      "Auth only (any valid token) — but requires a Pulse server whose notes " +
      "route accepts token auth; on an older instance expect 401/404. On " +
      "failure the Pulse API's error message is returned as the result text " +
      "rather than as a tool failure.",
    {
      pageId: z
        .string()
        .min(1)
        .describe("Standup session page id to write notes on (from the session's pages)"),
      notesHtml: z
        .string()
        .nullable()
        .describe("Notes content as an HTML string; pass null to clear the notes"),
    },
    async ({ pageId, notesHtml }) => {
      try {
        const updated = await client.put<unknown>(
          `/api/standup/pages/${encodeURIComponent(pageId)}/notes`,
          { notesHtml },
        );
        return textResult(updated);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );

  // ===========================================================
  // pulse_get_changelog
  // ===========================================================
  server.tool(
    "pulse_get_changelog",
    "Fetch the Pulse product changelog. By default returns the current " +
      "version plus the FULL entry history; pass latestOnly=true to get " +
      "just the current version and its most recent entry. This is a " +
      "Part-1 (Phase 1) endpoint gated on being present on the target " +
      "server — if the local Pulse instance predates it, expect a 404.",
    {
      latestOnly: z
        .boolean()
        .optional()
        .describe("If true, only return the current version and its latest entry (adds ?latest=1)"),
    },
    async ({ latestOnly }) => {
      try {
        const data = await client.get<unknown>("/api/changelog", {
          latest: latestOnly ? true : undefined,
        });
        return textResult(data);
      } catch (err) {
        if (err instanceof PulseApiError) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    },
  );
}
