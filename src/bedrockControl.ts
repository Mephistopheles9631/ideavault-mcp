// Two-way bridge between the ops Telegram channel and the live Bedrock
// server: long-polls Telegram for inbound "allowlist add/remove <name>"
// commands and injects them into the server's screen console, and tails
// console.log to notify on player connects. Lives inside this process
// (rather than a standalone script like service-watchdog.sh) because it
// needs a persistent long-poll connection, not a periodic check.
//
// Security: every inbound Telegram update is checked against
// NOTIFY_TELEGRAM_CHAT_ID before anything is actioned. This executes real
// console commands against a live server with real players on it -- that
// check is not optional, and there is deliberately no way to configure it
// away.
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";

const execFileP = promisify(execFile);

const BOT_TOKEN = process.env.NOTIFY_TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.NOTIFY_TELEGRAM_CHAT_ID;
const SCREEN_SESSION = "minecraft";
const STATE_DIR = path.join(process.env.HOME ?? "/home/mephisto", ".cache/ideavault-watchdog");
const OFFSET_FILE = path.join(STATE_DIR, "telegram-update-offset");

// Bedrock gamertags are short and alphanumeric-ish; this is deliberately
// generous but still refuses anything that isn't plausibly a gamertag --
// defense in depth against injecting control characters into the console,
// even though only the already-authenticated owner chat can reach this.
const NAME_RE = /^[A-Za-z0-9_ ]{1,32}$/;

function consoleLogPath(): string | null {
  try {
    const workdir = execFileSync("systemctl", ["show", "-p", "WorkingDirectory", "--value", "bedrock-server.service"])
      .toString()
      .trim();
    return workdir ? path.join(workdir, "console.log") : null;
  } catch {
    return null;
  }
}

async function sendTelegram(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[bedrockControl] failed to notify Telegram:", err);
  }
}

function readOffset(): number {
  try {
    return Number(fs.readFileSync(OFFSET_FILE, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

function writeOffset(offset: number): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(OFFSET_FILE, String(offset));
}

async function sendConsoleCommand(command: string): Promise<void> {
  await execFileP("screen", ["-S", SCREEN_SESSION, "-X", "stuff", `${command}\r`]);
}

// Reads console.log's tail shortly after sending a command, looking for the
// line that command produces, so the Telegram reply reflects what the
// server actually did rather than just "command sent".
async function readRecentConsoleLines(count: number): Promise<string[]> {
  const logPath = consoleLogPath();
  if (!logPath) return [];
  try {
    const { stdout } = await execFileP("tail", ["-n", String(count), logPath]);
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function handleAllowlistCommand(action: "add" | "remove", name: string): Promise<void> {
  if (!NAME_RE.test(name)) {
    await sendTelegram(`⚠️ "${name}" doesn't look like a valid gamertag (letters/numbers/underscore/spaces only, 1-32 chars) — not sending anything to the server.`);
    return;
  }
  await sendConsoleCommand(`allowlist ${action} ${name}`);
  const expected = action === "add" ? `Added ${name} to the allowlist` : `Removed ${name} from the allowlist`;
  // Console round-trip latency varies (observed anywhere from ~1s to several
  // seconds) -- poll rather than trust a single fixed delay.
  let recent: string[] = [];
  let confirmed = false;
  for (let i = 0; i < 10 && !confirmed; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    recent = await readRecentConsoleLines(5);
    confirmed = recent.some((line) => line.includes(expected));
  }
  if (confirmed) {
    await sendTelegram(`✅ ${expected}`);
  } else {
    await sendTelegram(
      `⚠️ Sent "allowlist ${action} ${name}" but didn't see the expected confirmation in the console log. Recent lines:\n${recent.slice(-3).join("\n") || "(none)"}`,
    );
  }
}

async function handleTelegramMessage(text: string): Promise<void> {
  const trimmed = text.trim().replace(/^\//, "");
  const match = trimmed.match(/^allowlist\s+(add|remove)\s+(.+)$/i);
  if (match) {
    const [, action, name] = match;
    await handleAllowlistCommand(action.toLowerCase() as "add" | "remove", name.trim());
    return;
  }
  if (/^help$/i.test(trimmed)) {
    await sendTelegram(
      "Commands:\nallowlist add <name>\nallowlist remove <name>\n\n(you'll also get a notification here whenever a player connects)",
    );
    return;
  }
  // Anything else from the owner chat is silently ignored rather than
  // erroring -- this channel also carries watchdog/update-check alerts,
  // which aren't commands.
}

async function pollTelegramOnce(offset: number): Promise<number> {
  // A shorter long-poll window than Telegram's usual 30-50s -- something on
  // this network path kills outbound connections held idle for ~30s+
  // (observed as ETIMEDOUT), so polling more often but each hold shorter
  // avoids that instead of fighting it.
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=10&allowed_updates=["message"]`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`Telegram getUpdates returned ${res.status}`);
  const json = (await res.json()) as {
    ok: boolean;
    result: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }>;
  };
  if (!json.ok) throw new Error("Telegram getUpdates call failed");

  let nextOffset = offset;
  for (const update of json.result) {
    nextOffset = update.update_id + 1;
    const msg = update.message;
    if (!msg?.text) continue;
    if (String(msg.chat.id) !== CHAT_ID) {
      console.warn(`[bedrockControl] ignoring message from unauthorized chat_id ${msg.chat.id}`);
      continue;
    }
    await handleTelegramMessage(msg.text);
  }
  return nextOffset;
}

async function runTelegramListener(): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("[bedrockControl] NOTIFY_TELEGRAM_BOT_TOKEN/CHAT_ID not set, allowlist control disabled");
    return;
  }
  let offset = readOffset();
  console.log("[bedrockControl] Telegram listener started");
  for (;;) {
    try {
      const nextOffset = await pollTelegramOnce(offset);
      if (nextOffset !== offset) {
        offset = nextOffset;
        writeOffset(offset);
      }
    } catch (err) {
      console.error("[bedrockControl] poll error, retrying in 5s:", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function runConsoleLogTail(): void {
  const logPath = consoleLogPath();
  if (!logPath) {
    console.log("[bedrockControl] could not resolve console.log path, connect notifications disabled");
    return;
  }
  const tail = spawn("tail", ["-F", "-n", "0", logPath]);
  const rl = createInterface({ input: tail.stdout });
  rl.on("line", (line) => {
    const connected = line.match(/Player connected: (.+), xuid: (\d+)/);
    if (connected) {
      void sendTelegram(`🎮 ${connected[1]} connected`);
    }
  });
  tail.on("exit", (code) => {
    console.error(`[bedrockControl] tail on ${logPath} exited (${code}), restarting in 5s`);
    setTimeout(runConsoleLogTail, 5000);
  });
}

export function startBedrockControl(): void {
  void runTelegramListener();
  runConsoleLogTail();
}
