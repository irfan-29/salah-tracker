// Notification preferences, message building and due-detection.
//
// Two delivery paths, because they have very different characteristics on a
// serverless host:
//
//   * Event-driven (challenges, salah log, new post) - fired inline from the
//     route that caused them. Deterministic, no scheduler.
//
//   * Time-based (ayah of the day, daily digest) - nothing is running at 05:30,
//     so a due-check endpoint decides who is owed a message. It is called when
//     the user next opens the app (works on any Vercel plan) and optionally from
//     a cron job for exact delivery.

const { sendTelegramMessage, buildStreakSummary } = require("../utils/telegram.js");
const { cachedJsonOrNull } = require("../utils/quranCache.js");

const EVENT_KEYS = ["challenges", "salahTracker", "newPost", "salahTimings", "ayahOfTheDay"];
// Only these two are time-based. The rest fire from the request that caused
// them, so a clock time would be meaningless for them.
const SCHEDULED_KEYS = ["ayahOfTheDay", "salahTimings"];
const DEFAULT_TZ = "UTC";

// --- Time helpers -----------------------------------------------------------

// Wall-clock in the user's own timezone. `Intl` is the only reliable way to do
// this without shipping a tz database, and it handles DST for us.
function localParts(date, timeZone) {
    let safeTz = timeZone;
    try {
        new Intl.DateTimeFormat("en-GB", { timeZone: safeTz });
    } catch (err) {
        safeTz = DEFAULT_TZ;
    }
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: safeTz,
        hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
    }).formatToParts(date);

    const out = {};
    for (const p of parts) out[p.type] = p.value;
    // Intl renders midnight as "24" in some Node versions.
    if (out.hour === "24") out.hour = "00";
    return out;
}

function localDateKey(date, timeZone) {
    const p = localParts(date, timeZone);
    return `${p.year}-${p.month}-${p.day}`;
}

function localHhMm(date, timeZone) {
    const p = localParts(date, timeZone);
    return `${p.hour}:${p.minute}`;
}

function normaliseHhMm(value, fallback) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
    return m ? `${String(m[1]).padStart(2, "0")}:${m[2]}` : fallback;
}

// --- Preferences ------------------------------------------------------------

function telegramPrefs(user) {
    const tg = (user && user.telegram) || {};
    const events = tg.events || {};
    return {
        enabled: Boolean(tg.enabled),
        chatId: (user && user.telegramChatId) || "",
        timezone: tg.timezone || DEFAULT_TZ,
        events: Object.fromEntries(EVENT_KEYS.map((k) => [k, Boolean(events[k])])),
        times: {
            ayahOfTheDay: normaliseHhMm(tg.times && tg.times.ayahOfTheDay, "05:30"),
            salahTimings: normaliseHhMm(tg.times && tg.times.salahTimings, "05:00")
        },
        lastSent: tg.lastSent || {}
    };
}

function wantsEvent(user, key) {
    const prefs = telegramPrefs(user);
    return prefs.enabled && Boolean(prefs.chatId) && prefs.events[key];
}

// --- Message builders -------------------------------------------------------

// Telegram HTML parse mode only understands a small tag set, so any user-supplied
// text (challenge names, post bodies, location) must be escaped or it can break
// the parse and silently drop the whole message.
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

async function buildSalahTimingsMessage(user) {
    const location = (user.settings && user.settings.location) || "Coimbatore";
    try {
        // timingsByAddress is the one that reliably answers for an Indian city
        // name; timingsByCity returns 400 for Salem/Coimbatore. It answers with a
        // 302, so the cache has to follow redirects.
        const url =
            "https://api.aladhan.com/v1/timingsByAddress?address=" +
            encodeURIComponent(`${location}, India`) + "&method=2";
        const data = await cachedJsonOrNull(url, { followRedirects: true });
        if (!data || !data.data || !data.data.timings) return null;

        const t = data.data.timings;
        const hijri = (data.data.date && data.data.date.hijri) || {};
        const hijriLabel = [
            String(hijri.day || "").trim(),
            (hijri.month && (hijri.month.en || hijri.month.number)) || "",
            hijri.year || "",
        ].filter(Boolean).join(" ");

        const lines = [
            `<b>Salah Tracker</b> — ${escapeHtml(location)}`,
            `Today, ${escapeHtml(hijriLabel)}`,
            ""
        ];
        const rows = [
            ["Fajr", t.Fajr], ["Sunrise", t.Sunrise], ["Dhuhr", t.Dhuhr],
            ["Asr", t.Asr], ["Maghrib", t.Maghrib], ["Isha", t.Isha]
        ];
        for (const [label, value] of rows) {
            // Aladhan returns "05:08 (IST)" - keep just the clock time.
            const clock = String(value || "").split(" ")[0];
            if (/^\d{1,2}:\d{2}$/.test(clock)) lines.push(`${label}: ${escapeHtml(clock)}`);
        }
        return lines.join("\n");
    } catch (err) {
        return null;
    }
}

