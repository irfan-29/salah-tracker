// Builds one aggregated report for the stats module.
//
// The user document already carries every personal module's raw data; this
// service only groups it into reusable charts / summaries so the frontend can
// stay presentation-only and the API stays stable if a report is copied.

const PRAYERS = ["Fajr", "Zuhur", "Asar", "Magrib", "Isha"];

// The exact spellings stored by the older pages and the React page. Both are
// counted together so a pre-React log still reads as one history.
const GOOD_STATUSES = new Set(["In Jamath", "On Time"]);

function isoKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

// Handles the two Salah date formats the app has ever written: an ISO key or
// the long English label from the pre-React page. Anything unparseable is
// ignored so a stray hand-edited row cannot crash the whole report.
function toIsoKey(value) {
    const raw = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const parsed = new Date(raw);
    if (isNaN(parsed.getTime())) return null;
    return isoKey(parsed);
}

function clampDayCount(value) {
    const days = Number(value) || 30;
    return Math.min(Math.max(days, 7), 365);
}

// Build the day range oldest-first. It is inclusive on both ends, including
// today, so a report generated at 08:00 still shows what has already been
// logged that day.
function dayRange(days, today = new Date()) {
    const out = [];
    for (let index = 0; index < days; index += 1) {
        out.push(isoKey(new Date(today.getTime() - ((days - 1 - index) * 24 * 60 * 60 * 1000))));
    }
    return out;
}

// `loggedDays` must be a Set of ISO keys. Returns a pair of streaks over all
// history, not just the displayed window, and feels more like an honest
// "did I stop?" answer.
function activeStreak(loggedDays, today = new Date()) {
    let cursor = new Date(today.getTime());
    // A person who opens at 07:59 has not yet lost today's streak, so if today
    // is empty we start counting from yesterday.
    if (!loggedDays.has(isoKey(cursor))) {
        cursor.setDate(cursor.getDate() - 1);
    }
    let current = 0;
    while (loggedDays.has(isoKey(cursor))) {
        current += 1;
        cursor.setDate(cursor.getDate() - 1);
    }

    let best = 0;
    let run = 0;
    let previous = null;
    for (const dateKey of [...loggedDays].sort()) {
        if (previous && new Date(dateKey).getTime() - new Date(previous).getTime() === 24 * 60 * 60 * 1000) {
            run += 1;
        } else {
            run = 1;
        }
        best = Math.max(best, run);
        previous = dateKey;
    }

    return { current, best };
}

// --- Salah ---------------------------------------------------------------
//
// A value is scored as good / late / missed / other rather than a raw status
// string, so the report stays readable even when a new status is introduced.
function buildSalahStats(entries, days, today = new Date()) {
    const range = dayRange(days, today);
    const allDays = new Set();

    // Keyed by day so re-opening a prayer on the same day replaces the old
    // value instead of counting the same slot twice.
    const byDay = new Map();
    for (const entry of entries || []) {
        const dateKey = toIsoKey(entry?.date);
        if (!dateKey) continue;
        allDays.add(dateKey);
        const row = byDay.get(dateKey) || {};
        row[String(entry.name || "").trim()] = String(entry.value || "").trim();
        byDay.set(dateKey, row);
    }

    // Scores are stored per prayer and per day, not just as one total, because
    // each prayer's graph needs its own bar rather than a single rate.
    const perPrayer = Object.fromEntries(PRAYERS.map((prayer) => [prayer, {
        good: 0, late: 0, missed: 0, other: 0, entries: 0
    }]));
    const daily = [];
    let perfectDays = 0;
    let activeDays = 0;
    let totalGood = 0;
    let totalLate = 0;
    let totalMissed = 0;

    for (const dateKey of range) {
        const row = byDay.get(dateKey) || {};
        let dayGood = 0;
        let dayLate = 0;
        let dayMissed = 0;
        let dayLogged = 0;

        for (const prayer of PRAYERS) {
            const status = row[prayer] || "";
            if (!status) continue;

            dayLogged += 1;
            if (GOOD_STATUSES.has(status)) {
                perPrayer[prayer].good += 1;
                dayGood += 1;
                totalGood += 1;
            } else if (status === "Late") {
                perPrayer[prayer].late += 1;
                dayLate += 1;
                totalLate += 1;
            } else if (status === "Not Prayed") {
                perPrayer[prayer].missed += 1;
                dayMissed += 1;
                totalMissed += 1;
            } else {
                perPrayer[prayer].other += 1;
            }
        }

        if (dayLogged) activeDays += 1;
        // A completed day means every prayer got a status and none was missed.
        if (dayLogged === PRAYERS.length && dayMissed === 0) perfectDays += 1;

        daily.push({
            date: dateKey,
            logged: dayLogged,
            good: dayGood,
            late: dayLate,
            missed: dayMissed
        });
    }

    const streaks = activeStreak(allDays, today);
    const totalEntries = totalGood + totalLate + totalMissed;

    const prayers = PRAYERS.map((prayer) => {
        const row = perPrayer[prayer];
        const total = row.good + row.late + row.missed + row.other;
        return {
            prayer,
            ...row,
            entries: row.entries || total, // entries is the legacy field name.
            rate: Math.round((row.good / Math.max(total, 1)) * 100)
        };
    });

    return {
        days,
        prayers,
        daily,
        summary: {
            perfectDays,
            activeDays,
            onTimeRate: Math.round((totalGood / Math.max(totalEntries, 1)) * 100),
            totals: {
                good: totalGood,
                late: totalLate,
                missed: totalMissed
            },
            streaks
        }
    };
}

