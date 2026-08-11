const TIMEOUT_MS = 10_000;

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}

// --- Solana -----------------------------------------------------------------

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export async function getSolanaMintInfo(mint: string): Promise<unknown> {
  const res = await fetch(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [mint, { encoding: "jsonParsed" }],
    }),
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`Solana RPC returned ${res.status}`);
  const json = (await res.json()) as { result?: { value?: unknown } };
  const value = json.result?.value;
  if (!value) return { found: false, note: `No account found for ${mint}` };
  return value;
}

export async function getSolanaTokenPrice(mint: string): Promise<unknown> {
  const url = `https://api.jup.ag/price/v3?ids=${encodeURIComponent(mint)}`;
  const res = await fetch(url, { signal: timeoutSignal() });
  if (!res.ok) throw new Error(`Jupiter price API returned ${res.status}`);
  return res.json();
}

// --- Package registries -------------------------------------------------

export async function searchPackageRegistry(query: string, registry: "crates" | "pypi"): Promise<unknown> {
  if (registry === "crates") {
    const url = `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=10`;
    const res = await fetch(url, {
      headers: { "user-agent": "ideavault-mcp (personal tool; contact via GitHub)" },
      signal: timeoutSignal(),
    });
    if (!res.ok) throw new Error(`crates.io returned ${res.status}`);
    const json = (await res.json()) as { crates?: unknown[] };
    return json.crates ?? [];
  }
  // PyPI has no public search API (disabled in 2018) — best effort is an exact-name lookup.
  const url = `https://pypi.org/pypi/${encodeURIComponent(query)}/json`;
  const res = await fetch(url, { signal: timeoutSignal() });
  if (res.status === 404) {
    return {
      found: false,
      note: "PyPI has no public search API (removed 2018). Try the exact package name, or search pypi.org/search in a browser.",
    };
  }
  if (!res.ok) throw new Error(`PyPI returned ${res.status}`);
  const json = (await res.json()) as { info?: { name?: string; summary?: string; version?: string; home_page?: string } };
  return { found: true, ...json.info };
}

// --- GitHub code search ---------------------------------------------------

export async function searchGithubCode(query: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN not configured. Generate a classic personal access token (no special scopes needed for public code search) " +
        "at github.com -> Settings -> Developer settings -> Personal access tokens, then add GITHUB_TOKEN=... to ideavault-mcp/.env and restart the service.",
    );
  }
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=10`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "ideavault-mcp",
    },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`GitHub code search returned ${res.status}`);
  const json = (await res.json()) as { items?: unknown[] };
  return json.items ?? [];
}

// --- Telegram bot info / send ----------------------------------------------

function telegramEnvSuffix(botName: string): string {
  return botName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function requireBotToken(botName: string): string {
  const envKey = `TELEGRAM_BOT_TOKEN_${telegramEnvSuffix(botName)}`;
  const token = process.env[envKey];
  if (!token) {
    throw new Error(
      `${envKey} not configured. Copy that bot's token from its own repo's .env into ideavault-mcp/.env as ${envKey}=..., then restart the service.`,
    );
  }
  return token;
}

export async function getTelegramBotInfo(botName: string): Promise<unknown> {
  const token = requireBotToken(botName);
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: timeoutSignal() });
  } catch {
    throw new Error("Failed to reach Telegram API (network error).");
  }
  if (!res.ok) throw new Error(`Telegram API returned ${res.status}`);
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(json.description ?? "Telegram API call failed");
  return json.result;
}

export async function sendTelegramMessage(botName: string, text: string, chatId?: string): Promise<unknown> {
  const token = requireBotToken(botName);
  const chatIdEnvKey = `TELEGRAM_CHAT_ID_${telegramEnvSuffix(botName)}`;
  const targetChatId = chatId ?? process.env[chatIdEnvKey];
  if (!targetChatId) {
    throw new Error(
      `No chat_id given and ${chatIdEnvKey} isn't set in .env. Message the bot once from the target chat, then ` +
        `read the numeric chat id off https://api.telegram.org/bot<token>/getUpdates, or pass chat_id explicitly.`,
    );
  }
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: targetChatId, text, disable_web_page_preview: true }),
      signal: timeoutSignal(),
    });
  } catch {
    throw new Error("Failed to reach Telegram API (network error).");
  }
  if (!res.ok) throw new Error(`Telegram API returned ${res.status}`);
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(json.description ?? "Telegram API call failed");
  return json.result;
}

// --- Allowlisted docs fetch --------------------------------------------

const ALLOWED_DOC_HOSTS = ["docs.rs", "pypi.org", "solana.com", "jup.ag", "github.com", "raw.githubusercontent.com", "telegram.org", "core.telegram.org"];

function isAllowedDocHost(hostname: string): boolean {
  return ALLOWED_DOC_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

const MAX_FETCH_BYTES = 150_000;

export async function fetchDocs(rawUrl: string): Promise<{ url: string; content: string; truncated: boolean }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:") throw new Error("Only https:// URLs are allowed");
  if (!isAllowedDocHost(url.hostname)) {
    throw new Error(`Host '${url.hostname}' is not on the allowlist (${ALLOWED_DOC_HOSTS.join(", ")})`);
  }
  const res = await fetch(url, { signal: timeoutSignal(), headers: { "user-agent": "ideavault-mcp" } });
  if (!res.ok) throw new Error(`Fetch returned ${res.status}`);
  let text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("html")) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  const truncated = text.length > MAX_FETCH_BYTES;
  return { url: url.toString(), content: truncated ? text.slice(0, MAX_FETCH_BYTES) : text, truncated };
}
