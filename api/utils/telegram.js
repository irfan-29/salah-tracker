const fetch = require("node-fetch");

const API_BASE = "https://api.telegram.org";

// Telegram hard-limits a message at 4096 chars; leave room for the ellipsis.
const MAX_TEXT = 4000;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text) {
  return text.length <= MAX_TEXT ? text : text.slice(0, MAX_TEXT - 1) + "\u2026";
}

async function telegramRequest(token, method, payload) {
  const url = `${API_BASE}/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    timeout: 8000,
  });

  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`Telegram returned non-JSON (HTTP ${res.status})`);
  }

  if (!data.ok) {
    const err = new Error(data.description || `Telegram error ${res.status}`);
    err.code = classifyTelegramError(data.description || "");
    throw err;
  }
  return data.result;
}

// Turn Telegram's descriptions into short codes the UI can explain.
function classifyTelegramError(description) {
  const d = String(description).toLowerCase();
  // Telegram says this outright when the chat id is the bot's own.
  if (d.includes("can't send messages to the bot") || d.includes("cant send messages to the bot"))
    return "bot-own-id";
  if (d.includes("chat not found")) return "chat-not-found";
  if (d.includes("bot was blocked") || d.includes("user deactivated")) return "bot-blocked";
  if (d.includes("bot can't initiate") || d.includes("can't send message to users")) return "bot-blocked";
  if (d.includes("can't parse entities") || d.includes("unsupported start tag")) return "bad-format";
  if (d.includes("message is too long")) return "too-long";
  if (d.includes("unauthorized")) return "bad-token";
  if (d.includes("too many requests")) return "rate-limited";
  return "unknown";
}

// Chat IDs look like 123456789 or -1009876543210. Validate before storing so a
// pasted username or a stray space fails early instead of on every update.
function normalizeChatId(raw) {
  if (!raw) return "";
  const trimmed = String(raw).trim().replace(/^@/, "");
  return /^-?\d+$/.test(trimmed) ? trimmed : "";
}

function normalizeToken(raw) {
  return raw ? String(raw).trim() : "";
}

// A real token is <bot-id>:<35 chars of base64url>.
const TOKEN_RE = /\d{5,20}:[A-Za-z0-9_-]{30,50}/;

// Users often paste the whole BotFather reply ("Use this token to access the
// HTTP API: <token> For a description...") or paste it more than once. Pull the
// first well-formed token out instead of rejecting the paste outright.
function extractToken(raw) {
  if (!raw) return "";
  const text = String(raw);
  const existing = text.match(TOKEN_RE);
  return existing ? existing[0] : "";
}

function isValidToken(token) {
  return TOKEN_RE.test(extractToken(token));
}

async function getBotId(token) {
  try {
    const bot = await telegramRequest(token, "getMe");
    return bot && bot.id ? String(bot.id) : "";
  } catch (err) {
    return "";
  }
}

// Failures are returned, never thrown, so a bad token can never break a streak
// update or crash the request.
async function sendTelegramMessage({ botToken, chatId, text }) {
  const token = normalizeToken(botToken);
  const chat = normalizeChatId(chatId);

  if (!token || !chat) {
    return { sent: false, code: "not-configured" };
  }

  try {
    await telegramRequest(token, "sendMessage", {
      chat_id: chat,
      text: truncate(text),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    console.log("telegram: sent to chat", chat);
    return { sent: true };
  } catch (err) {
    // The bot's own id is the number before the colon in its token, and it's an
    // easy value to paste by mistake. A bot can never message itself, so say so
    // instead of showing the generic "chat not found".
    if (err.code === "chat-not-found" && (await getBotId(token)) === chat) {
      console.error("telegram: chat id is the bot's own id -", chat);
      return { sent: false, code: "bot-own-id" };
    }
    console.error("telegram: failed -", err.code || "unknown", "-", err.message);
    return { sent: false, code: err.code || "unknown" };
  }
}

// Lets the user discover their chat id without leaving the settings page: they
// start the bot, then this reads back the most recent message they sent.
async function findChatId(botToken) {
  const token = normalizeToken(botToken);
  if (!token) return { chatId: "", code: "bad-token" };

  try {
    const updates = await telegramRequest(token, "getUpdates", {
      limit: 100,
      allowed_updates: ["message"],
    });

    const chats = (updates || [])
      .map((u) => u.message || u.channel_post)
      .filter(Boolean);

    if (!chats.length) return { chatId: "", code: "no-messages" };

    const last = chats[chats.length - 1];
    return {
      chatId: String(last.chat.id),
      name: [last.chat.first_name, last.chat.last_name].filter(Boolean).join(" "),
    };
  } catch (err) {
    console.error("telegram: getUpdates failed -", err.message);
    return { chatId: "", code: err.code || "unknown" };
  }
}

function buildStreakSummary({ date, completed, challenges }) {
  const lines = [`<b>Salah Tracker</b> — ${escapeHtml(date)}`, ""];

  if (!challenges.length) {
    return lines.concat("No challenges yet.").join("\n");
  }

  const done = challenges.filter((c) => completed.includes(c.id));

  lines.push(`<b>Done today: ${done.length}/${challenges.length}</b>`);
  lines.push("");

  for (const c of challenges) {
    const mark = completed.includes(c.id) ? "\u2713" : "\u25cb";
    lines.push(`${mark} ${escapeHtml(c.name)} — ${c.currentStreak} day streak (best ${c.maxStreak})`);
  }

  return lines.join("\n");
}

const ERROR_MESSAGES = {
  "chat-not-found": "That chat ID wasn't found. Open your bot, tap Start, then press Find my chat ID.",
  "bot-own-id": "That's your bot's own ID (the digits before the colon in its token), not yours. Open your bot, tap Start, then press Find my chat ID to get the correct one.",
  "bot-blocked": "You blocked the bot, or it can't message you first. Unblock it and send /start again.",
  "bad-token": "That bot token was rejected. Copy it again from @BotFather.",
  "bad-token-format": "That doesn't look like a bot token. Copy just the single line starting with the digits before the colon — no commas, quotes or extra text.",
  incomplete: "Your other settings were saved, but Telegram needs both a bot token and a chat ID. Paste the token, tap Start on your bot, then press Find my chat ID.",
  "bad-format": "The message formatting was rejected. Check the bot token.",
  "too-long": "Your challenge list is too long for one Telegram message.",
  "rate-limited": "Too many requests to Telegram. Wait a few minutes.",
  "not-configured": "Add your bot token and chat ID first, then save.",
  "no-messages": "No messages found. Open your bot chat, tap Start (or send any message), then press Find my chat ID again. You can also paste your ID manually — for a private bot chat it equals your own Telegram user ID.",
  unknown: "Couldn't send. Check your bot token and chat ID.",
  missing: "Add your bot token and chat ID first, then save.",
  error: "Something went wrong sending the message.",
};

module.exports = {
  sendTelegramMessage,
  findChatId,
  buildStreakSummary,
  normalizeChatId,
  normalizeToken,
  extractToken,
  isValidToken,
  ERROR_MESSAGES,
};