// --- Challenges -----------------------------------------------------------
//
// A check-in history is recorded from now on. Older challenges without rows
// still report their streaks, and their graph simply leaves history blank.
function buildChallengeStats(challenges, days = 30, today = new Date()) {
    const list = (challenges || []).map((challenge) => {
        const history = (challenge.history || []).map(toIsoKey).filter(Boolean);
        const unique = [...new Set(history)].sort().reverse();
        const { current, best } = activeStreak(new Set(unique), today);
        const recent = unique.filter((dateKey) => dateKey >= isoKey(new Date(today.getTime() - ((days - 1) * 24 * 60 * 60 * 1000))));

        return {
            id: String(challenge._id || ""),
            name: challenge.challenge,
            currentStreak: Number(challenge.currentStreak) || 0,
            storedStreak: Number(challenge.currentStreak) || 0,
            storedBest: Number(challenge.maxStreak) || 0,
            historyCount: unique.length,
            lastUpdated: challenge.lastUpdated || "",
            recentCheckIns: recent,
            // The streak set is the best guess we can make for legacy rows that
            // do not yet carry their own history: the user has told us how many
            // days they are at now.
            streakBreakdown: Object.assign(
                { current, best },
                unique.length === 0
                    ? { fallback: { current: Number(challenge.currentStreak) || 0, best: Number(challenge.maxStreak) || 0 } }
                    : {}
            )
        };
    });

    const active = list.filter((challenge) => challenge.storedStreak > 0);
    return {
        days,
        challenges: list,
        summary: {
            total: list.length,
            active: active.length,
            bestStreak: list.reduce((best, challenge) => Math.max(best, challenge.storedBest), 0),
            checkInTotal: list.reduce((total, challenge) => total + challenge.historyCount, 0),
            recentCheckInTotal: list.reduce((total, challenge) => total + challenge.recentCheckIns.length, 0)
        }
    };
}

// --- Charity ---------------------------------------------------------------
//
// Group each donation into its own month, and expose per-goal progress so a
// user looking for "am I on track this month?" doesn't have to compute it.
function buildCharityStats(charities, months = 6, today = new Date()) {
    const list = (charities || []).map((charity) => {
        const donations = charity.donations || [];
        const donated = donations.reduce((total, donation) => total + (Number(donation.amount) || 0), 0);
        return {
            id: String(charity._id || ""),
            name: charity.name,
            period: charity.period,
            targetAmount: Number(charity.targetAmount) || 0,
            donated,
            donationCount: donations.length
        };
    });

    const labels = [];
    const monthTotals = [];
    for (let index = months - 1; index >= 0; index -= 1) {
        const monthStart = new Date(today.getFullYear(), today.getMonth() - index, 1);
        const monthEnd = new Date(today.getFullYear(), today.getMonth() - index + 1, 0);
        const startKey = isoKey(monthStart);
        const endKey = isoKey(monthEnd);
        labels.push(monthStart.toLocaleDateString("en-GB", { month: "short", year: "numeric" }));

        let total = 0;
        for (const charity of charities || []) {
            for (const donation of charity.donations || []) {
                const date = String(donation.date || "").slice(0, 10);
                if (date < startKey || date > endKey) continue;
                total += Number(donation.amount) || 0;
            }
        }
        monthTotals.push(Math.round(total * 100) / 100);
    }

    // Recent donations bring a single list together across every charity.
    // Sorted newest first; donations sharing a date keep newest-ADDED first,
    // matching the order the charity page shows. `seq` is the insertion
    // position inside its charity and is stripped before serving.
    const recent = [];
    for (const charity of charities || []) {
        const rows = charity.donations || [];
        for (let i = 0; i < rows.length; i += 1) {
            recent.push({
                id: String(charity._id || ""),
                charity: charity.name,
                amount: Number(rows[i].amount) || 0,
                date: rows[i].date,
                note: rows[i].note || "",
                seq: i
            });
        }
    }
    recent.sort((a, b) => {
        const byDate = String(b.date || "").localeCompare(String(a.date || ""));
        return byDate !== 0 ? byDate : b.seq - a.seq;
    });

    const totalDonated = list.reduce((sum, charity) => sum + charity.donated, 0);
    const donationCount = list.reduce((sum, charity) => sum + charity.donationCount, 0);

    return {
        months,
        goals: list,
        monthly: { labels, amounts: monthTotals },
        recent: recent.slice(0, 12).map(({ seq, ...entry }) => entry),
        summary: {
            goals: list.length,
            amount: totalDonated,
            donations: donationCount,
            activeGoals: list.filter((charity) => charity.targetAmount > 0).length,
            avgPerGoal: list.length ? Math.round((totalDonated / list.length) * 100) / 100 : 0
        }
    };
}

function buildStats(user, { days = 30, charityMonths = 6, challengeDays } = {}) {
    const today = new Date();
    const windowDays = clampDayCount(days);
    // Challenges keep their own window: the module filter on the stats page
    // selects salah and challenges independently, so the challenge report no
    // longer inherits the salah range (fallback stays the old shared range
    // for callers that do not pass challengeDays).
    const challengeWindow = challengeDays === undefined
        ? Math.min(windowDays, 90)
        : Math.min(clampDayCount(challengeDays), 90);
    return {
        generatedAt: today.toISOString(),
        days: windowDays,
        challengeDays: challengeWindow,
        charityMonths,
        salah: buildSalahStats(user.salahLog || [], windowDays, today),
        challenges: buildChallengeStats(user.challenges || [], challengeWindow, today),
        charity: buildCharityStats(user.charities || [], Math.max(3, Math.min(charityMonths, 12)), today)
    };
}

module.exports = {
    buildStats,
    buildSalahStats,
    buildChallengeStats,
    buildCharityStats
};
