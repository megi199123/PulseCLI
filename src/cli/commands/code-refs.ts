// ============================================================
// PulseCLI — src/cli/commands/code-refs.ts
// Commands:
//   pulse code-ref list <issue>                — list code refs for an issue
//   pulse code-ref add <issue> <url> [--title] — attach a PR/MR/commit link
//   pulse code-ref rm <issue> <refId>          — remove a code ref (with confirm)
//   pulse code-ref report [filters]            — flat cross-issue report
// ============================================================

import * as readline from "node:readline";
import { Command } from "commander";
import { printJson, printTable, ok, info } from "../output.js";
import { truncate, formatDate, resolveIssueId } from "../../core/util.js";
import type { CliContext } from "../../core/context.js";
import type { CodeReference, CodeRefReportItem } from "../../core/types.js";

// ---- Helpers ----

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

/**
 * Short "ref" display for table cells: the PR/MR number, or a 7-char sha
 * for commits. Does not include the repo (that's its own column).
 */
function refDisplay(ref: CodeReference): string {
  if (ref.number != null) return String(ref.number);
  if (ref.sha) return ref.sha.slice(0, 7);
  return "—";
}

/**
 * Human label for a code reference, mirroring how Pulse's web UI renders
 * them: `repo#123` for a GitHub PR, `repo!123` for a GitLab MR, and
 * `repo@abc1234` (7-char sha) for a commit.
 */
export function formatCodeRefLabel(ref: CodeReference): string {
  if (ref.kind === "PR" && ref.number != null) return `${ref.repo}#${ref.number}`;
  if (ref.kind === "MR" && ref.number != null) return `${ref.repo}!${ref.number}`;
  if (ref.kind === "COMMIT" && ref.sha) return `${ref.repo}@${ref.sha.slice(0, 7)}`;
  // Defensive fallback for unexpected/future shapes
  if (ref.number != null) return `${ref.repo}#${ref.number}`;
  if (ref.sha) return `${ref.repo}@${ref.sha.slice(0, 7)}`;
  return ref.repo;
}

// ---- Registrar ----

