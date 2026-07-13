# PulseCLI

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![CLI](https://img.shields.io/badge/CLI-commander-5B5B5B)](https://github.com/tj/commander.js)
[![Output](https://img.shields.io/badge/output-%2D%2Djson-2EA043)](#the---json-flag)
[![API](https://img.shields.io/badge/API-Atlas%20Pulse-E11D48)](#what-it-is)

A scriptable HTTP command-line interface for [Atlas Pulse](https://github.com/megi199123/atlas) — the task tracker built for Atlas ERP. PulseCLI is a fast alternative to the web UI for power users, automation scripts, and AI agents. Every command supports `--json` for machine-readable output.

---

## Quick start

```bash
# 1. Build and (optionally) expose the global `pulse` command
npm install && npm run build && npm link

# 2. Point at a Pulse instance and log in
pulse config set-url http://localhost:3000
pulse login --email admin@pulse.local --password admin123

# 3. Read
pulse issues list --status OPEN --limit 10        # human-readable table
pulse --json issues list --status OPEN | jq '.[].key'   # agent / scripts
pulse issue view PULSE-0001

# 4. Write
pulse issue create --title "Fix login redirect" \
  --description "404 after OAuth callback" --category BUG --priority HIGH
pulse issue edit PULSE-0001 --status IN_PROGRESS --assignee Karl
pulse comment add PULSE-0001 "Deployed fix to staging, awaiting QA."
pulse attachment add PULSE-0001 ./report.pdf
pulse link add PULSE-0001 PULSE-0002 BLOCKS
```

> New here? Jump to [Configuration](#configuration), [Authentication](#authentication),
> or the full [Command Reference](#command-reference).

---

## What it is

PulseCLI wraps the Atlas Pulse REST API so you can manage issues, attachments, links, and comments from any terminal or script. Its primary design goal is AI-agent compatibility: structured `--json` output on every command, no interactive prompts unless needed, and consistent error codes.

---

## Requirements

- **Node.js 18 or later** (tested on v22). Uses built-in `fetch`, `FormData`, and `File` — no Axios or similar runtime dependency.

---

## Source layout

```
src/
  core/     Pulse API client (cookie jar + bearer auth), config, auth flow,
            the typed contract mirror, lookups — framework-agnostic; never
            imports commander or the mcp SDK
  cli/      commander program + command registrars (src/cli/commands/*.ts)
            — this is the `pulse` bin
  mcp/      MCP stdio server (src/mcp/index.ts, src/mcp/tools.ts)
            — this is the `pulse-mcp` bin
```

`core/` never imports from `cli/` or `mcp/`; both `cli/` and `mcp/` depend on
`core/` but never on each other. `npm run build` (plain `tsc`, `rootDir: src`)
emits 1:1 to `dist/` — `src/x/y.ts` becomes `dist/x/y.js`.

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

### Isolated sessions (`PULSE_CONFIG_DIR`)

Set `PULSE_CONFIG_DIR` to keep a deployment's session (base URL + cookies + user)
in its own folder instead of `~/.pulse-cli`. This lets you run multiple installs
side by side without them clobbering each other's login — for example a local-dev
install authenticated as `admin`, and a separate live install authenticated as
your own user:

```bash
PULSE_CONFIG_DIR=C:\Workspace\Tools\pulsecli\state pulse whoami
```

A launcher script can set this automatically (see the live deployment's
`pulse.cmd` / `pulse.ps1`, which point `PULSE_CONFIG_DIR` at their own `state/`).

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
pulse config get                    # print current config (no secrets)
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

# Issues in RELEASED milestones are hidden by default — opt in explicitly
pulse issues list --include-released
pulse issues list --milestone <id>   # also reveals RELEASED-milestone issues for that milestone

# Available filters:
#   --category TASK|BUG
#   --priority LOW|MEDIUM|HIGH|CRITICAL
#   --status BACKLOG|OPEN|IN_PROGRESS|STAGING|IN_REVIEW|RESOLVED|CLOSED
#   --module <slug>   (see `pulse modules list` for valid slugs)
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
#   --include-released   (include issues in RELEASED milestones; hidden by default)
```

> **Heads up:** `GET /api/issues` hides issues sitting in a RELEASED milestone
> unless `--include-released` is passed (or a `--milestone` filter narrows to
> one milestone). Omitting it silently undercounts — always pass it for
> sweeps/reports that need a complete picture.

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

# Create directly into a specific status — omitting --status yields BACKLOG,
# the server default (matches what the web UI does on a bare "new issue")
pulse issue create \
  --title "Spike: evaluate X" \
  --description "..." \
  --category TASK \
  --status OPEN

# Edit — only specified fields are changed
pulse issue edit PULSE-0001 --status IN_PROGRESS
pulse issue edit PULSE-0001 --priority CRITICAL --assignee Jose

# Clear a nullable field with an empty string
pulse issue edit PULSE-0001 --assignee ""      # unassign
pulse issue edit PULSE-0001 --due ""           # clear due date
# Note: --module cannot be cleared (modules are NOT NULL) — reassign instead, see below

# Set due date (YYYY-MM-DD)
pulse issue edit PULSE-0001 --due 2026-06-15

# Phase scheduling — Development and EUS Testing each have their own window
# (shown as the Dev / EUS Test rows in `issue view`). Empty string clears, like --due.
pulse issue edit PULSE-0001 --dev-start 2026-06-10 --dev-due 2026-06-14
pulse issue edit PULSE-0001 --eus-start 2026-06-15 --eus-due 2026-06-18
pulse issue edit PULSE-0001 --dev-due ""        # clear a phase date

# Reassign the module (DB-driven slug; cannot be cleared — modules are NOT NULL)
pulse issue edit PULSE-0001 --module CLEARING_HOUSE

# Delete (prompts for confirmation)
pulse issue delete PULSE-0001
pulse issue delete PULSE-0001 --yes            # skip prompt
pulse --json issue delete PULSE-0001 --yes     # json mode requires --yes
```

---

### Users, Labels, and Modules

```bash
# List all users (id + name)
pulse users list
pulse --json users list

# List all labels
pulse labels list
pulse --json labels list

# List active modules — the valid slugs for --module on list/create/edit.
# Modules are DB-driven (no longer a fixed enum), so this is the source of truth.
pulse modules list
pulse --json modules list
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

### Code References

Link PRs, MRs, and commits to issues (`code-ref`), and pull a flat cross-issue
report for KPI-style joins.

```bash
# List code references on an issue
pulse code-ref list PULSE-0001
pulse --json code-ref list PULSE-0001

# Attach a PR/MR/commit URL — GitHub or GitLab
pulse code-ref add PULSE-0001 https://github.com/org/repo/pull/123
pulse code-ref add PULSE-0001 https://gitlab.com/org/repo/-/merge_requests/45 --title "Fix login redirect"
pulse --json code-ref add PULSE-0001 https://github.com/org/repo/commit/abc1234

# Remove (prompts for confirmation)
pulse code-ref rm PULSE-0001 <refId>
pulse code-ref rm PULSE-0001 <refId> --yes
pulse --json code-ref rm PULSE-0001 <refId> --yes

# Flat report across ALL issues — filterable by date range, provider, repo
pulse code-ref report
pulse code-ref report --from 2026-06-01 --to 2026-06-30
pulse code-ref report --provider GITHUB --repo org/repo
pulse --json code-ref report | jq '.[].issue.key'
```

The report endpoint is server-capped at 1000 rows (`take: 1000`); the CLI
prints a warning to stderr (never stdout, so `--json` piping stays clean)
when a response comes back exactly at that cap, since the true result set
may be larger — narrow `--from`/`--to` to be sure you have everything.

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

## MCP Server

PulseCLI also ships `pulse-mcp` — an MCP (Model Context Protocol) **stdio**
server, so an MCP-aware client (e.g. Claude Code) can call Pulse directly as
tools instead of shelling out to the `pulse` binary. It shares all of its
HTTP/auth plumbing with the CLI via `src/core/`.

### Tools

| Tool | Purpose |
|------|---------|
| `pulse_search_issues` | Filter/search issues by status, priority, category, module, assignee, text, milestone, or sprint. Results are compacted to key fields and capped at 200. RELEASED-milestone issues are hidden unless `includeReleased: true` (or a `milestone` filter) is passed — same rule as `pulse issues list`. |
| `pulse_get_issue` | Full detail for one issue by key or id — attachments, comments, links, activity, codeRefs. Description HTML is stripped to plain text. |
| `pulse_list_lookups` | Reference data for resolving filter/create values: `modules`, `users`, `labels`, `milestones`, or `sprints`. |
| `pulse_code_refs_report` | Flat code-reference report across all issues (joined with issue key/status/assignee/module), filterable by date range/provider/repo, for KPI-style joins. Flags `truncated: true` at the server's 1000-row cap. |
| `pulse_add_code_ref` | Attach a PR/MR/commit URL to an issue. API errors (403 missing scope, 400 unparseable URL, 409 duplicate) come back as the tool's result text, not a tool failure — read it to see why. |

### Install it (teammates start here)

There is nothing to deploy — `pulse-mcp` is a **local adapter**. Your MCP
client spawns it as a child process on demand, it translates tool calls into
HTTP against the already-deployed Pulse, and it exits with the session. So
"installing" means: get the binary on your machine, mint a token, register it.

**0. Get repo access** — this repository is **private**. Ask Jo to add you as
a collaborator first, and make sure `git` on your machine is authenticated to
GitHub as that account (e.g. `gh auth login`, or a credential manager that has
your GitHub login). Without access, the install below fails with a 404/auth
error at the clone step.

**1. Install.** The built `dist/` is committed, so no build step is needed
either way. Use the clone + link method — it is the reliable path on every
Node/npm version:

```bash
git clone https://github.com/megi199123/PulseCLI.git
cd PulseCLI
npm install       # runtime deps only; dist/ is already built
npm link          # puts `pulse` and `pulse-mcp` on your PATH
```

<details>
<summary>One-liner alternative (may fail on some Node/npm versions)</summary>

```bash
npm install -g git+https://github.com/megi199123/PulseCLI.git
```

Convenient, but npm's git-dependency install is unreliable on some setups
(notably Node 24 + npm 11 on Windows): it can leave a broken install whose
`pulse` bin errors with `Cannot find module …/dist/index.js`. If that happens,
`npm uninstall -g pulse-cli` and use the clone + link method above instead.
</details>

> Contributor note: because `dist/` is committed, run `npm run build` and
> commit the result whenever you change `src/` — otherwise installs ship stale
> output.

**2. Mint a token** — in Pulse, go to **Settings → API Tokens → New Token**.
Give it a name, then pick scopes: leave everything unchecked for a read-only
token, or use **Select all my permissions** to grant exactly what your role
already allows. Add `CODE_REF_WRITE` if the agent should attach PR/commit
links to issues. The `pulse_pat_…` string is shown **once** — copy it now.

**3. Register with Claude Code.** After `npm link`, the `pulse-mcp` bin is on
your PATH, so register it by name — no absolute path to get wrong:

```bash
claude mcp add --scope user pulse \
  -e PULSE_BASE_URL=https://pulse.isi.ph \
  -e PULSE_TOKEN=pulse_pat_your_token_here \
  -- pulse-mcp
```

Equivalent hand-edit: add the same `pulse` block to `mcpServers` in
`~/.claude.json` (Windows: `C:\Users\<you>\.claude.json`).

> If you installed some other way and `pulse-mcp` is not on your PATH, point
> the command at the entry point directly instead: `-- node
> "<path>/dist/mcp/index.js"` (`npm root -g` gives you `<npm-root>` for a
> global install). On Windows use forward slashes or escape backslashes — a
> mangled path is the most common cause of "failed to connect".

**4. Verify** — start a *new* Claude Code session (servers spawn at session
start), run `/mcp`, and confirm `pulse` is listed. Then ask it something like
*"what are my open Pulse issues?"*.

To upgrade later, `git pull` in your clone (the committed `dist/` updates with
it); the registration does not change. To update your token, edit the
`PULSE_TOKEN` value and restart the session.

> **Never commit or share a token.** Mint one per person — they are scoped to
> your own role and revocable from the same Settings page (revocation takes
> effect on the token's very next request).

### Registering it from the repo

A committed `.mcp.json` at the repo root registers the server for Claude Code
(and any other MCP client that reads that file) when a session starts inside
this repo. Useful when developing PulseCLI itself; teammates should prefer the
user-scoped registration above.

```json
{
  "mcpServers": {
    "pulse": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Workspace\\Git\\PulseCLI\\dist\\mcp\\index.js"],
      "env": { "PULSE_BASE_URL": "https://pulse.isi.ph" }
    }
  }
}
```

Build first (`npm run build`) — the entry point is `dist/mcp/index.js`, not
source. `.mcp.json` is committed, so it intentionally carries **no token** —
see Authentication below for how to supply one.

### Authentication

`pulse-mcp` picks auth in this order, same precedence the underlying
`PulseClient` applies everywhere:

1. **`PULSE_TOKEN` (bearer, preferred)** — if set in the server process's
   environment, every request sends `Authorization: Bearer <token>` and the
   session is never persisted to disk (no cookie-jar reads or writes). This
   is the right mode for a server registered via the committed `.mcp.json`:
   set `PULSE_TOKEN` in your own shell or MCP client's env config, never in
   the file itself.
2. **Cookie-jar fallback** — if `PULSE_TOKEN` is unset, `pulse-mcp` falls
   back to the session left behind by `pulse login` (`~/.pulse-cli` or
   `PULSE_CONFIG_DIR`), and that session's cookies ARE refreshed/persisted
   as usual. A startup diagnostic on stderr reports which mode is active
   (stdout is reserved for JSON-RPC, so this never corrupts the protocol).

> Tokens are minted from Pulse's **Settings → API Tokens** page. A token is
> bound to the deployment that issued it — a token minted on beta will not
> authenticate against production, so keep `PULSE_TOKEN` and `PULSE_BASE_URL`
> in step with each other.
>
> If you would rather not mint one, the cookie-jar fallback still works: run
> `pulse login` once against the target deployment (optionally under a
> dedicated `PULSE_CONFIG_DIR`), and `pulse-mcp` will pick up that session
> automatically.

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
