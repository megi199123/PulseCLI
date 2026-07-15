// ============================================================
// PulseCLI — src/cli/prompt.ts
// Interactive readline prompts shared by CLI commands.
// WRITES TO STDOUT — must NOT be imported by core/ or mcp/.
// ============================================================

import * as readline from "node:readline";
import { Writable } from "node:stream";

/** Prompt for visible input via readline. */
export function promptVisible(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for hidden (password) input.
 * Mutes stdout output during typing by using a no-op Writable as the rl output.
 * Restores newline after the user presses Enter.
 * Falls back to visible input when stdin is not a TTY (pipe/CI).
 */
export function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Non-interactive: read from pipe visibly
    return promptVisible(question);
  }
  return new Promise((resolve) => {
    process.stdout.write(question);

    // Muted writable: accepts writes but prints nothing
    const muted = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    });

    rl.once("line", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

/** Yes/no confirmation prompt. Empty answer takes the default. */
export async function promptConfirm(
  question: string,
  def = true,
): Promise<boolean> {
  const suffix = def ? " [Y/n]: " : " [y/N]: ";
  const answer = (await promptVisible(question + suffix)).trim().toLowerCase();
  if (!answer) return def;
  return answer.startsWith("y");
}
