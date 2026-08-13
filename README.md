# ideavault-mcp

A personal MCP server that turns this machine's project folders into an Obsidian
vault of ideas, with a few scoped external-research tools, a structural
code-graph, and ops automation (service health, Bedrock version checks, and
two-way Telegram control) alongside it. One Express endpoint, no upstream LLM
calls from the server itself — Claude (via Claude Code, Claude.ai, or the
Claude mobile app) reads and writes the vault and calls these external
services directly through the tools.

Vault lives at `~/ideavault/Projects/*.md` — open that folder directly in Obsidian.

**Architecture note:** the code-graph tools aren't implemented here — they're
[codebase-memory](codebase-memory) (a Python/SQLite/tree-sitter engine, its
own repo history preserved via `git subtree` when it was folded in here)
spawned as a persistent child process at startup and proxied in over
MCP's stdio client transport (`src/codebaseMemory.ts`). One external MCP
surface, one systemd service, one auth boundary — but two independent engines
behind it, so neither codebase had to be rewritten in the other's language to
merge them. If the child process connection drops, the whole server exits
(`process.exit(1)`) rather than silently running vault-only, so systemd's
`Restart=on-failure` brings both back up together instead of masking a real
crash. **Don't also run codebase-memory as its own separate stdio MCP server**
(e.g. via `claude mcp add`) alongside this — both would open the same SQLite
DB file concurrently, which risks lock contention.

## Tools

**Vault (repos + notes)**

| Tool | What it does |
|---|---|
| `list_repos` | Scans `REPOS_DIR` (default: home dir), detects stack (node/python/rust/go/dotnet), flags which repos already have a note |
| `list_repo_files` | Lists files/folders inside a repo so Claude can decide what to read before writing a note. Skips node_modules/.git/etc and secret-looking files |
| `read_repo_file` | Reads a text file's contents (README, source, config) from inside a repo. Refuses binaries and anything matching a secret/key-file pattern. Capped at 200KB |
| `write_repo_file` | Creates/overwrites a file inside a repo. If the repo has no `.git` yet, runs `git init` + a snapshot commit first. Doesn't commit its own change — review with `git diff` |
| `edit_repo_file` | Precise search-replace on an existing file — `old_string` must match exactly once. Same guardrails and git safety net as `write_repo_file` |
| `get_idea` | Reads one repo's note (frontmatter + body) |
| `upsert_idea` | Creates/updates a note — status, tags, blockers, next_steps, body. Omitted fields keep their old value |
| `append_log` | Appends a dated line to a note's `## Log` section |
| `list_ideas` | Lists all notes, filterable by `status` or `tag` |
| `search_notes` | Full-text search across the vault |

Note frontmatter: `repo, status (idea/in-progress/blocked/done/abandoned), tags[], blockers[], next_steps[], created, updated`.

**External research** (scoped, not a general web-fetch tool)

| Tool | What it does | Needs |
|---|---|---|
| `solana_get_mint_info` | On-chain mint info (supply, decimals, authorities) via public RPC | nothing |
| `solana_get_token_price` | Price/liquidity via Jupiter's price API (v3) | nothing |
| `package_registry_search` | crates.io fuzzy search, or PyPI exact-name lookup (no public PyPI search API exists) | nothing |
| `github_search_code` | Search public GitHub code for reference implementations | `GITHUB_TOKEN` in `.env` |
| `telegram_bot_info` | A bot's public info via Telegram's `getMe` — token never leaves the server | `TELEGRAM_BOT_TOKEN_<NAME>` in `.env` per bot |
| `telegram_send_message` | Send a plain-text message via a bot you control — e.g. notify yourself | `TELEGRAM_BOT_TOKEN_<NAME>` in `.env`; `chat_id` param or `TELEGRAM_CHAT_ID_<NAME>` in `.env` |
| `fetch_docs` | Fetches page text, restricted to an allowlist: docs.rs, pypi.org, solana.com, jup.ag, github.com, raw.githubusercontent.com, telegram.org | nothing |

**Code graph** (proxied from [codebase-memory](codebase-memory), read the
architecture note above)

| Tool | What it does |
|---|---|
| `index_repository` | Index (or re-index) a local repo into the graph via tree-sitter — call once per project before the others |
| `list_projects` | List every indexed project with file/symbol counts |
| `search_symbols` | Find functions/methods/classes by name substring |
| `get_symbol_overview` | One call for "show me this function and what touches it" — source + callers + callees |
| `get_code_snippet` | Just one function's source by qualified name, without reading the whole file |
| `trace_calls` | Walk the call graph around a symbol (callers/callees/both, 1-10 hops) |
| `get_architecture` | Language breakdown, symbol counts, top folders, hotspot files — orient in an unfamiliar repo |
| `detect_changes` | Map uncommitted git changes to the symbols they touched, plus a rough blast-radius (caller count) |
| `project_graph` | A capped snapshot of a project's whole call graph — highest-degree symbols and the edges among them, for an overview rather than one symbol's trace. Powers the Graph UI's dashboard |

