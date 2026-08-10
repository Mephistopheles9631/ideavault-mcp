import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { listRepos, listRepoFiles, readRepoFile, writeRepoFile, editRepoFile } from "./repos.js";
import { readIdea, upsertIdea, appendLog, listIdeas, searchNotes } from "./vault.js";
import { requireToken, validateOrigin } from "./auth.js";
import { rateLimit } from "./rateLimit.js";
import {
  getSolanaMintInfo,
  getSolanaTokenPrice,
  searchPackageRegistry,
  searchGithubCode,
  getTelegramBotInfo,
  fetchDocs,
} from "./external.js";
import { connectCodebaseMemory, getProxiedTools, callProxiedTool } from "./codebaseMemory.js";

const STATUS_VALUES = ["idea", "in-progress", "blocked", "done", "abandoned"] as const;

function mcpServer(): McpServer {
  const server = new McpServer(
    { name: "ideavault", version: "0.1.0" },
    {
      instructions:
        "Personal repo/idea tracker. Call list_repos to see what's on disk, get_idea to read a project's notes, " +
        "upsert_idea to create or update a note, append_log to add a dated journal line, list_ideas to browse by " +
        "status/tag, and search_notes for full-text search across the vault. Also includes codebase-memory's " +
        "structural code-graph tools (search_symbols, get_symbol_overview, get_code_snippet, trace_calls, " +
        "get_architecture, detect_changes, index_repository, list_projects) proxied in from a local engine -- " +
        "prefer those over Grep/Read for 'what calls X' / 'show me this function' style questions on indexed repos.",
    },
  );

  server.registerTool(
    "list_repos",
    {
      description: "List project directories on disk, with detected stack (node/python/rust/go/dotnet) and whether an idea note already exists for each.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const repos = await listRepos();
      return { content: [{ type: "text", text: JSON.stringify(repos, null, 2) }] };
    },
  );

  server.registerTool(
    "list_repo_files",
    {
      description:
        "List files/folders inside a repo (optionally under a subpath) so you can decide what to read before writing a note. " +
        "Skips node_modules/.git/build/etc. and dotfiles, and omits anything matching a secret/key-file pattern.",
      inputSchema: {
        repo: z.string(),
        subpath: z.string().optional().describe("Relative path inside the repo, e.g. 'src'. Omit for repo root."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, subpath }) => {
      const entries = await listRepoFiles(repo, subpath ?? "");
      return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
    },
  );

  server.registerTool(
    "read_repo_file",
    {
      description:
        "Read a text file's contents from inside a repo (e.g. README.md, package.json, a source file) to understand what the project does. " +
        "Refuses binary files and anything matching a secret/key-file pattern (.env, *.pem, wallet/keypair JSON, etc). Capped at 200KB.",
      inputSchema: {
        repo: z.string(),
        path: z.string().describe("Path relative to the repo root, e.g. 'README.md' or 'src/main.py'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, path: relPath }) => {
      const file = await readRepoFile(repo, relPath);
      return { content: [{ type: "text", text: JSON.stringify(file, null, 2) }] };
    },
  );

  server.registerTool(
    "write_repo_file",
    {
      description:
        "Create a new file or overwrite an existing one inside a repo. Refuses secret/key-file patterns and paths outside the repo. " +
        "If the repo has no .git yet, this runs `git init` + a snapshot commit first so the prior state isn't lost. " +
        "Does NOT commit the change itself — it lands as a working-tree edit for you to review with `git diff` and commit yourself. " +
        "Prefer edit_repo_file for small changes to existing files; use this for new files or full rewrites.",
      inputSchema: {
        repo: z.string(),
        path: z.string().describe("Path relative to the repo root, e.g. 'src/scorer.py'"),
        content: z.string().describe("Full file content"),
      },
    },
    async ({ repo, path: relPath, content }) => {
      const result = await writeRepoFile(repo, relPath, content);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "edit_repo_file",
    {
      description:
        "Make a precise in-place edit to an existing file inside a repo: old_string must appear exactly once in the file, and is replaced with new_string. " +
        "Errors if old_string isn't found or isn't unique — include enough surrounding context to make it unique. " +
        "Same secret-file/path guardrails and git safety net as write_repo_file. Doesn't commit — review with `git diff` yourself.",
      inputSchema: {
        repo: z.string(),
        path: z.string().describe("Path relative to the repo root"),
        old_string: z.string().describe("Exact text to replace — must be unique in the file"),
        new_string: z.string().describe("Replacement text"),
      },
    },
    async ({ repo, path: relPath, old_string, new_string }) => {
      const result = await editRepoFile(repo, relPath, old_string, new_string);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "get_idea",
    {
      description: "Read the idea note for a repo (frontmatter + body). Returns null if no note exists yet.",
      inputSchema: { repo: z.string().describe("Repo/directory name, e.g. 'anthropicagentinsolana'") },
      annotations: { readOnlyHint: true },
    },
    async ({ repo }) => {
      const idea = await readIdea(repo);
      return { content: [{ type: "text", text: JSON.stringify(idea, null, 2) }] };
    },
  );

  server.registerTool(
    "upsert_idea",
    {
      description:
        "Create or update the idea note for a repo. Only pass the fields you want to change — omitted fields keep their existing value.",
      inputSchema: {
        repo: z.string(),
        status: z.enum(STATUS_VALUES).optional(),
        tags: z.array(z.string()).optional(),
        blockers: z.array(z.string()).optional(),
        next_steps: z.array(z.string()).optional(),
        body: z.string().optional().describe("Full markdown body (replaces existing body if given)"),
      },
    },
    async ({ repo, status, tags, blockers, next_steps, body }) => {
      const idea = await upsertIdea(repo, { status, tags, blockers, next_steps, body });
      return { content: [{ type: "text", text: JSON.stringify(idea, null, 2) }] };
    },
  );

  server.registerTool(
    "append_log",
    {
      description: "Append a dated journal entry to a repo's idea note under its Log section. Creates the note if it doesn't exist.",
      inputSchema: { repo: z.string(), entry: z.string().describe("Short note, e.g. 'blocked on API token cost, revisit after rate limits improve'") },
    },
    async ({ repo, entry }) => {
      const idea = await appendLog(repo, entry);
      return { content: [{ type: "text", text: JSON.stringify(idea, null, 2) }] };
    },
  );

  server.registerTool(
    "list_ideas",
    {
      description: "List idea summaries across the whole vault, optionally filtered by status or tag.",
      inputSchema: {
        status: z.enum(STATUS_VALUES).optional(),
        tag: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, tag }) => {
      const ideas = await listIdeas({ status, tag });
      return { content: [{ type: "text", text: JSON.stringify(ideas, null, 2) }] };
    },
  );

  server.registerTool(
    "search_notes",
    {
      description: "Full-text search across all idea notes in the vault. Returns matching repos with a short snippet.",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const hits = await searchNotes(query);
      return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }] };
    },
  );

  server.registerTool(
    "solana_get_mint_info",
    {
      description: "Look up a Solana token mint's on-chain info (supply, decimals, mint/freeze authority) via a public RPC endpoint.",
      inputSchema: { mint: z.string().describe("Base58 mint address") },
      annotations: { readOnlyHint: true },
    },
    async ({ mint }) => {
      const info = await getSolanaMintInfo(mint);
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    },
  );

  server.registerTool(
    "solana_get_token_price",
    {
      description: "Look up a Solana token's current price/liquidity via Jupiter's public price API.",
      inputSchema: { mint: z.string().describe("Base58 mint address") },
      annotations: { readOnlyHint: true },
    },
    async ({ mint }) => {
      const price = await getSolanaTokenPrice(mint);
      return { content: [{ type: "text", text: JSON.stringify(price, null, 2) }] };
    },
  );

  server.registerTool(
    "package_registry_search",
    {
      description:
        "Search crates.io (fuzzy search) or look up an exact package name on PyPI (PyPI has no public search API, only exact-name lookup).",
      inputSchema: {
        query: z.string(),
        registry: z.enum(["crates", "pypi"]).default("crates"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, registry }) => {
      const results = await searchPackageRegistry(query, registry);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  server.registerTool(
    "github_search_code",
    {
      description:
        "Search public GitHub code for reference implementations. Requires GITHUB_TOKEN to be configured in the server's .env " +
        "(unauthenticated code search is not permitted by GitHub's API) — returns a clear setup error if missing.",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const results = await searchGithubCode(query);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  server.registerTool(
    "telegram_bot_info",
    {
      description:
        "Fetch a Telegram bot's public info (username, id, capabilities) via getMe. Requires that bot's token be configured server-side " +
        "as TELEGRAM_BOT_TOKEN_<NAME> in .env (copied once from that bot's own repo) — the token itself is never returned.",
      inputSchema: { bot_name: z.string().describe("e.g. 'alicetgbot', 'tggrowth' — matched against TELEGRAM_BOT_TOKEN_<NAME>") },
      annotations: { readOnlyHint: true },
    },
    async ({ bot_name }) => {
      const info = await getTelegramBotInfo(bot_name);
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    },
  );

  server.registerTool(
    "fetch_docs",
    {
      description:
        "Fetch a documentation page's text content. Restricted to an allowlist of doc hosts (docs.rs, pypi.org, solana.com, jup.ag, " +
        "github.com, raw.githubusercontent.com, telegram.org) — not a general-purpose URL fetcher.",
      inputSchema: { url: z.string().describe("Full https:// URL on an allowlisted host") },
      annotations: { readOnlyHint: true },
    },
    async ({ url }) => {
      const result = await fetchDocs(url);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  for (const tool of getProxiedTools()) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        const result = await callProxiedTool(tool.name, args);
        return result as { content: Array<{ type: "text"; text: string }> };
      },
    );
  }

  return server;
}

const app = express();
// We only ever receive connections from nginx on loopback, which appends a
// trustworthy X-Forwarded-For — needed so rate limiting keys on the real
// client IP instead of nginx's own loopback address for every request.
app.set("trust proxy", "loopback");
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/mcp", rateLimit, validateOrigin, requireToken, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  const server = mcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = Number(process.env.PORT ?? 3007);
await connectCodebaseMemory();
app.listen(port, "127.0.0.1", () => {
  console.log(`ideavault-mcp listening on 127.0.0.1:${port}`);
});
