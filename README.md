# PulseCLI

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-8A2BE2)](#mcp-server-pulse-mcp)
[![Output](https://img.shields.io/badge/output-%2D%2Djson-2EA043)](#the---json-flag)
[![API](https://img.shields.io/badge/API-Atlas%20Pulse-E11D48)](#what-it-is)

Two ways to drive [Atlas Pulse](https://github.com/megi199123/atlas) — the task tracker built for Atlas ERP — without the web UI:

- **`pulse-mcp` — an MCP server** (start here for AI agents). An MCP-aware client such as Claude Code spawns it and calls Pulse as native tools: search issues, read full detail, resolve lookups, attach code references. See [MCP server](#mcp-server-pulse-mcp).
- **`pulse` — a scriptable CLI** (optional) for terminals, scripts, and CI, with `--json` on every command. See [CLI quick start](#cli-quick-start).

Both share one HTTP/auth core (`src/core/`) and talk to the same deployed Pulse.

---

## What it is

PulseCLI wraps the Atlas Pulse REST API and ships **two interfaces over one shared core** (`src/core/`):

- **`pulse-mcp` — an MCP server.** The primary path for AI agents: an MCP-aware client spawns it and calls Pulse as native tools, with no shell-outs to parse. Read-first, with an opt-in write scope for attaching code references. Jump to [MCP server](#mcp-server-pulse-mcp).
- **`pulse` — a CLI** (optional) for terminals, scripts, and CI. Structured `--json` on every command, no interactive prompts unless needed, consistent exit codes.

Both authenticate the same way — a bearer token (preferred) or a saved cookie session — against the same deployed Pulse.

---

## MCP server (`pulse-mcp`)

`pulse-mcp` is an MCP (Model Context Protocol) **stdio** server — the
recommended way for AI agents to use Pulse. An MCP-aware client (e.g. Claude
Code) spawns it and calls Pulse directly as typed tools, instead of shelling
out to the `pulse` binary and parsing its text output. It shares all of its
HTTP/auth plumbing with the CLI via `src/core/`.

### Tools

The stdio `pulse-mcp` server — and the HTTP gateway described below — expose
**29 tools**: 5 read/report tools plus 24 write tools. Every write tool is
permission-gated by the calling token's scopes ∩ the user's Pulse role, and
requires a Pulse deployment whose API routes accept Personal Access Token auth
for writes (older deployments return the API's 401/403 text instead).

#### Read & report tools

| Tool | Purpose |
|------|---------|
| `pulse_search_issues` | Filter/search issues by status, priority, category, module, assignee, text, milestone, or sprint. Results are compacted to key fields and capped at 200. RELEASED-milestone issues are hidden unless `includeReleased: true` (or a `milestone` filter) is passed — same rule as `pulse issues list`. |
| `pulse_get_issue` | Full detail for one issue by key or id — attachments, comments, links, activity, codeRefs. Description HTML is stripped to plain text. |
| `pulse_list_lookups` | Reference data for resolving filter/create values: `modules`, `users`, `labels`, `milestones`, or `sprints`. |
| `pulse_code_refs_report` | Flat code-reference report across all issues (joined with issue key/status/assignee/module), filterable by date range/provider/repo, for KPI-style joins. Flags `truncated: true` at the server's 1000-row cap. |
| `pulse_add_code_ref` | Attach a PR/MR/commit URL to an issue. API errors (403 missing scope, 400 unparseable URL, 409 duplicate) come back as the tool's result text, not a tool failure — read it to see why. |

#### Write tools — issues

| Tool | Purpose |
|------|---------|
| `pulse_update_issue` | Update fields on an existing issue — title, description, category, status, priority, module, assignee, milestone, sprint, due/dev/EUS dates. Does **not** set labels (use `pulse_set_issue_labels`); module cannot be cleared, only reassigned. |
| `pulse_create_issue` | Create a new issue (`title`/`description`/`category` required). New issues always start at `BACKLOG` — there is **no `status` field on create**; move it afterward with `pulse_update_issue`. |
| `pulse_add_comment` | Add a comment to an issue — plain text is auto-wrapped in `<p>`, or pass Tiptap HTML directly. |
| `pulse_set_issue_labels` | Replace an issue's full label set. This is a full REPLACE, not additive — pass `[]` to clear all labels. |
| `pulse_link_issues` | Link two issues (`RELATED`, `BLOCKS`, `BLOCKED_BY`, `DUPLICATES`, `DUPLICATED_BY`). |
| `pulse_unlink_issue` | Remove a link from an issue by link id. |
| `pulse_set_assignee` | Set or clear an issue's assignee via the dedicated assignment endpoint (gated on `ISSUE_ASSIGN`, separate from general edit permission). Pass `""` to unassign. |
| `pulse_watch_issue` | Subscribe the authenticated user/token to an issue's notifications. Idempotent. |
| `pulse_unwatch_issue` | Unsubscribe from an issue's notifications. Idempotent. |
| `pulse_move_issue` | Move an issue to a different module, re-homing it under a new key prefix (the old key stops resolving); optionally reassigns the reporter in the same call. |

#### Write tools — planning

| Tool | Purpose |
|------|---------|
| `pulse_create_milestone` | Create a milestone (`name`/`targetDate`/`module` required). Status defaults to `PLANNED`; EUS lead defaults to the authenticated user. |
| `pulse_update_milestone` | Update milestone fields. `targetDate` and `module` cannot be cleared, only reassigned; `labels` is a full REPLACE. |
| `pulse_delete_milestone` | Delete a milestone permanently. Issues/sprints referencing it are **not** deleted — their `milestoneId` is cleared. |
| `pulse_create_sprint` | Create a sprint (`name`/`startDate`/`endDate` required; `module`/`milestone` optional). |
| `pulse_update_sprint` | Update sprint fields. `startDate`/`endDate` cannot be cleared, only reassigned; `labels` is a full REPLACE. |
| `pulse_delete_sprint` | Delete a sprint permanently. Issues referencing it are **not** deleted — their `sprintId` is cleared. |
| `pulse_add_sprint_issues` | Add one or more issues to a sprint. The underlying Pulse API takes one ticket per call, so this tool loops per issue and returns a **per-issue result** — one failure doesn't abort the batch. A `BACKLOG` issue added to a sprint is auto-promoted to `OPEN`. |
| `pulse_remove_sprint_issue` | Remove a single issue from a sprint (clears its `sprintId`; the issue itself is untouched). |
| `pulse_create_module` | Create a module (admin-level config, not a project entity). Requires `slug`, `label`, `inkHex`, `tintHex`, **and `prefix`** (the issue-key prefix, e.g. `PULSE`) — all five are mandatory. |
| `pulse_update_module` | Update module fields (label/colors/prefix/sortOrder/isActive/isDefault/status). `slug` itself is not patchable. |
| `pulse_delete_module` | Delete a module. Blocked with 409 if any issue, milestone, or sprint still references it. |

#### Write tools — misc

| Tool | Purpose |
|------|---------|
| `pulse_create_feedback` | Submit product feedback (feature request / bug / nice-to-have) — a lighter-weight surface than a full issue. |
| `pulse_start_standup` | Start a new daily-standup session for a date, paging through enabled modules. |
| `pulse_set_standup_notes` | Write (overwrite) the free-text "diary" notes on a standup session page. Auth-only, but needs a Pulse server whose notes route accepts token auth, or expect 401/404. |
| `pulse_get_changelog` | Fetch the Pulse product changelog via `/api/changelog` — needs a Pulse server that has the companion write-endpoints applied, or expect a 404. |

> **Most write tools are permission-gated.** Each checks the calling token's
> scopes against the user's role for that specific action (e.g.
> `ISSUE_EDIT_OWN`/`ISSUE_EDIT_ANY`, `ISSUE_ASSIGN`, `ISSUE_CREATE`,
> `COMMENT_CREATE`, `MILESTONE_MANAGE`, `SPRINT_MANAGE`, `MODULE_MANAGE`,
> `FEEDBACK_CREATE`, `STANDUP_MANAGE`). The exceptions are issue **links**
> (`pulse_link_issues`/`pulse_unlink_issue`) and **watch/unwatch**
> (`pulse_watch_issue`/`pulse_unwatch_issue`), which the current backend gates
> on authentication only — any valid token may call them. When a gated action
> isn't allowed, the Pulse API's `Forbidden`-style message comes back as the
> tool's result text, not a tool failure — read it to see why.

### Install in 3 steps

There is nothing to deploy — `pulse-mcp` is a **local adapter**. Your MCP
client spawns it on demand, it translates tool calls into HTTP against the
already-deployed Pulse, and it exits with the session. All you need is
**Node.js 18+** (and the `claude` CLI if you register with Claude Code).

**1. Install** — one command; no git, no clone, no build (`dist/` ships
prebuilt in the repo):

```bash
npm install -g https://github.com/megi199123/PulseCLI/archive/refs/heads/main.tar.gz
```

This puts `pulse-mcp` (and the optional `pulse` CLI) on your PATH.

> **Shortcut:** after step 1, run `pulse mcp setup` — an interactive wizard that
> does steps 2–3 for you: it logs you in, mints a scoped token, stores it where
> `pulse-mcp` finds it, and registers the server with Claude Code. The manual
> steps 2–3 below are the fallback if you'd rather not use the wizard.

**2. Mint a token** — in Pulse, go to **Settings → API Tokens → New Token**.
Leave scopes unchecked for a read-only token, or tick `CODE_REF_WRITE` if the
agent should attach PR/commit links to issues. Copy the `pulse_pat_…` string
now — it is shown **once**.

**3. Register with Claude Code:**

```bash
claude mcp add --scope user pulse \
  -e PULSE_BASE_URL=https://pulse.example.com \
  -e PULSE_TOKEN=pulse_pat_your_token_here \
  -- pulse-mcp
```

(Other MCP clients: spawn the `pulse-mcp` command with those two env vars —
same thing.)

Done. Start a **new** Claude Code session (servers spawn at session start),
run `/mcp` to confirm `pulse` is listed, then ask something like *"what are my
open Pulse issues?"*.

- **Upgrade:** re-run the step-1 command — it always installs the latest `main`;
  the registration doesn't change.
- **Rotate a token:** edit the `PULSE_TOKEN` value in `~/.claude.json`
  (Windows: `C:\Users\<you>\.claude.json`) and start a new session.
- **Never commit or share a token.** Mint one per person — tokens are scoped
  to your own role and revocable from the same Settings page (revocation takes
  effect on the token's very next request).

<details>
<summary>Alternative installs (contributors, or if the one-liner fails)</summary>

Clone + link — the from-source path; still no build step since `dist/` is
committed:

```bash
git clone https://github.com/megi199123/PulseCLI.git
cd PulseCLI
npm install       # runtime deps only; dist/ is already built
npm link          # puts `pulse` and `pulse-mcp` on your PATH
```

Avoid `npm install -g git+https://github.com/megi199123/PulseCLI.git` — npm's
git-dependency codepath is unreliable on some setups (notably Node 24 + npm 11
on Windows) and can leave a broken install whose bins error with
`Cannot find module …/dist/index.js`. The tarball install in step 1 uses a
different npm codepath and does not have this problem.

If `pulse-mcp` somehow isn't on your PATH, register the entry point directly:
`-- node "<path>/dist/mcp/index.js"` (`npm root -g` prints the global root).
On Windows use forward slashes or escape backslashes — a mangled path is the
most common cause of "failed to connect".

Contributor note: because `dist/` is committed, run `npm run build` and commit
the result whenever you change `src/` — otherwise installs ship stale output.
</details>

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
      "env": { "PULSE_BASE_URL": "http://localhost:3000" }
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

### Remote MCP for claude.ai (`pulse-mcp-gateway`)

`pulse-mcp` above is a **local adapter** — an MCP client spawns it as a child
process, so it only works where that's possible (Claude Code, Claude Desktop).
Claude web (claude.ai) can't spawn a process; it connects to MCP servers
**remotely** over HTTP via custom connectors. For that, PulseCLI ships a
second, independent entry point — `src/mcp-http/index.ts` →
`dist/mcp-http/index.js` — a small stateless gateway that speaks the MCP
**streamable-HTTP** transport and serves the exact same tools (read + write),
built per-request from the caller's own Pulse API token. It reuses the tool
logic from `src/mcp/tools.ts`: no Pulse changes, no duplicated tool code.

Every request to `/mcp` reads `Authorization: Bearer pulse_pat_…`, builds a
fresh, non-persisting `PulseClient` from that token, and forwards tool calls
through it — no session, no shared state, no config on disk. A token can never
do more than it is scoped for, because the gateway is a pass-through and Pulse
enforces scopes on every request.

**Deploy it** (one-time, manual — the gateway is not hosted by default):

1. Railway → New Service → Deploy from GitHub repo → pick this repo + branch.
2. Set `PULSE_BASE_URL` on the service (your Pulse instance). `PORT` is
   injected by Railway automatically.
3. `railway.json` supplies the build command, start command
   (`node dist/mcp-http/index.js`), and healthcheck path (`/healthz`).
4. Once the healthcheck is green, note the public URL.

**Connect from claude.ai:** mint a personal API token (Settings → API Tokens),
then in claude.ai → **Settings → Connectors → Add custom connector**, set the
URL to `https://<your-service>.up.railway.app/mcp`, and under **Advanced →
Request headers** add `Authorization: Bearer pulse_pat_your_token_here`. Save,
and claude.ai lists all of PulseCLI's MCP tools (whether a given write tool
succeeds still depends on the token's scopes and the Pulse deployment).

> **Auth is lazy by design.** The gateway makes no Pulse call during
> `initialize`, so a bad/revoked token still handshakes; the token is exercised
> on the first `tools/call`, where an invalid token surfaces as Pulse's 401 in
> the tool result (fails closed, just later than you might expect). The gateway
> never stores or logs tokens.

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

## CLI quick start

The CLI is **optional** — if you only use the MCP server, you can stop reading
here. It covers the write operations the MCP server doesn't (create/edit
issues, comments, attachments, links) for terminals, scripts, and CI.

```bash
# 1. Install (same one-liner as the MCP server — you already have `pulse`
#    on your PATH if you followed the MCP install above)
npm install -g https://github.com/megi199123/PulseCLI/archive/refs/heads/main.tar.gz

# 2. Point at a Pulse instance and log in
pulse config set-url http://localhost:3000
pulse login --email you@example.com --password '<your-password>'

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

## Running from source (contributors)

Only needed when developing PulseCLI itself — users should install with the
one-liner in the [MCP install](#install-in-3-steps) instead.

```bash
git clone https://github.com/megi199123/PulseCLI.git
cd PulseCLI
npm install
npm link          # exposes `pulse` and `pulse-mcp` globally from this clone
```

`dist/` is committed, so nothing needs building until you change `src/` —
then run `npm run build` and commit the result (installs ship whatever is in
`dist/`).

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
- Seed admin credentials: whatever your Pulse database seed creates

---

## Authentication

### Login

```bash
pulse login --email you@example.com --password '<your-password>'
```

Or use environment variables (useful for CI/scripts):

```bash
PULSE_EMAIL=you@example.com PULSE_PASSWORD='<your-password>' pulse login
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

## Targeting local vs Railway

Switch targets per-invocation without changing stored config:

```bash
# Query Railway production
pulse --base https://your-app.up.railway.app --json issues list --status OPEN

# Query local dev simultaneously
pulse --json issues list --status OPEN
```

The `--base` flag keeps the session ephemeral — it does not overwrite the stored base URL or mix session cookies.
