// Two-way bridge between the ops Telegram channel and this box: long-polls
// Telegram for inbound commands -- "allowlist add/remove <name>" against
// the live Bedrock server's screen console, and "fix <unit>" to restart a
// monitored systemd service that service-watchdog.sh flagged as down -- and
// tails Bedrock's console.log to notify on player connects. Lives inside
// this process (rather than a standalone script like service-watchdog.sh)
// because it needs a persistent long-poll connection, not a periodic check;
// also means there's exactly one Telegram getUpdates poller for this bot,
// since a second independent poller would race with this one over the
// update offset.
//
// Security: every inbound Telegram update is checked against
// NOTIFY_TELEGRAM_CHAT_ID before anything is actioned. This executes real
// console commands against a live server with real players on it, and can
// restart real services -- that check is not optional, and there is
// deliberately no way to configure it away.
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Same file service-watchdog.sh reads for its SERVICES array -- one list
// gating which units a "/fix <unit>" Telegram reply may restart, instead of
// two hand-kept copies. A missing/malformed file disables /fix (empty set)
// rather than crashing this module, since allowlist control and connect
// notifications share it and shouldn't go down with it.
interface ServiceEntry {
  unit: string;
  proto: string;
  port: string;
}

function loadServices(): ServiceEntry[] {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "../deploy/services.json"), "utf8");
    return (JSON.parse(raw) as { services: ServiceEntry[] }).services;
  } catch (err) {
    console.error("[opsControl] failed to load deploy/services.json, /fix disabled:", err);
    return [];
  }
}

const SERVICES = loadServices();
const RESTARTABLE_UNITS = new Set(SERVICES.map((s) => s.unit));

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
    console.error("[opsControl] failed to notify Telegram:", err);
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

// TS port of service-watchdog.sh's per-unit health check (is-active + port
// listening, or is-failed for port-less oneshot units) -- used to confirm a
// /fix restart actually worked before replying.
async function unitIsActive(unit: string): Promise<boolean> {
  try {
    await execFileP("systemctl", ["is-active", "--quiet", unit]);
    return true;
  } catch {
    return false;
  }
}

async function unitIsFailed(unit: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("systemctl", ["is-failed", unit]);
    return stdout.trim() === "failed";
  } catch (err) {
    // systemctl exits non-zero for a "not failed" result, which rejects
    // this promise -- but the printed state (what we actually care about,
    // same as the bash script's approach) is still on the error object.
    const stdout = (err as NodeJS.ErrnoException & { stdout?: string }).stdout;
    return stdout?.trim() === "failed";
  }
}

async function portListening(proto: string, port: string): Promise<boolean> {
  try {
    const flag = proto === "udp" ? "-lun" : "-ltn";
    const { stdout } = await execFileP("ss", ["-H", flag, `sport = :${port}`]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function unitProbe(entry: ServiceEntry): Promise<boolean> {
  if (entry.port) {
    return (await unitIsActive(entry.unit)) && (await portListening(entry.proto, entry.port));
  }
  return !(await unitIsFailed(entry.unit));
}

async function unitStateText(unit: string): Promise<string> {
  try {
    const { stdout } = await execFileP("systemctl", ["is-active", unit]);
    return stdout.trim();
  } catch (err) {
    const stdout = (err as NodeJS.ErrnoException & { stdout?: string }).stdout;
    return stdout?.trim() || "unknown";
  }
}

// Restarts one of the services service-watchdog.sh monitors, on an explicit
// /fix <unit> reply from the owner chat -- the only path to this, there is
// no automatic remediation. `unit` must exactly match an entry from
// deploy/services.json; no shell involved (execFile with an argv array), and
// no sudo (doesn't work under this process's NoNewPrivileges anyway --
// authorization instead comes from the polkit rule in
// deploy/49-ideavault-ops-restart.rules, scoped to just these units).
async function handleFixCommand(unit: string): Promise<void> {
  const entry = SERVICES.find((s) => s.unit === unit);
  if (!entry) {
    await sendTelegram(
      `⚠️ "${unit}" isn't a service I know about -- not doing anything. Known: ${[...RESTARTABLE_UNITS].join(", ")}`,
    );
    return;
  }
  try {
    await execFileP("systemctl", ["restart", unit], { timeout: 30_000 });
  } catch (err) {
    await sendTelegram(`⚠️ Failed to restart ${unit}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  let up = false;
  for (let i = 0; i < 15 && !up; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    up = await unitProbe(entry);
  }
  if (up) {
    await sendTelegram(`✅ ${unit} restarted and looks healthy`);
  } else {
    const state = await unitStateText(unit);
    await sendTelegram(`⚠️ Restarted ${unit} but it doesn't look healthy yet (systemctl is-active: ${state}). Check it manually.`);
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
  const fixMatch = trimmed.match(/^fix\s+(\S+)$/i);
  if (fixMatch) {
    await handleFixCommand(fixMatch[1]);
    return;
  }
  if (/^help$/i.test(trimmed)) {
    await sendTelegram(
      "Commands:\nallowlist add <name>\nallowlist remove <name>\nfix <service> -- restart a service the watchdog flagged as down\n\n(you'll also get a notification here whenever a player connects, or a service goes down/recovers)",
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
      console.warn(`[opsControl] ignoring message from unauthorized chat_id ${msg.chat.id}`);
      continue;
    }
    await handleTelegramMessage(msg.text);
  }
  return nextOffset;
}

async function runTelegramListener(): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("[opsControl] NOTIFY_TELEGRAM_BOT_TOKEN/CHAT_ID not set, allowlist control disabled");
    return;
  }
  let offset = readOffset();
  console.log("[opsControl] Telegram listener started");
  for (;;) {
    try {
      const nextOffset = await pollTelegramOnce(offset);
      if (nextOffset !== offset) {
        offset = nextOffset;
        writeOffset(offset);
      }
    } catch (err) {
      console.error("[opsControl] poll error, retrying in 5s:", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function runConsoleLogTail(): void {
  const logPath = consoleLogPath();
  if (!logPath) {
    console.log("[opsControl] could not resolve console.log path, connect notifications disabled");
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
    console.error(`[opsControl] tail on ${logPath} exited (${code}), restarting in 5s`);
    setTimeout(runConsoleLogTail, 5000);
  });
}

export function startOpsControl(): void {
  void runTelegramListener();
  runConsoleLogTail();
}