function buildSalahLogMessage(user, dateLabel) {
    const entries = user.salahLog || [];
    const today = entries.filter((e) => e.date === dateLabel);
    const names = ["Fajr", "Zuhur", "Asar", "Magrib", "Isha"];

    const done = names.filter((n) =>
        today.some((e) => e.name === n && e.value !== "Not Prayed")
    );
    const missed = names.filter((n) =>
        today.some((e) => e.name === n && e.value === "Not Prayed")
    );

    const lines = [`<b>Salah Tracker</b> — ${escapeHtml(dateLabel)}`, ""];
    if (!today.length) {
        lines.push("Nothing logged yet today.");
        return lines.join("\n");
    }
    lines.push(`Logged: ${done.length}/5`);
    lines.push("");
    for (const n of names) {
        const entry = today.find((e) => e.name === n);
        const mark = !entry ? "\u25cb" : entry.value === "Not Prayed" ? "\u2715" : "\u2713";
        lines.push(`${mark} ${n}${entry ? ` — ${escapeHtml(entry.value)}` : ""}`);
    }
    if (missed.length) lines.push("", `Missed: ${missed.join(", ")}`);
    return lines.join("\n");
}

function buildNewPostMessage(post) {
    const kind = post.isVideo ? "New video" : "New post";
    const lines = [`<b>Salah Tracker</b> — ${kind}`, ""];
    if (post.isVideo) {
        lines.push(`Watch: https://youtu.be/${escapeHtml(post.content)}`);
    } else {
        lines.push(escapeHtml(post.content || ""));
    }
    if (post.reference) lines.push("", `<i>${escapeHtml(post.reference)}</i>`);
    if (post.authorName) lines.push("", `— ${escapeHtml(post.authorName)}`);
    return lines.join("\n");
}

function summariseChallenges(challenges, completedIds) {
    if (!challenges.length) return "No challenges yet.";
    const done = challenges.filter((c) => completedIds.includes(String(c._id)));
    return `Done today: ${done.length}/${challenges.length}\n` + challenges
        .map((c) => `${completedIds.includes(String(c._id)) ? "\u2713" : "\u25CB"} ${c.challenge} — ${c.currentStreak || 0} day streak (best ${c.maxStreak || 0})`)
        .join("\n");
}

// --- Sending ----------------------------------------------------------------

// Returns true when a message was actually delivered.
async function deliver(user, text) {
    const prefs = telegramPrefs(user);
    if (!prefs.enabled || !prefs.chatId || !text) return false;
    const result = await sendTelegramMessage({ chatId: prefs.chatId, text });
    return Boolean(result.sent);
}

// Fire-and-observe for route handlers: never let a notification break the
// action the user actually took.
async function safeDeliver(user, text) {
    try {
        return await deliver(user, text);
    } catch (err) {
        console.error("notify: deliver failed -", err.message);
        return false;
    }
}

function markSent(user, key, dateKey) {
    if (!user.telegram) user.telegram = {};
    if (!user.telegram.lastSent) user.telegram.lastSent = {};
    user.telegram.lastSent[key] = dateKey;
}

module.exports = {
    EVENT_KEYS,
    SCHEDULED_KEYS,
    escapeHtml,
    localParts,
    localDateKey,
    localHhMm,
    normaliseHhMm,
    telegramPrefs,
    wantsEvent,
    buildSalahTimingsMessage,
    buildSalahLogMessage,
    buildNewPostMessage,
    summariseChallenges,
    deliver,
    safeDeliver,
    markSent,
    buildStreakSummary
};