7 languages: C#, Python, JS, TS/TSX, Rust, Go, Bash. `project` is optional on every
query tool except `index_repository` — omit it and the last project named
anywhere on this server is reused. Note this "last project" state now lives
in the one shared codebase-memory child process behind this HTTP server
rather than a stdio process per Claude Code session (its original design) —
fine for one person using one project at a time, but a second concurrent
caller working on a different repo will get the first caller's active
project if it omits `project` too. Pass `project` explicitly to avoid
relying on this. See codebase-memory's own docstring (`server.py`) for the
full scope/limitations (name-based call resolution, no type inference, no
cross-repo graph).

## Graph UI

A small visual dashboard for the code graph, served by this same process —
open `https://ideavault.app-me.online/` (or `http://127.0.0.1:3007/` locally)
in a browser instead of going through chat. Source in `web/` (Vite + React +
TypeScript + Tailwind + Cytoscape.js), built to static files and served via
`express.static`.

- **Dashboard** — `get_architecture` as language/symbol-kind charts, top
  folders, hotspot files.
- **Search** — `search_symbols`, click a result to open it in Graph view.
- **Graph** — `trace_calls` rendered as an actual node/edge graph (callers,
  callees, or both; depth 1-4), with the selected symbol's source
  (`get_code_snippet`) alongside it.
- **Changes** — `detect_changes`: uncommitted edits mapped to the symbols
  they touched, with the existing caller-count risk heuristic.

It talks to a handful of new read-only JSON routes under `/api/graph/*`
(`src/graphApi.ts`) that wrap the same proxied codebase-memory tool calls the
MCP surface uses — no second engine, no direct SQLite access from the UI.
Those routes sit behind the same `rateLimit` → `validateOrigin` →
`requireToken` chain as `/mcp`. The static page itself is unauthenticated
(it's just HTML/JS/CSS); on first load it prompts for `AUTH_TOKEN` and stores
it in `localStorage`, sending it as `Authorization: Bearer` on every API
call — same token as everywhere else, no second credential.

## Ops automation

Three pieces, all reporting to one Telegram chat (`NOTIFY_TELEGRAM_BOT_TOKEN`
/ `NOTIFY_TELEGRAM_CHAT_ID` in `.env`) kept deliberately separate from any
product bot's token, so ops alerts don't land somewhere end users can see
them.

**Service health watchdog** (`deploy/service-watchdog.sh`, a systemd timer
every 5 minutes, read-only — never restarts anything) checks every service
on this box two ways: is its port actually listening, not just is the unit
"active" (a service can be active while restart-looping or with nothing
bound), and has its restart count grown since the last check. Only state
*transitions* page Telegram — newly broken, or newly recovered — so a
service stuck down doesn't re-alert every 5 minutes. Covers bedrock-server,
chatbot-app2, sift, sift-analytics, driverupdaterserver, namecheap-ddns, and
ideavault-mcp itself.

**Bedrock version checker** (`deploy/bedrock-update-check.sh`, a daily
systemd timer) checks Mojang's official download API against the version
`bedrock-server.service` is currently running. On a new release it downloads
the zip and sends the exact `migrate-bedrock-server.sh` command to run —
deliberately notify-only, not auto-applying, since that migration script has
never been exercised against a real update yet.

**Two-way Bedrock allowlist control** (`src/bedrockControl.ts`, in-process —
this one needs a persistent connection rather than a periodic check, so it
runs inside the Node server rather than as a standalone script) long-polls
the same Telegram chat for `allowlist add <name>` / `allowlist remove <name>`
and injects the corresponding command into the running server's `screen`
console, replying with what the server actually logged. Also sends a
notification on every player connect. **Security:** every inbound message is
checked against `NOTIFY_TELEGRAM_CHAT_ID` before anything is actioned — this
executes real commands against a live server with real players on it, so
that check is hardcoded, not configurable away.

## Local dev

```bash
npm install
cp .env.example .env   # edit AUTH_TOKEN at minimum
npm run build && npm start
# or: npm run dev   (tsx watch, no build step — but the UI needs its own build below)
```

`npm run build` builds both the server and the web UI (`build:web` runs
`npm --prefix web run build`, needs `cd web && npm install` once first). For
UI-only iteration with hot reload: `cd web && npm install && npm run dev` —
its dev server proxies `/api` to `127.0.0.1:3007`, so run the main server
(`npm run dev` at the repo root) alongside it.

Smoke test:

```bash
curl http://127.0.0.1:3007/health

curl -X POST http://127.0.0.1:3007/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Deploy (this machine, following the existing app-me.online pattern)

Port **3007** is used here since 3000-3003/3005/3006 are already taken by
app1-4/sift/muse (see `../NGINX.md`).

1. `npm run build`
2. Fill in `.env` (real `AUTH_TOKEN` — generate with `openssl rand -hex 32`)
3. Install the systemd unit:
   ```bash
   sudo cp deploy/ideavault-mcp.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now ideavault-mcp
   ```
4. Add the nginx server block (`deploy/nginx-ideavault.conf`) next to your other
   `app-me.online` blocks, then `certbot --nginx -d ideavault.app-me.online`.

**Status: already deployed.** Live at `https://ideavault.app-me.online`, systemd
service running, DNS auto-synced by the existing `namecheap-ddns` timer (it
discovers hosts straight from nginx `server_name` directives — no config
changes needed there), cert auto-renews via certbot's timer.

## Connect Claude to it

**Claude Code** (this machine or any other):
```bash
claude mcp add --transport http ideavault https://ideavault.app-me.online/mcp \
  --header "Authorization: Bearer <your AUTH_TOKEN>"
```

**Claude Desktop / Claude.ai / Claude mobile app**: custom connector URL entry
(Settings → Connectors → Add custom connector) only showed up on claude.ai in a
browser, not in the native mobile app UI — add it there and it syncs to mobile
since connectors are account-level. The connector UI has no field for a static
bearer header, so the token goes in the URL instead:
```
https://ideavault.app-me.online/mcp?token=<your AUTH_TOKEN>
```
The server checks `Authorization: Bearer`, `X-Vault-Token`, and `?token=` —
whichever the client can send. Once added, it still needs to be toggled on
per-conversation from the tools/connectors icon in the chat composer.

## Security notes (personal-use tradeoffs, read before exposing to the internet)

- Auth is a single static shared secret, not OAuth. Fine for a personal tool
  used by one person, but anyone who gets the token gets full read/write on
  your vault **and every repo's code** (write_repo_file/edit_repo_file are not
  read-only). Treat the token like a password — this is the highest-stakes
  tool on the connector.
