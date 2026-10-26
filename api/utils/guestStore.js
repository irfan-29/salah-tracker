// Anonymous, cookie-backed storage.
//
// Logged-out visitors should be able to tick off a surah, track a salah or add
// a challenge without an account, and have that work carry over when they
// finally sign in. Cookies are signed and capped well under the 4KB browser
// limit; anything that would overflow is dropped oldest-first rather than
// silently failing to save.

const COOKIE_NAME = "salah_guest";
const MAX_COOKIE_BYTES = 3800;
const MAX_CHALLENGES = 25;
const MAX_SALAH_ENTRIES = 60;
const MAX_LAST_READ = 5;

function emptyGuest() {
  return {
    lastReadSurahs: [],
    challenges: [],
    salahLog: [],
    settings: {},
    telegramChatId: ""
  };
}

// Shape + bound everything on the way in, so a hand-crafted cookie can never
// smuggle odd types into Mongoose.
function sanitize(raw) {
  const out = emptyGuest();
  if (!raw || typeof raw !== "object") return out;

  if (Array.isArray(raw.lastReadSurahs)) {
    out.lastReadSurahs = raw.lastReadSurahs
      .map((n) => String(n).replace(/[^\d]/g, ""))
      .filter(Boolean)
      .slice(0, MAX_LAST_READ);
  }

  if (Array.isArray(raw.challenges)) {
    out.challenges = raw.challenges
      .filter((c) => c && typeof c === "object" && typeof c.challenge === "string" && c.challenge.trim())
      .slice(0, MAX_CHALLENGES)
      .map((c) => ({
        challenge: String(c.challenge).slice(0, 120),
        currentStreak: Number(c.currentStreak) || 0,
        maxStreak: Number(c.maxStreak) || 0,
        lastUpdated: c.lastUpdated ? String(c.lastUpdated).slice(0, 40) : undefined
      }));
  }

  if (Array.isArray(raw.salahLog)) {
    out.salahLog = raw.salahLog
      .filter((s) => s && typeof s === "object" && typeof s.name === "string")
      .slice(0, MAX_SALAH_ENTRIES)
      .map((s) => ({
        date: String(s.date || "").slice(0, 40),
        name: String(s.name).slice(0, 60),
        value: String(s.value || "").slice(0, 60)
      }));
  }

  if (raw.settings && typeof raw.settings === "object") {
    const s = raw.settings;
    out.settings = {
      defaultHome: s.defaultHome ? String(s.defaultHome).slice(0, 40) : undefined,
      location: s.location ? String(s.location).slice(0, 80) : undefined,
      favoriteReciter: Number.isFinite(Number(s.favoriteReciter)) ? Number(s.favoriteReciter) : undefined,
      favoriteFont: s.favoriteFont ? String(s.favoriteFont).slice(0, 40) : undefined,
      favoriteEdition: Array.isArray(s.favoriteEdition)
        ? s.favoriteEdition.slice(0, 12).map((e) => String(e).slice(0, 120))
        : undefined,
      primaryTranslation: s.primaryTranslation ? String(s.primaryTranslation).slice(0, 120) : undefined,
      theme: s.theme === "dark" ? "dark" : s.theme === "light" ? "light" : undefined,
      // Absent from this whitelist until now, which silently discarded the field
      // on every cookie write: writeGuest -> withinBudget -> sanitize rebuilds
      // settings key by key, so a key not named here is dropped no matter what
      // recordAudioProgress put in it. Guests could therefore never
      // resume a recitation, while signed-in users always could - and the
      // failure was invisible, because the write still returned { ok: true }.
      //
      // Validated rather than copied: the cookie is attacker-writable, so bounds
      // are enforced here the same way as everything else above. surahNo is
      // clamped to the 114 surahs rather than merely checked, so a stale or
      // hand-edited cookie cannot point the player at a surah that does not
      // exist.
      // Array excluded explicitly: typeof [] is "object", so without the isArray
      // check a cookie carrying audioProgress:[1,2,3] would sanitise to {} and
      // be accepted as a (degenerate) progress object. Harmless downstream -
      // {} has no surahNo, so the restore path bails - but correct to reject.
      audioProgress: s.audioProgress && typeof s.audioProgress === "object"
        && !Array.isArray(s.audioProgress) ? {
        surahNo: Number.isInteger(Number(s.audioProgress.surahNo))
          ? Math.min(114, Math.max(1, Number(s.audioProgress.surahNo)))
          : undefined,
        surahName: s.audioProgress.surahName ? String(s.audioProgress.surahName).slice(0, 60) : undefined,
        time: Number.isFinite(Number(s.audioProgress.time)) && Number(s.audioProgress.time) >= 0
          ? Number(s.audioProgress.time)
          : undefined
      } : undefined
    };

    // Drop keys that sanitised to nothing.
    //
    // JSON.stringify already omits undefined when the cookie is WRITTEN, so the
    // cookie itself never carries these keys. But sanitize also rebuilds the
    // object on every READ, and it re-adds each whitelisted key as `undefined`.
    // getSettings does `{ ...defaults(), ...guest.settings }`, so those explicit
    // undefineds overwrote the defaults rather than deferring to them: a guest
    // who changed nothing but the theme came back with no location, no reciter,
    // no font and no editions.
    //
    // It stayed hidden because /api/settings re-applies its own `|| default` to
    // every single field, which is precisely what a defaults-merge is for. The
    // first code to read a setting raw - the homePath lookup in /api/app/meta -
    // surfaced it immediately as "/" going to the wrong page.
    out.settings = Object.fromEntries(
      Object.entries(out.settings).filter(([, value]) => value !== undefined)
    );
  }

  if (raw.telegramChatId) out.telegramChatId = String(raw.telegramChatId).replace(/[^\d-]/g, "").slice(0, 24);

  return out;
}

