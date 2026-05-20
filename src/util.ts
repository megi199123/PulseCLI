// ============================================================
// PulseCLI — src/util.ts
// Shared utility helpers.
// ============================================================

import type { PulseClient } from "./client.js";
import type { IssueDetail } from "./types.js";

/**
 * Truncate a string to n characters, appending "…" when truncated.
 */
export function truncate(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/**
 * Format an ISO date string as "YYYY-MM-DD HH:mm".
 * Returns empty string for null/undefined input.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  } catch {
    return iso;
  }
}

/**
 * Returns true if the string looks like an issue key (e.g. PULSE-0001).
 */
export function looksLikeKey(s: string): boolean {
  return /^[A-Z]+-\d+$/i.test(s);
}

/**
 * Resolve an issue key-or-cuid to its cuid id.
 * Always fetches the issue via the API to validate existence and get the id.
 */
export async function resolveIssueId(
  client: PulseClient,
  ref: string,
): Promise<string> {
  const issue = await client.get<IssueDetail>(`/api/issues/${encodeURIComponent(ref)}`);
  return issue.id;
}

/**
 * Strip basic HTML tags from a string (for table display).
 * Handles common entities: &amp; &lt; &gt; &nbsp; &quot; &#39;
 */
export function stripHtml(s: string): string {
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

/**
 * Parse a due date input string (YYYY-MM-DD or full ISO) into an ISO 8601
 * datetime string. Appends T00:00:00.000Z for date-only inputs.
 * Returns empty string for empty/falsy input.
 */
export function parseDueDate(input: string): string {
  if (!input.trim()) return "";
  // Date-only: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    return `${input.trim()}T00:00:00.000Z`;
  }
  // Already has time component — validate and return as-is
  const d = new Date(input.trim());
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: "${input}". Use YYYY-MM-DD or ISO 8601 format.`);
  }
  return d.toISOString();
}