export function register(program: Command, ctx: CliContext): void {
  const codeRefCmd = program
    .command("code-ref")
    .description("Code reference operations (list, add, rm, report)");

  // ===========================================================
  // pulse code-ref list <issue>
  // ===========================================================
  codeRefCmd
    .command("list <issue>")
    .description("List code references (PRs/MRs/commits) attached to an issue")
    .action(async (ref: string) => {
      const issueId = await resolveIssueId(ctx.client, ref);
      const codeRefs = await ctx.client.get<CodeReference[]>(
        `/api/issues/${encodeURIComponent(issueId)}/code-refs`,
      );

      if (ctx.json) {
        printJson(codeRefs);
      } else {
        if (codeRefs.length === 0) {
          info("No code references.");
          return;
        }
        printTable(
          codeRefs.map((c) => ({
            id: c.id,
            kind: c.kind,
            repo: c.repo,
            ref: refDisplay(c),
            title: truncate(c.title ?? "", 40),
            addedBy: c.addedBy?.name ?? "—",
            created: formatDate(c.createdAt),
          })),
          [
            { key: "id", header: "ID" },
            { key: "kind", header: "Kind" },
            { key: "repo", header: "Repo" },
            { key: "ref", header: "Ref" },
            { key: "title", header: "Title", width: 40 },
            { key: "addedBy", header: "Added By" },
            { key: "created", header: "Created" },
          ],
        );
      }
    });

  // ===========================================================
  // pulse code-ref add <issue> <url> [--title <t>]
  // ===========================================================
  codeRefCmd
    .command("add <issue> <url>")
    .description("Attach a PR/MR/commit URL to an issue")
    .option("--title <title>", "Override title for the code reference")
    .action(async (ref: string, url: string, opts: { title?: string }) => {
      const issueId = await resolveIssueId(ctx.client, ref);

      const body: Record<string, unknown> = { url };
      if (opts.title !== undefined) body.title = opts.title;

      // PulseApiError (400 unparseable URL, 409 duplicate) propagates to the
      // top-level handler in index.ts, which prints err.message verbatim —
      // same as every other command. No local try/catch needed.
      const created = await ctx.client.post<CodeReference>(
        `/api/issues/${encodeURIComponent(issueId)}/code-refs`,
        body,
      );

      if (ctx.json) {
        printJson(created);
      } else {
        ok(`Added ${formatCodeRefLabel(created)} (id ${created.id})`);
      }
    });

  // ===========================================================
  // pulse code-ref rm <issue> <refId> [--yes]
  // ===========================================================
  codeRefCmd
    .command("rm <issue> <refId>")
    .description("Remove a code reference from an issue (irreversible)")
    .option("--yes", "Skip confirmation prompt")
    .action(async (ref: string, refId: string, opts: { yes?: boolean }) => {
      if (ctx.json && !opts.yes) {
        throw new Error("Refusing to remove without --yes in --json mode");
      }

      if (!opts.yes && !ctx.json) {
        const confirmed = await promptConfirm(`Remove code ref ${refId}?`);
        if (!confirmed) {
          info("Aborted.");
          return;
        }
      }

      const issueId = await resolveIssueId(ctx.client, ref);

      await ctx.client.del<void>(
        `/api/issues/${encodeURIComponent(issueId)}/code-refs/${refId}`,
      );

      if (ctx.json) {
        printJson({ ok: true });
      } else {
        ok(`Removed code ref ${refId}`);
      }
    });

  // ===========================================================
  // pulse code-ref report [--from <date>] [--to <date>] [--provider <p>] [--repo <r>]
  // ===========================================================
  codeRefCmd
    .command("report")
    .description("Flat report of code references across all issues")
    .option("--from <date>", "Only refs created on/after this date (YYYY-MM-DD or ISO)")
    .option("--to <date>", "Only refs created on/before this date (YYYY-MM-DD or ISO)")
    .option("--provider <provider>", "Filter by provider (GITHUB|GITLAB)")
    .option("--repo <repo>", "Filter by repo")
    .action(
      async (opts: {
        from?: string;
        to?: string;
        provider?: string;
        repo?: string;
      }) => {
        const query: Record<string, string | number | boolean | undefined | null> = {
          from: opts.from,
          to: opts.to,
          provider: opts.provider ? opts.provider.toUpperCase() : undefined,
          repo: opts.repo,
        };

        const items = await ctx.client.get<CodeRefReportItem[]>("/api/code-refs", query);

        // Server silently caps the report at 1000 rows (take: 1000) — warn on
        // stderr so scripted consumers (incl. --json) notice truncation
        // without polluting stdout.
        if (items.length === 1000) {
          console.error(
            "Warning: 1000 rows returned — this is the server's silent cap; results may be truncated.",
          );
        }

        if (ctx.json) {
          printJson(items);
        } else {
          if (items.length === 0) {
            info("No code references.");
            return;
          }
          printTable(
            items.map((c) => ({
              issue: c.issue.key,
              status: c.issue.status,
              module: c.issue.module ?? "—",
              kind: c.kind,
              repo: c.repo,
              ref: refDisplay(c),
              title: truncate(c.title ?? "", 40),
              addedBy: c.addedBy?.name ?? "—",
              created: formatDate(c.createdAt),
            })),
            [
              { key: "issue", header: "Issue" },
              { key: "status", header: "Status" },
              { key: "module", header: "Module" },
              { key: "kind", header: "Kind" },
              { key: "repo", header: "Repo" },
              { key: "ref", header: "Ref" },
              { key: "title", header: "Title", width: 40 },
              { key: "addedBy", header: "Added By" },
              { key: "created", header: "Created" },
            ],
          );
        }
      },
    );
}
