// ============================================================
// PulseCLI — src/core/lookups.ts
// Name→id resolution helpers used by CLI commands and (in future) MCP tools.
// Commander-free, stdout-free.
// ============================================================
// ---- Cuid heuristic ----
// Cuids start with "c" and are ~25 lowercase alphanumeric characters.
// Values containing a space, or not matching this pattern, are treated as names.
function looksLikeCuid(s) {
    return /^c[a-z0-9]{20,}$/i.test(s) && !s.includes(" ");
}
// ---- Name→id resolution helpers ----
/**
 * Resolve a user value that may be a cuid OR a display name.
 * - If it already looks like a cuid, returns it as-is.
 * - Otherwise, fetches /api/users and does a case-insensitive exact name match.
 * - Throws if no match or multiple matches.
 */
export async function resolveUserId(client, value) {
    if (looksLikeCuid(value))
        return value;
    const users = await client.get("/api/users");
    const lower = value.toLowerCase();
    const matches = users.filter((u) => u.name.toLowerCase() === lower);
    if (matches.length === 0) {
        throw new Error(`No user found with name "${value}". Use --assignee with a user id or exact display name.`);
    }
    if (matches.length > 1) {
        const ids = matches.map((u) => `${u.name} (${u.id})`).join(", ");
        throw new Error(`Multiple users match name "${value}": ${ids}. Use the cuid id instead.`);
    }
    return matches[0].id;
}
/**
 * Resolve a label value that may be a cuid OR a label name.
 * - If it already looks like a cuid, returns it as-is.
 * - Otherwise, fetches /api/labels and does a case-insensitive exact name match.
 * - Throws if no match or multiple matches.
 */
export async function resolveLabelId(client, value) {
    if (looksLikeCuid(value))
        return value;
    const labels = await client.get("/api/labels");
    const lower = value.toLowerCase();
    const matches = labels.filter((l) => l.name.toLowerCase() === lower);
    if (matches.length === 0) {
        throw new Error(`No label found with name "${value}". Use --label with a label id or exact label name.`);
    }
    if (matches.length > 1) {
        const ids = matches.map((l) => `${l.name} (${l.id})`).join(", ");
        throw new Error(`Multiple labels match name "${value}": ${ids}. Use the cuid id instead.`);
    }
    return matches[0].id;
}
/**
 * Validate & canonicalize a module value against the active, DB-driven modules.
 * Modules are no longer an enum — `/api/modules` is the source of truth.
 * - Input is matched case-insensitively against module slug (and label as a
 *   convenience), and the canonical UPPERCASE slug is returned.
 * - Throws with the list of valid slugs if there's no match, so the user never
 *   has to guess. (The API would also reject an invalid slug, but this gives a
 *   far more useful error before the round trip.)
 */
export async function resolveModuleSlug(client, value) {
    const modules = await client.get("/api/modules");
    const lower = value.trim().toLowerCase();
    const match = modules.find((m) => m.slug.toLowerCase() === lower || m.label.toLowerCase() === lower);
    if (!match) {
        const valid = modules
            .map((m) => m.slug)
            .sort()
            .join(", ");
        throw new Error(`Unknown module "${value}". Valid modules: ${valid || "(none configured)"}.`);
    }
    return match.slug;
}
