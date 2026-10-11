// Decides which scheduled notifications a user is currently owed.
//
// Nothing runs at 05:30 on a serverless host, so "has the user's chosen time
// arrived?" is answered here, at request time, in the user's own timezone.
//
// This makes per-user times possible without a per-user worker:
//
//   * Every time the app is loaded we run the check for that user, so a message
//     lands the first time they open the app after their chosen time. This works
//     on every Vercel plan including Hobby, for free, and costs nothing.
//
//   * A QStash schedule calls sweepAllUsers() on a fixed interval, so reminders
//     arrive even if nobody opens the app. This is the path that makes scheduled
//     delivery actually happen - see api/utils/qstash.js, and note it bills per
//     message, so the interval is a cost decision.
//
// The same isDue() check runs on both paths, so the outcome is identical; only
// the latency differs.
//
// The per-day `lastSent` stamp is what stops a user receiving the same digest
// on every page load. It is written only after a message is actually delivered,
// so a transient Telegram failure is retried on the next check instead of being
// silently lost.

const User = require("../models/User.js");
const AyahOfTheDay = require("../models/AyahOfTheDay.js");
const notify = require("./notifications.js");

function dateLabelIn(tz, now) {
    const p = notify.localParts(now, tz);
    const months = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
    const monthName = months[Number(p.month) - 1] || "";
    // Salah log entries are keyed by the same en-US style label used elsewhere.
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
        .format(now);
    return `${weekday}, ${monthName.slice(0, 3)} ${p.day}, ${p.year}`;
}

// Has `key`'s scheduled time arrived today, in the user's timezone, and has it
// already fired today?
function isDue(user, key, now) {
    const prefs = notify.telegramPrefs(user);
    if (!prefs.enabled || !prefs.chatId) return false;

    const target = prefs.times[key];
    if (!target) return false;

    const today = notify.localDateKey(now, prefs.timezone);
    if (prefs.lastSent[key] === today) return false;

    return notify.localHhMm(now, prefs.timezone) >= target;
}

async function currentAyah(now) {
    const d = now;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return AyahOfTheDay.findOne({ date: `${y}-${m}-${day}` }).lean();
}

// Run every due scheduled event for one user. Returns the events that fired.
async function runDueForUser(user, now = new Date()) {
    const prefs = notify.telegramPrefs(user);
    if (!prefs.enabled || !prefs.chatId) return [];

    const fired = [];

    if (isDue(user, "ayahOfTheDay", now)) {
        const ayah = await currentAyah(now);
        if (ayah) {
            const label = ayah.surahName
                ? `${ayah.surahName} ${ayah.ayahNo}`
                : `Surah ${ayah.surahNo} ${ayah.ayahNo}`;
            const lines = [`<b>Ayah of the day</b>`, ""];
            if (ayah.arabicText) lines.push(notify.escapeHtml(ayah.arabicText));
            if (ayah.translationText) {
                lines.push("");
                lines.push(`<i>${notify.escapeHtml(ayah.translationText)}</i>`);
            }
            lines.push("", escape(ayah.translationLabel || ""), escape(label));
            const ok = await notify.safeDeliver(user, lines.join("\n"));
            if (ok) fired.push("ayahOfTheDay");
        }
        // Only stamp when it actually went out, so a transient Telegram failure
        // is retried on the next check rather than silently lost.
        if (fired.includes("ayahOfTheDay")) {
            notify.markSent(user, "ayahOfTheDay", notify.localDateKey(now, prefs.timezone));
        }
    }

    if (isDue(user, "salahTimings", now)) {
        const text = await notify.buildSalahTimingsMessage(user);
        const ok = await notify.safeDeliver(user, text);
        // Only stamp on real delivery, so a transient failure retries next check
        // instead of silently dropping the day's timings.
        if (ok) {
            notify.markSent(user, "salahTimings", notify.localDateKey(now, prefs.timezone));
            fired.push("salahTimings");
        }
    }

    if (fired.length) {
        try {
            await user.save();
        } catch (err) {
            console.error("scheduler: could not persist lastSent -", err.message);
        }
    }
    return fired;
}

// Entry point for the app: catch up this one user.
async function runDueForCurrentUser(req, now = new Date()) {
    if (!req.isAuthenticated || !req.isAuthenticated()) return [];
    try {
        return await runDueForUser(req.user, now);
    } catch (err) {
        console.error("scheduler: user check failed -", err.message);
        return [];
    }
}

// Entry point for a cron job: sweep every subscriber. Deliberately bounded so a
// big table cannot blow the 10s invocation limit - the next tick continues.
async function sweepAllUsers(now = new Date(), { limit = 200 } = {}) {
    const users = await User.find({
        "telegram.enabled": true,
        telegramChatId: { $exists: true, $ne: "" },
    }).limit(limit);

    let sent = 0;
    for (const user of users) {
        try {
            const fired = await runDueForUser(user, now);
            sent += fired.length;
        } catch (err) {
            console.error("scheduler: sweep failed for", user.email, err.message);
        }
    }
    return { checked: users.length, sent };
}

function escape(str) {
    return notify.escapeHtml(str || "");
}

module.exports = { isDue, runDueForUser, runDueForCurrentUser, sweepAllUsers, dateLabelIn };
