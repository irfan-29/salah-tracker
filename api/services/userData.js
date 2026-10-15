// Single place that answers "where does this user's data live right now?".
//
// Every read and write in the app goes through here, so route handlers stay
// unaware of whether the visitor is signed in. Signed-in users hit MongoDB;
// anonymous visitors hit the signed cookie, and their work merges into the
// account when they log in.

const { readGuest, writeGuest, clearGuest } = require("../utils/guestStore.js");

// --- Settings ---------------------------------------------------------------

const SETTINGS_FIELDS = [
  "defaultHome",
  "location",
  "favoriteReciter",
  "favoriteFont",
  "favoriteEdition",
  "primaryTranslation",
  "theme",
  "audioProgress"
];

// Kept in sync with DEFAULT_TRANSLATION in api/app.js: a guest (or a brand-new
// account) still gets a readable translation instead of a blank page.
const DEFAULT_EDITION = "eng-abdullahyusufal:English:Abdullah Yusuf Ali";

function defaults() {
  return {
    defaultHome: "salah",
    location: "Coimbatore",
    favoriteReciter: 1,
    theme: "light",
    favoriteEdition: [DEFAULT_EDITION],
    primaryTranslation: DEFAULT_EDITION
  };
}

async function getSettings(req) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    const stored = req.user.settings ? req.user.toObject().settings : null;
    return { ...defaults(), ...(stored || {}) };
  }
  return { ...defaults(), ...(readGuest(req).settings || {}) };
}

// Merge-and-set so a partial update never wipes unrelated preferences.
async function updateSettings(req, patch) {
  const clean = {};
  for (const key of SETTINGS_FIELDS) {
    if (patch[key] !== undefined) clean[key] = patch[key];
  }
  if (!Object.keys(clean).length) return getSettings(req);

  if (req.isAuthenticated && req.isAuthenticated()) {
    const user = req.user;
    user.settings = user.settings || {};
    for (const [key, value] of Object.entries(clean)) user.settings[key] = value;
    await user.save();
  } else {
    const guest = readGuest(req);
    guest.settings = { ...(guest.settings || {}), ...clean };
    writeGuest(req, res_of(req), guest);
  }
  return getSettings(req);
}

// The guest store needs `res` to set the cookie, but callers only hand us
// `req`. Cache it once per request in middleware instead of threading it
// through every signature.
function res_of(req) {
  if (!req._salahRes) throw new Error("guest cookie: response not attached");
  return req._salahRes;
}

function attachResponse(req, res, next) {
  req._salahRes = res;
  next();
}

// --- Last read surahs -------------------------------------------------------

async function getLastReadSurahs(req) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return req.user.lastReadSurahs || [];
  }
  return readGuest(req).lastReadSurahs || [];
}

async function recordSurahRead(req, surahNo) {
  const value = String(surahNo);
  if (req.isAuthenticated && req.isAuthenticated()) {
    req.user.pushLastReadSurah(value);
    await req.user.save();
    return req.user.lastReadSurahs;
  }
  const guest = readGuest(req);
  guest.lastReadSurahs = [value, ...guest.lastReadSurahs.filter((n) => n !== value)].slice(0, 5);
  writeGuest(req, res_of(req), guest);
  return guest.lastReadSurahs;
}

// Reading a surah marks progress AND stores playback position. These used to be
// two separate saves; against a remote Mongo that is ~400ms of dead time, which
// is the difference between a comfortable page load and a Vercel timeout.
async function recordSurahReadAndProgress(req, { surahNo, surahName, time }) {
    if (req.isAuthenticated && req.isAuthenticated()) {
        req.user.pushLastReadSurah(surahNo);
        req.user.settings = req.user.settings || {};
        req.user.settings.audioProgress = { surahNo, surahName, time };
        await req.user.save();
        return;
    }
    const guest = readGuest(req);
    const value = String(surahNo);
    guest.lastReadSurahs = [value, ...guest.lastReadSurahs.filter((n) => n !== value)].slice(0, 5);
    guest.settings = { ...(guest.settings || {}), audioProgress: { surahNo, surahName, time } };
    writeGuest(req, res_of(req), guest);
}

// --- Challenges -------------------------------------------------------------

async function listChallenges(req) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return req.user.challenges || [];
  }
  return readGuest(req).challenges || [];
}

async function addChallenge(req, challenge) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    req.user.challenges.push({ challenge, currentStreak: 0, maxStreak: 0 });
    await req.user.save();
    return req.user.challenges;
  }
  const guest = readGuest(req);
  guest.challenges.push({ challenge, currentStreak: 0, maxStreak: 0 });
  writeGuest(req, res_of(req), guest);
  return guest.challenges;
}