function readGuest(req) {
  // Cache on the request. Several helpers can write within a single request
  // (e.g. recording a surah read then saving audio progress). Without this,
  // each write re-read the untouched cookie header and the second write would
  // clobber the first one's changes.
  if (req._salahGuestCache) return req._salahGuestCache;

  // cookie-parser MOVES signed cookies out of req.cookies into
  // req.signedCookies (see signedCookies() in cookie-parser/index.js), so a
  // signed cookie is only visible in the latter.
  const raw = (req.signedCookies && req.signedCookies[COOKIE_NAME])
    ?? (req.cookies ? req.cookies[COOKIE_NAME] : null);
  if (!raw || typeof raw !== "string") {
    req._salahGuestCache = emptyGuest();
    return req._salahGuestCache;
  }
  try {
    req._salahGuestCache = sanitize(JSON.parse(raw));
  } catch (err) {
    req._salahGuestCache = emptyGuest();
  }
  return req._salahGuestCache;
}

// Drop the oldest challenges/salah rows if the payload would exceed the cookie
// budget. A silently-dropped row beats a rejected Set-Cookie header, which would
// throw and 500 the user's save.
function withinBudget(guest) {
  let working = sanitize(guest);
  while (JSON.stringify(working).length > MAX_COOKIE_BYTES) {
    if (working.salahLog.length) working.salahLog.pop();
    else if (working.challenges.length) working.challenges.pop();
    else return { guest: working, dropped: true };
  }
  return { guest: working, dropped: false };
}

function writeGuest(req, res, guest) {
  if (res.headersSent) return;
  const { guest: trimmed } = withinBudget(guest);
  // Keep the per-request cache in step with what we just persisted.
  req._salahGuestCache = trimmed;
  try {
    res.cookie(COOKIE_NAME, JSON.stringify(trimmed), {
      httpOnly: true,
      sameSite: "lax",
      signed: true,
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });
  } catch (err) {
    // Cookie rejected (too large, or headers already flushed). Non-fatal.
    console.error("guest cookie: write failed -", err.message);
  }
}

function clearGuest(req, res) {
  req._salahGuestCache = null;
  if (!res.headersSent) res.clearCookie(COOKIE_NAME);
}

// Merge guest data into the freshly authenticated user. Guest data wins on
// conflict: the most recent action is the one the person just took while logged
// out, so overwriting their older saved copy is the behaviour people expect.
async function mergeGuestIntoUser(req, user) {
  const guest = readGuest(req);
  let changed = false;

  const mergedSettings = { ...(user.settings || {}), ...guest.settings };
  if (Object.keys(guest.settings || {}).length) changed = true;

  const lastRead = mergeLastRead(user.lastReadSurahs || [], guest.lastReadSurahs);
  if (JSON.stringify(lastRead) !== JSON.stringify(user.lastReadSurahs || [])) changed = true;

  const challenges = mergeChallenges(user.challenges || [], guest.challenges);
  if (challenges.length !== (user.challenges || []).length) changed = true;

  const salahLog = mergeSalahLog(user.salahLog || [], guest.salahLog);
  if (salahLog.length !== (user.salahLog || []).length) changed = true;

  const telegramChatId = guest.telegramChatId || user.telegramChatId;

  if (!changed) {
    if (guest.telegramChatId && guest.telegramChatId !== user.telegramChatId) {
      user.telegramChatId = guest.telegramChatId;
      await user.save();
    }
    return { merged: false };
  }

  user.settings = mergedSettings;
  user.lastReadSurahs = lastRead;
  user.challenges = challenges;
  user.salahLog = salahLog;
  user.telegramChatId = telegramChatId;
  await user.save();

  return { merged: true, counts: {
    challenges: challenges.length,
    salahLog: salahLog.length,
    lastReadSurahs: lastRead.length
  } };
}

// Newest-first union by surah number, capped like the account-side helper.
function mergeLastRead(account, guest) {
  const seen = new Set();
  const out = [];
  for (const n of [...guest, ...account]) {
    const v = String(n);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_LAST_READ) break;
  }
  return out;
}

// Guest challenges win on name collision; account-only challenges are kept.
function mergeChallenges(account, guest) {
  const byName = new Map();
  for (const c of account) byName.set(String(c.challenge).trim().toLowerCase(), c);
  for (const g of guest) byName.set(String(g.challenge).trim().toLowerCase(), g);
  return Array.from(byName.values()).slice(0, 100);
}

// Keyed by date+name so re-logging the same day updates rather than duplicates.
function mergeSalahLog(account, guest) {
  const byKey = new Map();
  const key = (e) => `${e.date}|${e.name}`;
  for (const e of account) byKey.set(key(e), e);
  for (const g of guest) byKey.set(key(g), g);
  return Array.from(byKey.values()).slice(0, 400);
}

module.exports = {
  COOKIE_NAME,
  readGuest,
  writeGuest,
  clearGuest,
  mergeGuestIntoUser,
  sanitize,
  MAX_LAST_READ
};
