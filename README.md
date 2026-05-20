# PulseCLI

A scriptable HTTP command-line interface for [Atlas Pulse](https://github.com/megi199123/atlas) — the task tracker built for Atlas ERP. PulseCLI is a fast alternative to the web UI for power users, automation scripts, and AI agents. Every command supports `--json` for machine-readable output.

---

## What it is

PulseCLI wraps the Atlas Pulse REST API so you can manage issues, attachments, links, and comments from any terminal or script. Its primary design goal is AI-agent compatibility: structured `--json` output on every command, no interactive prompts unless needed, and consistent error codes.

---

## Requirements

- **Node.js 18 or later** (tested on v22). Uses built-in `fetch`, `FormData`, and `File` — no Axios or similar runtime dependency.

---

## Install

```bash
npm install
npm run build
```

After building, run via:

```bash
node dist/index.js <command>
```

### Optional: global `pulse` alias

```bash
npm link
pulse <command>
```

After `npm link`, `pulse` is available anywhere in your shell.

### Development (no build step)

```bash
npm run dev -- <command> [options]
# e.g.
npm run dev -- issues list --status OPEN
```

---

## Configuration

### Set the base URL

```bash
pulse config set-url http://localhost:3000     # local dev
pulse config set-url https://your-railway-app.up.railway.app
```

Or set the environment variable (takes precedence over stored config):

```bash
PULSE_BASE_URL=http://localhost:3000 pulse issues list
```

Or override per-invocation with the global `--base` flag:

```bash
pulse --base https://your-railway-app.up.railway.app issues list --status OPEN
```

Configuration is stored at `~/.pulse-cli/config.json`.

### Local dev defaults

- Base URL: `http://localhost:3000`
- Seed admin credentials: `admin@pulse.local` / `admin123`

---

## Authentication

### Login

```bash
pulse login --email admin@pulse.local --password admin123
```

Or use environment variables (useful for CI/scripts):

```bash
PULSE_EMAIL=admin@pulse.local PULSE_PASSWORD=admin123 pulse login
```

Or omit the flags for an interactive prompt.

### Check current session

```bash
pulse whoami
```

### Logout

```bash
pulse logout
```

---

## The `--json` flag

Every command accepts a global `--json` flag. In JSON mode:

- **stdout** contains only valid JSON (a single object or array). Safe to pipe directly to `jq` or any JSON parser.
- Human-readable messages (tables, status lines) are suppressed.
- Destructive operations (`delete`, `remove`) require `--yes` — the CLI refuses to prompt interactively in JSON mode.

```bash
# Human output
pulse issues list --status OPEN

# Machine / agent output
pulse --json issues list --status OPEN | jq '.[].key'
```

---

## Command Reference

### Config

```bash
pulse config set-url <url>          # store the base URL
pulse config show                   # print current config (no secrets)
```

---

### Auth

```bash
pulse login [--email <e>] [--password <p>]
pulse whoami
pulse logout
```

---

### Issues — list

```bash
# All open issues
pulse issues list --status OPEN

# Bugs, high priority, assigned to "Karl"
pulse issues list --category BUG --priority HIGH --assignee Karl

# Overdue + unassigned
pulse issues list --overdue --unassigned

# Full-text search, JSON output
pulse --json issues list --search "railway deploy" | jq '.[].key'

# Available filters:
#   --category TASK|BUG
#   --priority LOW|MEDIUM|HIGH|CRITICAL
#   --status OPEN|IN_PROGRESS|STAGING|RESOLVED|CLOSED
#   --module <MODULE>
#   --assignee <id or name>
#   --reporter <id or name>
#   --search <text>
#   --label <id or name>
#   --milestone <id>
#   --sprint <id>
#   --limit <n>
#   --overdue
#   --stale
#   --has-attachments
#   --has-comments
#   --has-links
#   --unassigned
#   --sprint-none
```

---

### Issue — view / create / edit / delete

```bash
# View full detail (attachments, comments, links, activity)
pulse issue view PULSE-0001
pulse --json issue view PULSE-0001

# Create
pulse issue create \
  --title "Fix login redirect" \
  --description "Users are redirected to 404 after OAuth." \
  --category BUG \
  --priority HIGH \
  --assignee Karl

# Create with description from file
pulse issue create \
  --title "Refactor HR module" \
  --description-file ./description.md \
  --category TASK

# Edit — only specified fields are changed
pulse issue edit PULSE-0001 --status IN_PROGRESS
pulse issue edit PULSE-0001 --priority CRITICAL --assignee Jose

# Clear a nullable field with an empty string
pulse issue edit PULSE-0001 --assignee ""      # unassign
pulse issue edit PULSE-0001 --due ""           # clear due date
pulse issue edit PULSE-0001 --module ""        # clear module

# Set due date (YYYY-MM-DD)
pulse issue edit PULSE-0001 --due 2026-06-15

# Delete (prompts for confirmation)
pulse issue delete PULSE-0001
pulse issue delete PULSE-0001 --yes            # skip prompt
pulse --json issue delete PULSE-0001 --yes     # json mode requires --yes
```

---

### Users and Labels

```bash
# List all users (id + name)
pulse users list
pulse --json users list

# List all labels
pulse labels list
pulse --json labels list
```

---

### Attachments

```bash
# List attachments for an issue
pulse attachment list PULSE-0001
pulse --json attachment list PULSE-0001

# Upload a file
pulse attachment add PULSE-0001 ./report.pdf
pulse --json attachment add PULSE-0001 ./screenshot.png

# Download — server filename used by default
pulse attachment download <attachmentId>

# Download to a specific path
pulse attachment download <attachmentId> --out ./local-copy.pdf
pulse --json attachment download <attachmentId> --out ./local-copy.pdf

# Remove (prompts for confirmation)
pulse attachment remove <attachmentId>
pulse attachment remove <attachmentId> --yes
pulse --json attachment remove <attachmentId> --yes
```

Allowed file types (server-enforced; CLI warns on mismatch):
`.txt .log .ps1 .py .sql .md .csv .pdf .doc .docx .xls .xlsx .ppt .pptx .zip .rar .jpg .jpeg .png .gif .webp .svg`

Maximum size: **10 MB** (server-enforced; CLI warns if exceeded).

---

### Links

```bash
# List links for an issue
pulse link list PULSE-0001
pulse --json link list PULSE-0001

# Add a link — type must be RELATED, BLOCKS, or BLOCKED_BY
pulse link add PULSE-0001 PULSE-0002 BLOCKS
pulse link add PULSE-0001 PULSE-0003 RELATED
pulse --json link add PULSE-0001 PULSE-0002 BLOCKS

# Remove a link (prompts for confirmation)
pulse link remove PULSE-0001 <linkId>
pulse link remove PULSE-0001 <linkId> --yes
pulse --json link remove PULSE-0001 <linkId> --yes
```

**Link types:**

| Type | Meaning |
|------|---------|
| `RELATED` | Loosely related issues |
| `BLOCKS` | Source issue blocks the target |
| `BLOCKED_BY` | Source issue is blocked by the target |

---

### Comments

```bash
# List comments for an issue
pulse comment list PULSE-0001
pulse --json comment list PULSE-0001

# Add a comment — inline text
pulse comment add PULSE-0001 "Deployed fix to staging, awaiting QA sign-off."

# Add a comment — from file (useful for long comments)
pulse comment add PULSE-0001 --file ./notes.md
pulse --json comment add PULSE-0001 "LGTM" 
```

---

## Using PulseCLI as an AI agent

PulseCLI is designed as a first-class tool for AI agents:

- Always pass `--json` so the agent gets structured output with no noise.
- **Issue references** accept either the human key (`PULSE-0001`) or the raw cuid (`cm...`). Attachments, links, and comments resolve keys automatically via `resolveIssueId` before hitting the API.
- **Attachment/link/comment IDs** (returned by list commands) are cuids — pass them directly to download/remove/link-remove.
- **Destructive operations** in JSON mode always require `--yes`. This is intentional: prevents accidental deletes in automated pipelines.
- **Error handling**: API errors surface via non-zero exit codes and JSON `{"error":"..."}` on stderr (via `printError`).

**Example agent workflow — attach a generated report to an issue:**

```bash
# 1. Create the issue
KEY=$(pulse --json issue create --title "Deploy report" --description "Auto" --category TASK | jq -r '.key')

# 2. Attach a generated file
pulse --json attachment add "$KEY" ./deploy-report.pdf

# 3. Mark in-progress
pulse --json issue edit "$KEY" --status IN_PROGRESS --yes
```

---

## Targeting local vs Railway

Switch targets per-invocation without changing stored config:

```bash
# Query Railway production
pulse --base https://your-app.up.railway.app --json issues list --status OPEN

# Query local dev simultaneously
pulse --json issues list --status OPEN
```

The `--base` flag keeps the session ephemeral — it does not overwrite the stored base URL or mix session cookies.
