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
import { resolveIssueId, stripHtml } from "../core/util.js";
import { resolveUserId } from "../core/lookups.js";
import type {
  IssueListItem,
  IssueDetail,
  CodeReference,
  CodeRefReportItem,
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
}
