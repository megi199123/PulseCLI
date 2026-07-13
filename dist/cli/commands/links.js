// ============================================================
// PulseCLI — src/cli/commands/links.ts
// Commands:
//   pulse link list <issueKeyOrId>                        — list links
//   pulse link add <issueKeyOrId> <targetKeyOrId> <type>  — add a link
//   pulse link remove <issueKeyOrId> <linkId>             — remove a link (with confirm)
// ============================================================
import * as readline from "node:readline";
import { printJson, printTable, ok, info } from "../output.js";
import { truncate, resolveIssueId } from "../../core/util.js";
// ---- Helpers ----
const VALID_LINK_TYPES = ["RELATED", "BLOCKS", "BLOCKED_BY"];
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
// ---- Registrar ----
export function register(program, ctx) {
    const linkCmd = program
        .command("link")
        .description("Issue link operations (list, add, remove)");
    // ===========================================================
    // pulse link list <issueKeyOrId>
    // ===========================================================
    linkCmd
        .command("list <issueKeyOrId>")
        .description("List links for an issue")
        .action(async (ref) => {
        const links = await ctx.client.get(`/api/issues/${encodeURIComponent(ref)}/links`);
        if (ctx.json) {
            printJson(links);
        }
        else {
            if (links.length === 0) {
                info("No links.");
                return;
            }
            printTable(links.map((l) => ({
                linkId: l.id,
                type: l.type,
                dir: l.direction,
                otherTitle: truncate(l.otherIssue.title, 40),
                otherStatus: l.otherIssue.status,
                otherId: l.otherIssue.id,
            })), [
                { key: "linkId", header: "Link ID" },
                { key: "type", header: "Type" },
                { key: "dir", header: "Dir" },
                { key: "otherTitle", header: "Other Issue", width: 40 },
                { key: "otherStatus", header: "Status" },
                { key: "otherId", header: "Other ID" },
            ]);
        }
    });
    // ===========================================================
    // pulse link add <issueKeyOrId> <targetKeyOrId> <type>
    // ===========================================================
    linkCmd
        .command("add <issueKeyOrId> <targetKeyOrId> <type>")
        .description("Add a link between two issues (type: RELATED | BLOCKS | BLOCKED_BY)")
        .action(async (sourceRef, targetRef, typeArg) => {
        // Validate type before any network call
        const type = typeArg.toUpperCase();
        if (!VALID_LINK_TYPES.includes(type)) {
            throw new Error(`Invalid link type "${typeArg}". Must be one of: ${VALID_LINK_TYPES.join(", ")}`);
        }
        // Resolve target to cuid id
        const targetId = await resolveIssueId(ctx.client, targetRef);
        const link = await ctx.client.post(`/api/issues/${encodeURIComponent(sourceRef)}/links`, { targetId, type });
        if (ctx.json) {
            printJson(link);
        }
        else {
            ok(`Linked ${sourceRef} → ${targetRef} (${type})`);
        }
    });
    // ===========================================================
    // pulse link remove <issueKeyOrId> <linkId> [--yes]
    // ===========================================================
    linkCmd
        .command("remove <issueKeyOrId> <linkId>")
        .description("Remove a link from an issue (irreversible)")
        .option("--yes", "Skip confirmation prompt")
        .action(async (ref, linkId, opts) => {
        if (ctx.json && !opts.yes) {
            throw new Error("Refusing to remove without --yes in --json mode");
        }
        if (!opts.yes && !ctx.json) {
            const confirmed = await promptConfirm(`Remove link ${linkId}?`);
            if (!confirmed) {
                info("Aborted.");
                return;
            }
        }
        const result = await ctx.client.del(`/api/issues/${encodeURIComponent(ref)}/links/${linkId}`);
        if (ctx.json) {
            printJson({ ok: true, message: result.message });
        }
        else {
            ok(`Removed link ${linkId}`);
        }
    });
}
