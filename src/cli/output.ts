// ============================================================
// PulseCLI — src/cli/output.ts
// Zero-dependency output formatting: tables, JSON, errors.
// WRITES TO STDOUT — must NOT be imported by core/ or mcp/.
// ============================================================

import { PulseApiError } from "../core/client.js";
import { truncate } from "../core/util.js";

// ---- JSON mode flag ----

let _jsonMode = false;

export function setJsonMode(b: boolean): void {
  _jsonMode = b;
}

export function getJsonMode(): boolean {
  return _jsonMode;
}

// ---- JSON output ----

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// ---- Table output ----

export interface TableColumn {
  key: string;
  header: string;
  /** Optional max display width (cells truncated with … if over) */
  width?: number;
}

export function printTable(
  rows: Record<string, unknown>[],
  columns: TableColumn[],
): void {
  if (rows.length === 0) {
    console.log("No results.");
    return;
  }

  // Compute effective column widths
  const widths: number[] = columns.map((col) => {
    const headerLen = col.header.length;
    const maxCellLen = rows.reduce((max, row) => {
      const cell = formatCell(row[col.key]);
      return Math.max(max, cell.length);
    }, 0);
    const natural = Math.max(headerLen, maxCellLen);
    return col.width !== undefined ? Math.min(natural, col.width) : natural;
  });

  // Header row
  const header = columns
    .map((col, i) => padEnd(col.header, widths[i] ?? col.header.length))
    .join("  ");
  console.log(header);

  // Separator
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  console.log(sep);

  // Data rows
  for (const row of rows) {
    const line = columns
      .map((col, i) => {
        const w = widths[i] ?? col.header.length;
        const cell = formatCell(row[col.key]);
        return padEnd(truncate(cell, w), w);
      })
      .join("  ");
    console.log(line);
  }
}

// ---- Error output ----

export function printError(err: unknown): void {
  process.exitCode = 1;
  let message = "Unknown error";
  let status: number | undefined;

  if (err instanceof PulseApiError) {
    message = err.message;
    status = err.status;
  } else if (err instanceof Error) {
    message = err.message;
  } else if (typeof err === "string") {
    message = err;
  }

  if (_jsonMode) {
    const payload: Record<string, unknown> = { error: message };
    if (status !== undefined) payload.status = status;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const statusPart = status !== undefined ? ` (HTTP ${status})` : "";
    process.stderr.write(`Error: ${message}${statusPart}\n`);
  }
}

// ---- Informational output ----

/** Print a success message. Suppressed in JSON mode. */
export function ok(msg: string): void {
  if (_jsonMode) return;
  console.log(msg);
}

/** Print an informational message. Suppressed in JSON mode. */
export function info(msg: string): void {
  if (_jsonMode) return;
  console.log(msg);
}

// ---- Internal helpers ----

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function padEnd(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}
