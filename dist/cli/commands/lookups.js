// ============================================================
// PulseCLI — src/cli/commands/lookups.ts
// Commands: users list, labels list, modules list
// Name→id resolution helpers used by issues.ts live in ../../core/lookups.js
// ============================================================
import { printJson, printTable } from "../output.js";
// ---- Registrar ----
export function register(program, ctx) {
    // ---- pulse users list ----
    const usersCmd = program
        .command("users")
        .description("User lookup commands");
    usersCmd
        .command("list")
        .description("List all users")
        .action(async () => {
        const users = await ctx.client.get("/api/users");
        if (ctx.json) {
            printJson(users);
        }
        else {
            printTable(users.map((u) => ({ id: u.id, name: u.name })), [
                { key: "id", header: "ID" },
                { key: "name", header: "Name" },
            ]);
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
        const labels = await ctx.client.get("/api/labels");
        if (ctx.json) {
            printJson(labels);
        }
        else {
            printTable(labels.map((l) => ({ id: l.id, name: l.name, color: l.color })), [
                { key: "id", header: "ID" },
                { key: "name", header: "Name" },
                { key: "color", header: "Color" },
            ]);
        }
    });
    // ---- pulse modules list ----
    // Modules are DB-driven now; this is how you discover valid `--module` slugs.
    const modulesCmd = program
        .command("modules")
        .description("Module lookup commands");
    modulesCmd
        .command("list")
        .description("List active modules (valid values for --module)")
        .action(async () => {
        const modules = await ctx.client.get("/api/modules");
        if (ctx.json) {
            printJson(modules);
        }
        else {
            printTable(modules.map((m) => ({
                slug: m.slug,
                label: m.label,
                prefix: m.prefix,
                open: m.openIssues,
                total: m.totalIssues,
            })), [
                { key: "slug", header: "Slug" },
                { key: "label", header: "Label" },
                { key: "prefix", header: "Prefix" },
                { key: "open", header: "Open" },
                { key: "total", header: "Total" },
            ]);
        }
    });
}