async function renameChallenge(req, id, name) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    const item = req.user.challenges.id(id);
    if (!item) return false;
    item.challenge = name;
    await req.user.save();
    return true;
  }
  const guest = readGuest(req);
  const item = guest.challenges.find((c) => String(c._id) === String(id));
  if (!item) return false;
  item.challenge = name;
  writeGuest(req, res_of(req), guest);
  return true;
}

async function deleteChallenge(req, id) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    const item = req.user.challenges.id(id);
    if (!item) return false;
    item.deleteOne();
    await req.user.save();
    return true;
  }
  const guest = readGuest(req);
  const before = guest.challenges.length;
  guest.challenges = guest.challenges.filter((c) => String(c._id) !== String(id));
  if (guest.challenges.length === before) return false;
  writeGuest(req, res_of(req), guest);
  return true;
}

// Apply a day's checkboxes: increment the ticked ones, reset the rest.
async function applyStreakUpdate(req, { completedIds, lastUpdated }) {
  const ids = completedIds.map(String);

  if (req.isAuthenticated && req.isAuthenticated()) {
    for (const challenge of req.user.challenges) {
      const done = ids.includes(String(challenge._id));
      if (done) {
        challenge.currentStreak = (challenge.currentStreak || 0) + 1;
        if (challenge.currentStreak > (challenge.maxStreak || 0)) {
          challenge.maxStreak = challenge.currentStreak;
        }
      } else {
        challenge.currentStreak = 0;
      }
      challenge.lastUpdated = lastUpdated;
    }
    await req.user.save();
    return req.user.challenges;
  }

  const guest = readGuest(req);
  for (const challenge of guest.challenges) {
    const done = ids.includes(String(challenge._id));
    if (done) {
      challenge.currentStreak = (challenge.currentStreak || 0) + 1;
      if (challenge.currentStreak > (challenge.maxStreak || 0)) {
        challenge.maxStreak = challenge.currentStreak;
      }
    } else {
      challenge.currentStreak = 0;
    }
    challenge.lastUpdated = lastUpdated;
  }
  writeGuest(req, res_of(req), guest);
  return guest.challenges;
}

// --- Salah log --------------------------------------------------------------

async function listSalah(req) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return req.user.salahLog || [];
  }
  return readGuest(req).salahLog || [];
}

async function recordSalah(req, { date, name, value }) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    const existing = req.user.salahLog.find((e) => e.date === date && e.name === name);
    if (existing) {
      existing.value = value;
    } else {
      req.user.salahLog.push({ date, name, value });
    }
    await req.user.save();
    return req.user.salahLog;
  }
  const guest = readGuest(req);
  const existing = guest.salahLog.find((e) => e.date === date && e.name === name);
  if (existing) {
    existing.value = value;
  } else {
    guest.salahLog.push({ date, name, value });
  }
  writeGuest(req, res_of(req), guest);
  return guest.salahLog;
}

// --- Telegram ---------------------------------------------------------------

async function getTelegramChatId(req) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return req.user.telegramChatId || "";
  }
  return readGuest(req).telegramChatId || "";
}

async function setTelegramChatId(req, chatId) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    req.user.telegramChatId = chatId;
    await req.user.save();
    return;
  }
  const guest = readGuest(req);
  guest.telegramChatId = chatId;
  writeGuest(req, res_of(req), guest);
}

function clearGuestCookie(req, res) {
  clearGuest(req, res);
}

// Favourite ayahs are account-only. Unlike challenges or last-read, there is no
// guest equivalent: an anonymous reader has no durable store big enough for
// coordinates plus text, and a guest who signs in would find their stars gone
// with nothing to merge. The UI therefore prompts for a sign-in rather than
// offering a favourite that silently disappears.
function listFavourites(req) {
    if (!req.isAuthenticated || !req.isAuthenticated()) return [];
    return Array.from(req.user.favoriteAyahs || [])
        .map((f) => ({ surahNo: Number(f.surahNo), ayahNo: Number(f.ayahNo) }))
        .filter((f) => Number.isInteger(f.surahNo) && Number.isInteger(f.ayahNo));
}

async function toggleFavourite(req, { surahNo, ayahNo }) {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        return { ok: false, reason: "login-required", favorited: false };
    }
    const nowFavorited = req.user.toggleFavoriteAyah(surahNo, ayahNo);
    await req.user.save();
    return { ok: true, favorited: nowFavorited };
}

module.exports = {
  attachResponse,
  getSettings,
  updateSettings,
  getLastReadSurahs,
  recordSurahRead,
  recordSurahReadAndProgress,
  listChallenges,
  addChallenge,
  renameChallenge,
  deleteChallenge,
  applyStreakUpdate,
  listSalah,
  recordSalah,
  getTelegramChatId,
  setTelegramChatId,
  listFavourites,
  toggleFavourite,
  clearGuestCookie,
  defaults
};