- `write_repo_file`/`edit_repo_file` never run `git commit`/`git push` for the
  actual change — only a one-time snapshot commit if a repo had no `.git` at
  all, to guarantee an undo path. Everything after that is a plain working-tree
  edit: review with `git diff` / `git status` and commit yourself. Repos that
  already had uncommitted changes before an edit get flagged (`hadPriorChanges`)
  rather than silently folded in.
- `POST /mcp` is rate-limited to 60 req/min per client IP (`src/rateLimit.ts`,
  in-memory fixed window). Express is set to `trust proxy: loopback` so this
  keys on the real client IP from nginx's `X-Forwarded-For`, not nginx's own
  loopback address for every request.
- The nginx site (`deploy/nginx-ideavault.conf`) has `access_log off` — the
  token travels as `?token=...` for clients with no header field, and nginx's
  default log format would otherwise write that in plaintext to
  `/var/log/nginx/access.log` on every request.
- The systemd unit (`deploy/ideavault-mcp.service`) drops all Linux
  capabilities and blocks kernel/namespace/cgroup access
  (`NoNewPrivileges`, `ProtectKernelTunables`, `RestrictNamespaces`, etc.) —
  standard hardening for a plain Node HTTP server, shrinks what a
  hypothetical RCE (e.g. a compromised npm dependency) could reach.
  Filesystem sandboxing (`ProtectHome`/`ProtectSystem`) is deliberately
  *not* used since the app's whole job is read/write across the home directory.
- If you want more isolation than "public subdomain + secret token," put this
  behind Tailscale instead of the public nginx route and skip the token
  entirely — probably the better long-term answer for a homelab tool like this.
- `Origin` header is checked against `ALLOWED_ORIGINS` (default `https://claude.ai`)
  only when the header is present — non-browser clients (curl, Claude Code) don't
  send one, so they're unaffected.
- Rotate `AUTH_TOKEN` (`openssl rand -hex 32`, update `.env`, `sudo systemctl
  restart ideavault-mcp`) any time it's been displayed somewhere it shouldn't
  live long-term — e.g. pasted into a chat transcript.
- `read_repo_file`/`list_repo_files` refuse dotfiles, `.env*`, `*.pem`/`*.key`,
  `id_rsa`/`id_ed25519`, and filenames that look like secrets/credentials/wallet
  keypairs (several of these repos hold Solana keypairs as plain JSON). It's a
  filename-pattern blocklist, not content scanning — good enough for a personal
  tool, not a substitute for actually keeping keys out of these directories.
- The Graph UI stores `AUTH_TOKEN` in the browser's `localStorage` after you
  enter it once — same token as everywhere else, so anyone with it still has
  full read/write, not just graph-read access. `/api/graph/*` is read-only,
  but the token itself isn't scoped down for the browser. Fine on a device
  you trust; don't paste the token into that prompt on a shared machine.
- A pre-commit hook (`.githooks/pre-commit`, active via `core.hooksPath`)
  blocks commits that look like they contain a real secret — a staged `.env`
  file under any name other than `.env.example`, private key headers, or
  common token/key formats (AWS, GitHub, Slack, Google, JWT). Scoped to added
  lines only, so it doesn't flag pre-existing content in touched files. A
  fresh clone needs `git config core.hooksPath .githooks` once to enable it.

## Roadmap ideas (not built yet)

- Bulk-seed notes for every repo in `list_repos` that has `hasNote: false`
- A `build-mcp-app` widget for browsing/filtering ideas visually in chat
- Swap the static token for OAuth (CIMD) if this ever needs to support more
  than one person
