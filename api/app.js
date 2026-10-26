require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const serverless = require("serverless-http");
const path = require("path");
const mongoose = require("mongoose");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const session = require('express-session');
const cookieParser = require("cookie-parser");
const { MongoStore } = require("connect-mongo");

// internal
const { islamicFinderFetch } = require("../api/utils/islamic-finder.js");
const { sendTelegramMessage, claimChatByCode, makeVerifyCode, buildStreakSummary, normalizeChatId, normalizeToken, extractToken, isValidToken, botIsConfigured, ERROR_MESSAGES } = require("../api/utils/telegram.js");
const { passport, requireLogin } = require("./middleware/auth.js");
// Named `userData` rather than `data`: several routes bind a local `data` to a
// fetched surah/prayer payload, which would shadow the service module.
const userData = require("./services/userData.js");
const { mergeGuestIntoUser } = require("./utils/guestStore.js");
const { cachedJson, cachedJsonOrNull } = require("./utils/quranCache.js");
const notify = require("./services/notifications.js");
const scheduler = require("./services/notifyScheduler.js");
const qstash = require("./utils/qstash.js");
const usernameUtil = require("./utils/username.js");
const emailService = require("./services/email.js");
const passwordUtil = require("./utils/password.js");
const favourites = require("./services/favourites.js");
const statsService = require("./services/stats.js");
const User = require("./models/User.js");

const app=express();

// QStash signs the raw request body, so keep an untouched copy. Without this the
// signature cannot be verified: re-serialising the parsed JSON does not reproduce
// the exact bytes that were signed.
app.use(express.json({
    verify(req, res, buf) {
        req.rawBody = buf && buf.length ? buf.toString("utf8") : "";
    }
}));
app.use(bodyParser.urlencoded({extended: true}));
// public/ is NOT served here. Vite is configured with publicDir: '../public',
// so the frontend's own deployment already ships css/, fonts/ and images/, and
// every font url in the stylesheet is root-absolute. Serving them from the API
// as well meant two hosts answering for the same assets.

mongoose.set({strictQuery: true});

// No hard-coded fallback. This line used to carry a real Atlas credential,
// which put a live username/password into a public repository from the first
// commit onward. Connection strings belong in the environment, so an unset
// MONGO_URI now stops the boot with a clear message instead of quietly
// connecting - or, worse, shipping somebody else's database in a fork.
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error(
        "MONGO_URI is not set.\n" +
        "  local:  add it to .env (see .env.example)\n" +
        "  deploy: set it in the Vercel project's environment variables"
    );
    process.exit(1);
}
mongoose.connect(MONGO_URI);

// Cookie + session secrets. These are REQUIRED in production: without them the
// session falls back to a shared dev secret, which means every deployment
// shares one key and anyone can forge a login cookie.
const COOKIE_SECRET = process.env.COOKIE_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

if ((!COOKIE_SECRET || !SESSION_SECRET) && IS_PRODUCTION) {
    console.error("FATAL: COOKIE_SECRET and SESSION_SECRET must be set in production.");
    process.exit(1);
}
if (!COOKIE_SECRET || !SESSION_SECRET) {
    console.warn("WARNING: COOKIE_SECRET / SESSION_SECRET unset - using a development fallback. Sessions will not survive a restart.");
}

app.use(cookieParser(COOKIE_SECRET));

// REQUIRED behind Vercel/nginx. Without it `req.secure` is false even though the
// request arrived over HTTPS, and express-session then silently refuses to emit
// a `secure` cookie - so every login appears to succeed and then bounces the
// user straight back to a signed-out page.
app.set("trust proxy", 1);

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // Vercel runs each invocation in a fresh container, so the default
    // in-memory store silently drops logins between requests.
    store: MongoStore.create({
        mongoUrl: MONGO_URI,
        collectionName: "sessions",
        ttl: 30 * 24 * 60 * 60, // 30 days
        autoRemove: "native"
    }),
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: "lax",
        // Only mark Secure when actually served over HTTPS. Behind a proxy this
        // relies on `app.set("trust proxy", 1)` above to read X-Forwarded-Proto.
        secure: IS_PRODUCTION ? "auto" : false
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// The guest store needs `res` to set its cookie; expose it on `req` once.
app.use(userData.attachResponse);
// attachUser is gone: it only set res.locals.currentUser for the EJS templates.
// The JSON routes read req.user directly, which passport populates.

// Schemas

const salahSchema = new mongoose.Schema({
    date: String,
    name: String,
    value: String
});
const Salah = mongoose.model("Salah", salahSchema);

const challengesSchema = new mongoose.Schema({
    challenge: String,
    currentStreak: Number,
    maxStreak: Number,
    lastUpdated: String
});
const Challenges = mongoose.model("Challenges", challengesSchema);

const settingsSchema = new mongoose.Schema({
    defaultHome: String,
    location: String,
    favoriteReciter: Number,
    favoriteFont: String,
    favoriteEdition: [String],
    lastReadSurahs: [String],
    theme: { type: String, default: 'light' },
    primaryTranslation: String,
    telegramBotToken: String,
    telegramChatId: String,
    audioProgress: {
        surahNo: Number,
        surahName: String,
        time: Number
    }
});
const Settings = mongoose.model("Settings", settingsSchema);

const AyahOfTheDay = require("./models/AyahOfTheDay.js");
// The daily ayah's text resolution lives in a service because the Telegram
// scheduler needs it too. It used to live here and read the same shared cached
// field the page read, so both showed whichever translation resolved first that
// day - usually the English default, because a guest usually arrives first.
const { resolveAyahText, DEFAULT_TRANSLATION, parseEdition } = require("./services/ayahOfDay.js");

// Duplicate form fields (same name twice) arrive as an array. Coerce them to a
// single sane value so a duplicate can never build a broken path like
// "/settings,/settings" or a token of "abc,def".
function pickField(value) {
  if (Array.isArray(value)) {
    const filled = value.filter((v) => v !== undefined && v !== null && String(v).trim() !== "");
    return filled.length ? filled[filled.length - 1] : "";
  }
  return value === undefined || value === null ? "" : value;
}

function todayDateKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}


function getFavoriteEditions(settings) {
    const raw = settings?.favoriteEdition;
    const editions = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const filled = editions.filter((v) => v && String(v).trim() !== '');
    // Fall back to the default rather than rendering an untranslated page.
    return filled.length ? filled : [DEFAULT_TRANSLATION];
}

function getPrimaryEdition(settings) {
    const editions = getFavoriteEditions(settings);
    if (!editions.length) return null;
    const primary = settings?.primaryTranslation;
    if (primary && editions.includes(primary)) return primary;
    if (primary) {
        const primaryId = parseEdition(primary).id;
        const match = editions.find((e) => parseEdition(e).id === primaryId);
        if (match) return match;
    }
    return editions[0];
}

// Fetch the ayah's text once and cache it on the document. Callers that only
// need the reference skip this via `includeText: false`.
async function getOrCreateAyahOfTheDay(surahs) {
    const date = todayDateKey();
    let entry = await AyahOfTheDay.findOne({ date });
    if (!entry) {
        const surahNo = Math.floor(Math.random() * 114) + 1;
        const totalAyah = Number(surahs[surahNo - 1]?.totalAyah) || 1;
        const ayahNo = Math.floor(Math.random() * totalAyah) + 1;

        try {
            entry = await AyahOfTheDay.create({ date, surahNo, ayahNo });
        } catch (err) {
            // Lost a race with a concurrent request; the unique date index means
            // exactly one document exists per day.
            entry = await AyahOfTheDay.findOne({ date });
        }
    }
    return entry;
}

const postsSchema = new mongoose.Schema({
    // Posts stay public (everyone can read the feed) but we remember who wrote
    // them, so the UI can attribute them.
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    authorName: { type: String, default: "" },
    content: String,
    reference: String,
    postedDate: String,
    isVideo: Boolean,
    // Stored as ids rather than a counter so a person can like once and unlike
    // later. The list itself is never sent to the browser; presentPost() turns
    // it into a count plus a per-viewer flag.
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
});
const Posts = mongoose.model("Posts", postsSchema);

// Keep like data useful without publishing the list of user ids. Every route
// that returns a post goes through this, otherwise one endpoint would leak
// `likedBy` while another returned `likeCount`.
function presentPost(post, req) {
    const raw = post && typeof post.toObject === "function" ? post.toObject() : { ...post };
    const likedBy = Array.isArray(raw.likedBy) ? raw.likedBy : [];
    const isLoggedIn = typeof req.isAuthenticated === "function" && req.isAuthenticated();
    const userId = isLoggedIn && req.user ? String(req.user._id) : null;
    raw.likeCount = likedBy.length;
    raw.likedByMe = Boolean(userId && likedBy.some((id) => {
        const value = id && id._id ? id._id : id;
        return String(value) === userId;
    }));
    delete raw.likedBy;
    return raw;
}

// global constants

//add new locations here - for support
const locationMap = new Map([
    ["Coimbatore", "1273865"],
    ["Salem", "1257629"],
    ["Hosur", "1269934"],
    ["Ramanathapuram", "1258740"],
    ["Bengaluru", "1277333"]
]);

const SKIP_MIDDLEWARE_URLS = ["/hide-audio"];

// Global methods

// app.use((req, res, next) => {

//     // Ensure session is initialized
//     req.session.canShowAudio = req.session.canShowAudio ?? false;

//     // Default: hide audio player unless session says it's active
//     res.locals.hideAudioPlayer = !req.session.canShowAudio;
  
//     res.locals.globalFavoriteReciter = req.session.favoriteReciterName || "1";
//     res.locals.globalAudioUrl = req.session.favoriteReciterUrl || null;
  
//     next();
// });

// app.use(async (req, res, next) => {
//     if (SKIP_MIDDLEWARE_URLS.includes(req.path)) {
//         return next();
//       }
//     // if (req.session.userId) {
//       const settings = await Settings.findOne({}).lean();
//       console.log(req.path);
//       console.log(settings);
//       if (settings && settings.audioProgress!=null) {
//         // console.log(settings.audioProgress);
//         const response = await fetch(`https://quranapi.pages.dev/api/${settings.lastRead}.json`);
//         const surah = await response.json();
//         res.locals.globalAudioUrl = surah.audio[settings.favoriteReciter].originalUrl; // implement this
//         res.locals.globalAudioTime = settings.audioProgress.time;
//         res.locals.globalSurahNo = settings.audioProgress.surahNo;
//         res.locals.globalSurahName = settings.audioProgress.surahName;
//         res.locals.globalFavoriteReciter = surah.audio[settings.favoriteReciter].reciter;
//         res.locals.canShowAudio = true;
//       }else{
//         res.locals.canShowAudio = false;
//       }
//     // }
//     next();
//   });

    // The middleware that used to sit here ran on EVERY request and only ever
    // wrote to res.locals - footerAudio, audioShell, theme. Nothing read any of
    // them. res.locals existed to feed the EJS templates; with those deleted it
    // has no consumer anywhere in the codebase (every res.locals.X written in
    // this file has zero reads).
    //
    // It was not free. It called getSettings() on every request, and whenever a
    // playback position was saved it fetched a surah document from
    // quranapi.pages.dev to build a footerAudio object no route ever returned.
    // The comment left in the middle of it had already noted the identical
    // problem for the daily ayah and removed that; this was the same bug one
    // block down, left behind.
    //
    // The React client restores the player from GET /api/quran/progress, which
    // resolves the surah and reciter itself. See Player.jsx.

  
  
    app.get("/api/surah-audio/:surahNo", async (req, res) => {
      const surahNo = parseInt(req.params.surahNo, 10);
      if (isNaN(surahNo) || surahNo < 1 || surahNo > 114) {
        return res.status(400).json({ error: "Invalid surah number" });
      }

      try {
        const settings = await userData.getSettings(req);
        const reciter = settings.favoriteReciter ? String(settings.favoriteReciter) : "1";
        const surah = await cachedJsonOrNull(`https://quranapi.pages.dev/api/${surahNo}.json`);

        if (!surah || !surah.audio || !surah.audio[reciter]) {
          return res.status(404).json({ error: "Audio not found for reciter" });
        }

        res.json({
          surahNo,
          surahName: surah.surahName,
          url: surah.audio[reciter].originalUrl,
          reciterName: surah.audio[reciter].reciter,
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch surah audio" });
      }
    });
  

  // POST /play-surah was removed. It wrote session.favoriteReciterName /
  // .favoriteReciterUrl / .canShowAudio, and every line that read them was
  // commented out - it had been dead for some time. The Audio tab now calls
  // window.quranAudio.play() directly against the footer player instead.

//   app.post('/update-audio-time', async (req, res) => {
//     // if(!req.locals.canShowAudio)
//     // {
//     //     res.sendStatus(200);
//     // }
//     // console.log(req);
//     const { surahNo, surahName, time } = req.body;
//     // if (req.session.userId) {
//       await Settings.findOneAndUpdate(
//         // { userId: req.session.userId },
//         {},
//         { 
//             $set: { 
//               audioProgress: { surahNo, surahName, time } 
//             } 
//         },
//         { upsert: true }
//       );
//     // }
//     res.sendStatus(200);
//   });

  

  // Public profile: /u/<username>. Posts stay public (the feed already is), so
// this is intentionally NOT behind requireLogin - it is the thing a user shares
// a link to. Lookup is case-insensitive to match how usernames are stored.
// Absolute origin for share links. `trust proxy` is configured, so req.protocol
// and the host header reflect the public URL rather than an internal hop.
function originOf(req) {
    const host = req.get("host");
    return host ? `${req.protocol || "https"}://${host}` : "";
}

  // Fan a new post out to subscribers. Bounded so a large subscriber list cannot
  // blow the invocation timeout; the rest catch up on their next visit.
  async function broadcastNewPost(post) {
    if (!botIsConfigured()) return;
    const subs = await User.find({
      "telegram.enabled": true,
      "telegram.events.newPost": true,
      telegramChatId: { $exists: true, $ne: "" },
    }).limit(100);

    const text = notify.buildNewPostMessage(post);
    for (const sub of subs) {
      await notify.safeDeliver(sub, text);
    }
  }

// GET methods

// --- Quran module ---------------------------------------------------------
// Three sub-modules sharing one page: Read, Audio and Favourites. They switch
// client-side so the audio element in the footer is never destroyed - a page
// load would stop playback mid-ayah, which is the bug the Audio module exists
// to fix.

// Resolves one surah's audio URL for the Audio tab. Fetched on demand rather
// than up front: the surah index carries no audio, so building a full 114-surah
// player would mean 114 upstream reads on first load.
const handleQuranAudio = async(req, res) => {
    const surahNo = parseInt(req.query.surahNo, 10);
    if (!Number.isInteger(surahNo) || surahNo < 1 || surahNo > 114) {
        return res.status(400).json({ error: "invalid-surah" });
    }

    const settings = await userData.getSettings(req);
    const requested = String(req.query.reciter || settings.favoriteReciter || "1");

    try {
        const surah = await cachedJsonOrNull(`https://quranapi.pages.dev/api/${surahNo}.json`);
        if (!surah || !surah.audio) return res.status(404).json({ error: "no-audio" });

        const track = surah.audio[requested] || surah.audio[1];
        if (!track) return res.status(404).json({ error: "no-audio" });

        res.json({
            url: track.originalUrl,
            reciter: track.reciter,
            reciterId: surah.audio[requested] ? requested : "1",
            surahNo,
            surahName: surah.surahName,
            totalAyah: surah.totalAyah
        });
    } catch (err) {
        console.error("quran/audio:", err.message);
        res.status(500).json({ error: "failed" });
    }
};

// Helper function to get current Hijri date
async function getCurrentHijriDate() {
    const data = await cachedJson('https://api.aladhan.com/v1/gToH');
    return {
      hijriMonth: parseInt(data.data.hijri.month.number),
      hijriYear: parseInt(data.data.hijri.year),
    };
  }

// Group the editions catalogue by language for the Settings picker. Shared by
// the EJS page and the JSON API - keeping it as a helper rather than inlining it
// twice is what stops the two settings UIs disagreeing about what is offered.
function groupEditionsByLanguage(editionsJson) {
    const grouped = {};
    for (const key in (editionsJson || {})) {
        const edition = editionsJson[key];
        const lang = edition.language || "Unknown";
        if (!grouped[lang]) grouped[lang] = [];
        grouped[lang].push({ name: edition.name, author: edition.author });
    }
    return grouped;
}

// Option catalogues for the settings page. Hoisted out of the route so the EJS
// page and the JSON API cannot drift - the first React version hardcoded these
// in the client, which is how the two would have disagreed about which fonts
// exist.
const TARTEEL_FONTS = {
    'QPC-Hafs': { label: 'QPC Hafs (Standard)', tag: 'HAFS' },
    'QPC-Nastaleeq': { label: 'QPC Hafs Nastaleeq', tag: 'HAFS' },
    'Indopak-Nastaleeq': { label: 'Indopak Nastaleeq', tag: 'INDOPAK' }
};

const HOME_OPTIONS = {
    salah: 'Salah',
    quran: 'Quran',
    audio: 'Audio',
    'salah-tracker': 'Salah Tracker',
    'salah-timings': 'Salah Timings',
    challenges: 'Challenges',
    charity: 'Charity',
    stats: 'Stats',
    posts: 'Posts',
    settings: 'Settings'
};

// defaultHome value -> the route that actually exists in the SPA.
//
// HOME_OPTIONS is the label list rendered in the settings dropdown, and several
// of its values predate the React migration and no longer have a page of their
// own: "audio" is now a tab inside /quran, "salah-tracker" is /salah (that is
// its nav label), and "analytics" never had a route at all. Redirecting to the
// raw value would land those on the 404 page, so map them explicitly.
// Anything unmapped falls back to /quran, which is where "/" went before this
// endpoint existed - so an unexpected stored value cannot make the app worse
// than it was.
const HOME_PATHS = {
    salah: "/salah",
    quran: "/quran",
    audio: "/quran",
    "salah-tracker": "/salah",
    "salah-timings": "/salah-timings",
    challenges: "/challenges",
    charity: "/charity",
    stats: "/stats",
    posts: "/posts",
    settings: "/settings"
};

const LOCATION_OPTIONS = ['Coimbatore', 'Hosur', 'Salem', 'Ramanathapuram', 'Bengaluru'];

// POST methods

async function notifyStreakUpdate(req, { formattedDate, completed, updatedChallenges }) {
    if (!botIsConfigured()) return;
    // Only the person who acted is notified, and only if they opted into this
    // module. Addressed by their own chat id - never broadcast.
    if (!req.isAuthenticated || !notify.wantsEvent(req.user, "challenges")) return;

    const text = notify.buildStreakSummary({
        date: formattedDate,
        completed,
        challenges: updatedChallenges,
    });

    await notify.safeDeliver(req.user, text);
}

// --- Auth ---

// Cooldown between resends. Without it the resend button is a way to mail-bomb
// an address, and Resend's own limit would be hit by a single impatient user.
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function pendingSignup(req) {
    const p = req.session.pendingSignup;
    if (!p) return { ok: false, reason: "no-pending" };
    if (Date.now() > p.expiresAt) {
        delete req.session.pendingSignup;
        return { ok: false, reason: "expired" };
    }
    return { ok: true, pending: p };
}

// Resolve a free username for an email, querying the users collection directly
// because `taken` is called in a loop until it finds a gap.
async function allocateUsername(email, excludeUserId = null) {
    const name = await usernameUtil.allocate(usernameUtil.fromEmail(email), async (candidate) => {
        const filter = { username: candidate };
        if (excludeUserId) filter._id = { $ne: excludeUserId };
        return Boolean(await User.exists(filter));
    });
    if (!name) throw new Error("could not allocate a username");
    return name;
}

// Reads back the user's most recent message to the bot so they never have to
// hunt down their own chat id.
// Persist the notification preferences carried by a settings submit. Shared by
// /settings and by the setup-code / connect buttons, which post the same form
// via formaction - without this, following the setup steps discarded the toggle
// the user had just switched on, because those requests re-render the page.
async function saveTelegramPrefs(req, body) {
    if (!req.isAuthenticated()) return;

    const user = req.user;
    user.telegram = user.telegram || {};

    // Partial updates, not a whole-form overwrite.
    //
    // The EJS settings page was one <form>, so every submit carried every field
    // and an unconditional assignment was safe. The React page saves per section
    // instead: toggling a single event posts { events, times } with no
    // tgEnabled, and this function did `user.telegram.enabled = String(body
    // .tgEnabled || "") === "on"` - which reads a missing key as "off". Ticking
    // one checkbox therefore switched the entire module off behind the user's
    // back, and the response was still { ok: true }. Navigating away and back
    // then showed the switch disabled, which is exactly what was reported.
    //
    // A field that is absent from the body is left alone. That is what a PATCH
    // means, and it makes the three current call shapes (master toggle, event
    // tick, time change) all safe without the client having to resend state it
    // is not changing.
    if (body.tgEnabled !== undefined) {
        user.telegram.enabled = String(body.tgEnabled) === "on";
    }

    const tgTimezone = String(body.tgTimezone || "").trim();
    if (tgTimezone) user.telegram.timezone = tgTimezone;

    // Events may arrive in either of two shapes, and the mismatch between them
    // is the actual bug this panel had.
    //
    // The EJS settings page was one <form> posting flat fields named after the
    // inputs - tgEventChallenges, tgEventSalahTracker, tgAyahTime. The React
    // page posts a nested object instead: { events: {...}, times: {...} }.
    // saveTelegramPrefs read only the flat names, so every nested payload was
    // silently dropped on arrival and the function then rebuilt `events` from
    // five undefined keys, writing all-false over whatever the user had.
    //
    // So ticking an event did two wrong things at once: it switched the whole
    // module off (enabled read a missing tgEnabled as "off") and it never stored
    // the event that was ticked. Both responses were { ok: true }, which is why
    // it looked like a save that simply did not stick on reload.
    //
    // Flat is still accepted because /telegram/setup-code and /telegram/chat-id
    // send it that way. Absent everywhere means "leave unchanged" - see the note
    // on tgEnabled above.
    const nestedEvents = body.events && typeof body.events === "object" ? body.events : null;
    const hasEvents = nestedEvents !== null
        || EVENT_FIELD_MAP.some(([, field]) => body[field] !== undefined);
    if (hasEvents) {
        const next = { ...(user.telegram.events || {}) };
        for (const [key, field] of EVENT_FIELD_MAP) {
            const source = nestedEvents ? nestedEvents[key] : body[field];
            if (source !== undefined) next[key] = source === true || String(source) === "on";
        }
        user.telegram.events = next;
    }

    // Same two-shape handling for times, and the same absence rule. normaliseHhMm
    // falls back to its default, so a missing time would otherwise have silently
    // reset to 05:30/05:00 rather than being preserved. The client happens to
    // always send times today, so this one was latent - "currently" is not a
    // guarantee worth writing a bug into.
    const nestedTimes = body.times && typeof body.times === "object" ? body.times : null;
    const hasTimes = nestedTimes !== null
        || body.tgAyahTime !== undefined || body.tgSalahTime !== undefined;
    if (hasTimes) {
        const ayah = nestedTimes ? nestedTimes.ayahOfTheDay : body.tgAyahTime;
        const salah = nestedTimes ? nestedTimes.salahTimings : body.tgSalahTime;
        user.telegram.times = {
            ayahOfTheDay: notify.normaliseHhMm(pickField(ayah), "05:30"),
            salahTimings: notify.normaliseHhMm(pickField(salah), "05:00")
        };
    }

    // Only accept a chat id that actually looks like one.
    const cleanChat = normalizeChatId(pickField(body.telegramChatId));
    if (cleanChat) user.telegramChatId = cleanChat;

    await user.save();
}

// Key in user.telegram.events -> field name in the request body. Single source
// so the read shape, the write shape and this mapping cannot drift apart; the
// list was previously spelled out inline here and in telegramPrefs.
const EVENT_FIELD_MAP = [
    ["challenges", "tgEventChallenges"],
    ["salahTracker", "tgEventSalahTracker"],
    ["newPost", "tgEventNewPost"],
    ["salahTimings", "tgEventSalahTimings"],
    ["ayahOfTheDay", "tgEventAyah"]
];

// Called on app load to deliver anything a signed-in user is owed (ayah of the
// day, daily digest). This is what makes scheduled times work without a
// long-running worker.
app.get("/api/due-notifications", async function(req, res){
    if (!req.isAuthenticated()) return res.status(401).json({ error: "login-required" });
    try {
        const fired = await scheduler.runDueForCurrentUser(req);
        res.json({ ok: true, fired });
    } catch (err) {
        console.error("due-notifications:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// QStash schedule entry point. Replaces the old shared-secret sweep: the request
// is only accepted when its Upstash-Signature checks out against the raw body,
// so nobody can trigger sends for every subscriber.
//
// This does NOT re-publish itself. The next tick is a QStash schedule, which
// cannot fork into duplicate chains - see api/utils/qstash.js for why that
// matters to cost.
app.post("/api/qstash/sweep", async function(req, res){
    if (!qstash.isConfigured()) {
        // No QStash settings, so this can only be an unauthenticated caller.
        // Fail closed rather than running a sweep for anyone who finds the URL.
        // Name the missing variables: "QStash is broken" is much harder to
        // diagnose than the specific one, and a wrong QSTASH_URL looks exactly
        // like a bad token unless it is called out.
        const missing = qstash.missingConfig();
        console.error("qstash sweep: not configured; missing " + missing.join(", "));
        return res.status(503).json({ error: "qstash-not-configured", missing });
    }

    const valid = await qstash.verify({
        signature: req.get("upstash-signature"),
        body: req.rawBody
    });
    if (!valid) {
        return res.status(401).json({ error: "invalid-signature" });
    }

    try {
        const result = await scheduler.sweepAllUsers();
        res.json({ ok: true, ...result });
    } catch (err) {
        // 5xx so QStash makes its one bounded retry rather than dropping the
        // tick - a missed window means a missed reminder.
        console.error("qstash sweep:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// app.post("/settings", function(req, res){
//   const {defaultHome, reciter, edition, location, redirectTo} = req.body;

//   Settings.findOneAndUpdate({}, { defaultHome: defaultHome, favoriteReciter: reciter, favoriteEdition: edition, location: location }, { sort: { _id: -1 }, upsert: true })
//         .then(() => {
//             res.redirect(redirectTo);
//         })
//         .catch((err) => {
//             console.error(err);
//             res.status(500).send("Error updating settings.");
//     });

module.exports = app;
module.exports.handler = serverless(app);

app.listen(process.env.PORT || 3000, function(){
    console.log("Server is running on port 3000");

    // Startup summary for the email transport, because a missing App Password
    // otherwise surfaces only as a signup form that quietly refuses - and the
    // request log in the Vercel UI does not include function stdout, so the
    // operator needs this in the Function Logs tab.
    //
    // Reports the provider and whether it looks usable. Never prints the token,
    // the App Password or the SMTP user: these land in log aggregation.
    const emailWarning = emailService.warning();
    console.log(
        `email transport: provider=${emailService.resolvedProvider()}`
        + ` configured=${emailService.isConfigured()}`
        + (emailWarning ? ` PROBLEM=${emailWarning}` : "")
    );
});

// ============================================================================
// JSON API for the React frontend.
//
// Everything above renders HTML. These endpoints return JSON for the same data,
// so the SPA can render a page without a server round trip through EJS.
//
// They deliberately reuse the existing helpers (cachedJson, editions, the
// preferences service) rather than reimplementing them: two code paths for one
// feature is how the EJS and React versions drift apart.
// ============================================================================

// Everything the Quran module needs for first paint, in one request. Splitting
// this into four would mean four round trips before anything is visible.
// Two paths, one handler. Registering the handler twice rather than having two
// copies of it is what stopped the two from drifting.
//
// BOTH lines were removed by the EJS cleanup and the audio tab broke with it:
// the removal script brace-matched from app.get("/quran/audio", handleQuranAudio);
// - a line with no braces at all - and swallowed the following registration too.
// Only the unprefixed path was EJS-era; /api/quran/audio is what the React
// client calls.
app.get("/quran/audio", handleQuranAudio);
app.get("/api/quran/audio", handleQuranAudio);

// Favourites. Restored: the EJS cleanup deleted these handlers outright, not
// just their registrations.
//
// The removal script brace-matched from a braceless delegation line -
// `app.get("/quran/favourites", handleQuranFavourites);` - and consumed the
// lines after it, so the /api registrations went with them and the favourites
// tab had no endpoint to call. /api only now; the unprefixed paths were
// EJS-era.
const handleQuranFavourites = async(req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).json({ error: "login-required" });
    }
    try {
        const settings = await userData.getSettings(req);
        const editionId = getPrimaryEdition(settings);
        const parsed = editionId ? parseEdition(editionId) : null;

        const entries = await favourites.resolveFavourites(req, {
            loadSurah: (n) => cachedJsonOrNull(`https://quranapi.pages.dev/api/${n}.json`),
            loadEdition: (id, n) => cachedJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${id}/${n}.json`),
            editionId: parsed ? parsed.id : "",
            // `lan`, not `language`: parseEdition returns {id, lan, author}. The
            // pre-cleanup version read parsed.language, which is always
            // undefined, so the label fell back to "Translation" on every row.
            editionLabel: parsed ? `${parsed.lan || "Translation"} - ${parsed.author || parsed.id}` : ""
        });

        res.json({ ok: true, entries });
    } catch (err) {
        console.error("quran/favourites:", err.message);
        res.status(500).json({ error: "failed" });
    }
};

const handleToggleFavourite = async(req, res) => {
    const settings = await userData.getSettings(req);
    // The surah's real length is enforced when it is known, so an out-of-range
    // ayah is rejected rather than stored and left permanently unresolvable.
    const surahNo = parseInt(req.body.surahNo, 10);
    let totalAyah;
    if (Number.isInteger(surahNo) && surahNo >= 1 && surahNo <= 114) {
        const meta = await cachedJsonOrNull("https://quranapi.pages.dev/api/surah.json").catch(() => null);
        totalAyah = meta && meta[surahNo - 1] ? meta[surahNo - 1].totalAyah : undefined;
    }

    const pair = favourites.normalise(surahNo, req.body.ayahNo, totalAyah);
    if (!pair) return res.status(400).json({ error: "invalid-reference" });

    try {
        const result = await userData.toggleFavourite(req, pair);
        res.json({ ok: true, favorited: result.favorited, surahNo: pair.surahNo, ayahNo: pair.ayahNo });
    } catch (err) {
        console.error("quran/favourites/toggle:", err.message);
        res.status(500).json({ error: "failed" });
    }
};

app.get("/api/quran/favourites", requireLogin, handleQuranFavourites);
app.post("/api/quran/favourites/toggle", requireLogin, handleToggleFavourite);

app.get("/api/quran/index", async function(req, res){
    const surahs = await cachedJsonOrNull(`https://quranapi.pages.dev/api/surah.json`);
    if (!surahs) return res.status(503).json({ error: "surah-index-unavailable" });

    const settings = await userData.getSettings(req);
    const edition = getPrimaryEdition(settings);
    const parsed = edition ? parseEdition(edition) : null;

    // Reciters are identical across surahs, so one surah's payload covers all.
    const reciterSource = await cachedJsonOrNull(`https://quranapi.pages.dev/api/1.json`);

    let ayah = null;
    try {
        const entry = await getOrCreateAyahOfTheDay(surahs);
        if (entry) {
            // Unconditional. The guard this replaces checked the top-level
            // translationText, which is only the cached copy of whichever
            // edition some other visitor happened to resolve first - so it
            // passed for the wrong viewer and served them that translation.
            // resolveAyahText returns immediately when this edition is cached.
            await resolveAyahText(entry, edition);
            const meta = surahs[entry.surahNo - 1] || {};
            ayah = {
                surahNo: entry.surahNo,
                ayahNo: entry.ayahNo,
                surahName: entry.surahName || meta.surahName || '',
                surahNameArabic: entry.surahNameArabic || meta.surahNameArabic || '',
                arabicText: entry.arabicText || '',
                translationText: entry.translationText || '',
                translationLabel: entry.translationLabel || ''
            };
        }
    } catch (err) {
        // The daily ayah is a nicety; failing it must not fail the page.
        console.error("api/quran/index: ayah of the day -", err.message);
    }

    res.json({
        surahs,
        ayahOfTheDay: ayah,
        lastReadSurahs: await userData.getLastReadSurahs(req),
        favoriteFont: settings.favoriteFont || 'QPC-Hafs',
        activeReciter: settings.favoriteReciter ? String(settings.favoriteReciter) : "1",
        reciters: reciterSource && reciterSource.audio
            ? Object.entries(reciterSource.audio).map(([id, a]) => ({ id: String(id), name: a.reciter }))
            : [],
        edition: parsed ? { id: parsed.id, label: `${parsed.language || 'Translation'} - ${parsed.author || parsed.id}` } : null,
        favouriteKeys: Array.from(favourites.keysFor(req)),
        isLoggedIn: Boolean(req.isAuthenticated && req.isAuthenticated())
    });
});

// One surah: Arabic plus the reader's chosen translations. This is the payload
// the reader page renders from, so it carries no HTML.
app.get("/api/quran/surah/:surahNo", async function(req, res){
    const surahNo = parseInt(req.params.surahNo, 10);
    if (!Number.isInteger(surahNo) || surahNo < 1 || surahNo > 114) {
        return res.status(400).json({ error: "invalid-surah" });
    }

    const settings = await userData.getSettings(req);
    const [surah, surahIndex] = await Promise.all([
        cachedJsonOrNull(`https://quranapi.pages.dev/api/${surahNo}.json`),
        // Neighbours carry names so the reader can offer a useful prev/next
        // instead of a bare number. The index is already cached for /quran.
        cachedJsonOrNull(`https://quranapi.pages.dev/api/surah.json`)
    ]);
    if (!surah) return res.status(503).json({ error: "surah-unavailable" });

    const neighbour = (n) => {
        const meta = Array.isArray(surahIndex) ? surahIndex[n - 1] : null;
        return {
            surahNo: n,
            surahName: (meta && meta.surahName) || `Surah ${n}`,
            surahNameArabic: (meta && meta.surahNameArabic) || ""
        };
    };

    const favoriteEdition = getFavoriteEditions(settings);
    const translations = [];

    // Parallel, and each failure isolated: one missing edition should not blank
    // the whole reader.
    await Promise.all(favoriteEdition.map(async (combined) => {
        const parts = combined.split(':');
        const id = parts[0];
        const language = parts[1] || '';
        const author = parts[2] || id;
        try {
            const data = await cachedJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${id}/${surahNo}.json`);
            if (data && Array.isArray(data.chapter)) {
                translations.push({ id, label: `${language} - ${author}`, texts: data.chapter.map((c) => c.text) });
            }
        } catch (err) {
            console.error(`api/quran/surah: edition ${id} -`, err.message);
        }
    }));

    // Opening a surah is what "last read" means. This used to only happen when
    // the player saved progress, so reading on the page left the Quran home
    // stuck on an older surah. Failure here must not cost the reader the page.
    try {
        await userData.recordSurahRead(req, surahNo);
    } catch (err) {
        console.error("api/quran/surah: last read -", err.message);
    }

    res.json({
        surahNo,
        surahName: surah.surahName,
        surahNameArabic: surah.surahNameArabic || "",
        surahNameTranslation: surah.surahNameTranslation || "",
        revelationPlace: surah.revelationPlace || "",
        totalAyah: surah.totalAyah,
        arabic: surah.arabic1 || [],
        translations,
        primaryTranslationId: (() => {
            const primary = getPrimaryEdition(settings);
            const parsed = primary ? parseEdition(primary) : null;
            return parsed ? parsed.id : null;
        })(),
        favoriteFont: settings.favoriteFont || 'QPC-Hafs',
        favouriteKeys: Array.from(favourites.keysFor(req)),
        isLoggedIn: Boolean(req.isAuthenticated && req.isAuthenticated()),
        previousSurah: surahNo > 1 ? neighbour(surahNo - 1) : null,
        nextSurah: surahNo < 114 ? neighbour(surahNo + 1) : null
    });
});

app.get("/api/quran/reciters", async function(req, res){
    const surah = await cachedJsonOrNull(`https://quranapi.pages.dev/api/1.json`);
    if (!surah || !surah.audio) return res.status(503).json({ error: "reciters-unavailable" });
    res.json({
        reciters: Object.entries(surah.audio).map(([id, a]) => ({ id: String(id), name: a.reciter }))
    });
});

app.post("/api/quran/reciter", async function(req, res){
    const reciter = String(req.body.reciter || "");
    // Rejected here rather than persisted: an unknown id would silently break
    // playback later, with the user having no way to tell why.
    const surah = await cachedJsonOrNull(`https://quranapi.pages.dev/api/1.json`).catch(() => null);
    if (!surah || !surah.audio || !surah.audio[reciter]) {
        return res.status(400).json({ error: "invalid-reciter" });
    }
    try {
        await userData.updateSettings(req, { favoriteReciter: reciter });
        res.json({ ok: true });
    } catch (err) {
        console.error("api/quran/reciter:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// Where the SPA should send a signed-out visitor when they tap a heart.
app.get("/api/session", function(req, res){
    res.json({
        isLoggedIn: Boolean(req.isAuthenticated && req.isAuthenticated()),
        username: (req.isAuthenticated && req.isAuthenticated() && req.user.username) || null
    });
});

// Everything the shell needs to render correctly on the first frame.
//
// The EJS app resolved the theme server-side and inlined it into <head>, so a
// dark-mode reader got a dark page immediately. The SPA boot only asked for
// /api/session, and the theme was applied by SettingsPage - which meant a fresh
// tab painted light and stayed light until the reader opened Settings. The
// "Default Home Page" setting was in the same state: / was hard-wired to the
// Quran page, so choosing anything else in Settings changed nothing.
//
// Deliberately small: no upstream catalogues, no reciters, no editions. That is
// /api/settings. This has to stay cheap enough to block the first paint on, so
// it only reads settings that are already in memory (req.user for a signed-in
// visitor, the signed guest cookie otherwise).
//
// no-store on purpose: the payload carries the session identity. A cached copy
// would show one account's name and theme to the next person on a shared
// browser. The theme is cached separately in localStorage, for paint only.
app.get("/api/app/meta", async function(req, res){
    const isLoggedIn = Boolean(req.isAuthenticated && req.isAuthenticated());

    let settings = {};
    try {
        settings = await userData.getSettings(req);
    } catch (err) {
        // A boot endpoint must not take the shell down with it. Defaults are a
        // better outcome than an error page; Settings will show the real values
        // when it loads.
        console.error("api/app/meta:", err.message);
    }

    // Resolve once. Quran is the safe default now that Salah requires an
    // account: a guest who lands in the app should reach something they can
    // actually use. Signed-in users still get whatever they configured.
    const defaultHome = settings.defaultHome || "quran";

    res.set("Cache-Control", "no-store");
    res.json({
        session: {
            isLoggedIn,
            username: (isLoggedIn && req.user.username) || null
        },
        theme: settings.theme === "dark" ? "dark" : "light",
        defaultHome,
        homePath: HOME_PATHS[defaultHome] || "/quran"
    });
});

// Position persistence for the React player. Separate from /update-audio-time
// because that one redirects (it is form-driven, from the EJS pages) while the
// SPA needs JSON.
app.post("/api/quran/progress", async function(req, res){
    const surahNo = parseInt(req.body.surahNo, 10);
    if (!Number.isInteger(surahNo) || surahNo < 1 || surahNo > 114) {
        return res.status(400).json({ error: "invalid-surah" });
    }
    const time = Number(req.body.time);
    if (!isFinite(time) || time < 0) return res.status(400).json({ error: "invalid-time" });

    try {
        await userData.recordAudioProgress(req, {
            surahNo,
            surahName: String(req.body.surahName || ""),
            time
        });
        res.json({ ok: true });
    } catch (err) {
        console.error("api/quran/progress:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// Restore the saved position on first load, so a page refresh resumes the
// recitation rather than starting over.
// Closing the player must survive a page load. Without this the bar could only
// be dismissed for the current session: close() cleared React state, but the
// `pause()` it performs fired the handler that saves the position, so the track
// was written straight back and restored on the next visit.
//
// DELETE, because it removes a resource. An empty POST would have been easier
// to write and wrong: the endpoint it sits beside already uses POST to SAVE
// progress, so a POST with no body reads as a malformed save rather than a
// deliberate clear.
app.delete("/api/quran/progress", async function(req, res){
    try {
        await userData.clearAudioProgress(req);
        res.json({ ok: true });
    } catch (err) {
        console.error("api/quran/progress (clear):", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.get("/api/quran/progress", async function(req, res){
    const settings = await userData.getSettings(req);
    const progress = settings.audioProgress;
    if (!progress || !progress.surahNo) return res.json({ track: null });

    const surah = await cachedJsonOrNull(`https://quranapi.pages.dev/api/${progress.surahNo}.json`).catch(() => null);
    const reciterId = String(settings.favoriteReciter || "1");
    const track = surah && surah.audio ? (surah.audio[reciterId] || surah.audio[1]) : null;
    if (!track) return res.json({ track: null });

    res.json({
        track: {
            url: track.originalUrl,
            surahNo: Number(progress.surahNo),
            surahName: progress.surahName || surah.surahName,
            reciterName: track.reciter,
            // Carried for the same reason as /api/quran/audio's reciterId: the
            // player's skip buttons resolve the next surah through this id.
            // Without it a restored track skipped with reciter 1 (Mishary),
            // silently overriding the user's saved reciter after any reload.
            reciterId: surah.audio[reciterId] ? reciterId : "1",
            startAt: Number(progress.time) || 0
        }
    });
});

// ============================================================================
// JSON API for challenges, salah and posts - the React equivalents of the
// EJS routes above. Same services, same validation, different serialiser.
// ============================================================================

// ---- Challenges ----

app.get("/api/challenges", async function(req, res){
    try {
        const keyChallenge = await userData.listChallenges(req);
        res.json({ challenges: keyChallenge, canManage: Boolean(req.isAuthenticated() && req.isAuthenticated()) });
    } catch (err) {
        console.error("api/challenges:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.post("/api/challenges", requireLogin, async function(req, res){
    const challenge = String(req.body.challenge || "").trim();
    if (!challenge) return res.status(400).json({ error: "invalid" });
    try {
        // addChallenge expects the name itself. Passing the whole body object
        // made Mongoose try to cast `{ challenge: ... }` to a string, which
        // returned 500 from the Add new challenge button.
        const challenges = await userData.addChallenge(req, challenge);
        res.status(201).json({ challenges });
    } catch (err) {
        console.error("api/challenges POST:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// The streaks route must run BEFORE the dynamic `:id` route: otherwise Express
// matches `/api/challenges/streaks` as a rename request and the whole route is
// silently unreachable.
app.post("/api/challenges/streaks", requireLogin, async function(req, res){
    const completed = [].concat(req.body.completed || []).map(String);

    const lastUpdated = new Date(req.body.date);
    if (isNaN(lastUpdated.getTime())) {
        return res.status(400).json({ error: "invalid-date" });
    }
    const formattedDate = lastUpdated.toLocaleDateString("en-US", {
        weekday: "long", month: "short", day: "2-digit", year: "numeric"
    });

    try {
        const allChallenges = await userData.applyStreakUpdate(req, {
            completedIds: completed,
            lastUpdated: formattedDate,
            // ISO key, not the display label: the stats report needs an unambiguous
            // day to plot, and the same-service helper stores exactly that.
            historyDate: userData.normaliseSalahDate(req.body.date)
        });
        const updatedChallenges = allChallenges.map((c) => ({
            id: String(c._id),
            name: c.challenge,
            currentStreak: c.currentStreak,
            maxStreak: c.maxStreak
        }));

        // Awaited for the same reason as the EJS route: on Vercel the function
        // can be frozen once the response is sent.
        await notifyStreakUpdate(req, { formattedDate, completed, updatedChallenges });

        res.json({ challenges: updatedChallenges, date: formattedDate });
    } catch (err) {
        console.error("api/challenges streaks:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.post("/api/challenges/:id", requireLogin, async function(req, res){
    const challenge = String(req.body.challenge || "").trim();
    if (!req.params.id || !challenge) return res.status(400).json({ error: "invalid" });
    try {
        // renameChallenge is the service method; it takes the id, not a lookup.
        await userData.renameChallenge(req, req.params.id, challenge);
        const all = await userData.listChallenges(req);
        const updated = all.find((c) => String(c._id) === String(req.params.id));
        if (!updated) return res.status(404).json({ error: "not-found" });
        res.json({ challenge: updated });
    } catch (err) {
        console.error("api/challenges update:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.delete("/api/challenges/:id", requireLogin, async function(req, res){
    try {
        await userData.deleteChallenge(req, req.params.id);
        const all = await userData.listChallenges(req);
        res.json({ ok: true, challenges: all });
    } catch (err) {
        console.error("api/challenges delete:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// ---- Charity ----
//
// The module is account-only: targets and a giving history are personal, and
// the same reason the salah log requires an account for writes. All routes read
// req.user, never an id carried in the body.
app.get("/api/charity", requireLogin, async function(req, res){
    try {
        const charities = await userData.listCharities(req);
        res.json({
            charities,
            canManage: true,
            periods: userData.CHARITY_PERIODS.map((id) => ({
                id,
                label: id.charAt(0).toUpperCase() + id.slice(1)
            }))
        });
    } catch (err) {
        console.error("api/charity:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.post("/api/charity", requireLogin, async function(req, res){
    try {
        const result = await userData.addCharity(req, req.body || {});
        if (result && result.duplicate) return res.status(409).json({ error: "duplicate" });
        if (result && result.loginRequired) return res.status(401).json({ error: "login-required" });
        if (!result) return res.status(400).json({ error: "invalid" });
        res.status(201).json({ charity: result });
    } catch (err) {
        console.error("api/charity POST:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.patch("/api/charity/:id", requireLogin, async function(req, res){
    try {
        const result = await userData.updateCharity(req, req.params.id, req.body || {});
        if (!result) return res.status(404).json({ error: "not-found" });
        if (result.invalid) return res.status(400).json({ error: "invalid" });
        res.json({ charity: result });
    } catch (err) {
        console.error("api/charity PATCH:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.delete("/api/charity/:id", requireLogin, async function(req, res){
    try {
        const removed = await userData.deleteCharity(req, req.params.id);
        if (!removed) return res.status(404).json({ error: "not-found" });
        res.json({ ok: true });
    } catch (err) {
        console.error("api/charity DELETE:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.post("/api/charity/:id/donate", requireLogin, async function(req, res){
    try {
        const result = await userData.addDonation(req, req.params.id, req.body || {});
        if (result && result.notFound) return res.status(404).json({ error: "not-found" });
        if (!result) return res.status(401).json({ error: "login-required" });
        if (result.invalid) return res.status(400).json({ error: "invalid" });
        res.json({ charity: result });
    } catch (err) {
        console.error("api/charity donate:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// ---- Salah log ----

app.get("/api/salah", async function(req, res){
    try {
        const entries = await userData.listSalah(req);
        // Optional ?date=YYYY-MM-DD, defaulting to today in the SERVER's zone.
        // The client's clock is not trusted: a device set to the wrong date
        // should not be able to write into another day.
        const day = userData.resolveSalahDay(req.query.date);
        const label = day.label || userData.resolveSalahDay().label;
        res.json({
            date: label,
            isoDate: day.parsed ? day.iso : userData.resolveSalahDay().iso,
            entries: userData.entriesForDay(entries, day),
            canManage: Boolean(req.isAuthenticated && req.isAuthenticated())
        });
    } catch (err) {
        console.error("api/salah:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.post("/api/salah", requireLogin, async function(req, res){
    try {
        // Normalise before storing. Unvalidated input is how "2026-10-17" and
        // "Sunday, Oct 11, 2026" ended up in one collection, which made
        // selection-by-date drop half of every user's history.
        const date = userData.normaliseSalahDate(req.body.date);
        if (!date) return res.status(400).json({ error: "bad-date" });
        if (!req.body.name || !req.body.value) {
            return res.status(400).json({ error: "bad-request" });
        }
        const updated = await userData.recordSalah(req, {
            date,
            name: String(req.body.name),
            value: String(req.body.value)
        });

        // Event-driven: this request is the trigger, so no scheduler is
        // involved. Restored verbatim from the EJS /salah route - the API port
        // dropped it, so the Salah Tracker module was savable from the settings
        // panel, appeared enabled, and was never delivered by anything. Nothing
        // else in the codebase can fire it: it is not in SCHEDULED_KEYS (only
        // ayahOfTheDay and salahTimings run on a clock) and buildSalahLogMessage
        // was otherwise reachable solely from buildModulePreview, the manual
        // "Send now" preview.
        //
        // `date`, not a locale-formatted label: recordSalah stores the normalised
        // YYYY-MM-DD key and buildSalahLogMessage filters on e.date === dateLabel,
        // so the two must match. The EJS version passed a long-form date because
        // EJS stored one - passing that here would match nothing and silently
        // render "Nothing logged yet today."
        if (botIsConfigured() && req.isAuthenticated && notify.wantsEvent(req.user, "salahTracker")) {
            await notify.safeDeliver(req.user, notify.buildSalahLogMessage(req.user, date));
        }

        res.json({ entries: updated });
    } catch (err) {
        console.error("api/salah POST:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// ---- Stats ----
//
// One report endpoint rather than one per module: the page wants all three
// modules side by side, and they already live on the same user document. The
// range is user-selectable because "last 30 days" and "last 90 days" answer
// different things without changing the data storage.
app.get("/api/stats", requireLogin, async function(req, res){
    try {
        const payload = statsService.buildStats(req.user, {
            days: Number(req.query.days) || 30,
            charityMonths: Number(req.query.charityMonths) || 6
        });
        res.json(payload);
    } catch (err) {
        console.error("api/stats:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// ---- Posts ----

app.get("/api/posts", async function(req, res){
    try {
        const post = await Posts.find({}).sort({ _id: -1 }).populate("author", "name username");
        res.json({ posts: post.map((entry) => presentPost(entry, req)), permalinkBase: originOf(req) });
    } catch (err) {
        console.error("api/posts:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.post("/api/posts", requireLogin, async function(req, res){
    let date = new Date(req.body.date);
    if (isNaN(date.getTime())) date = new Date();
    const formattedDate = date.toLocaleDateString("en-US", {
        weekday: "long", month: "short", day: "2-digit", year: "numeric"
    });

    const content = String(req.body.content || "").trim();
    const isVideo = Boolean(req.body.isVideo);
    // A video's content is its link; without one the embed is blank. The old
    // check only guarded text posts, so an empty video was accepted.
    if (!content) return res.status(400).json({ error: "empty-post" });

    try {
        const post = await Posts.create({
            postedDate: formattedDate,
            author: req.user._id,
            authorName: req.user.username || req.user.email,
            content,
            reference: String(req.body.reference || ""),
            isVideo
        });

        // Announce after the write resolves, and never let a broadcast failure
        // undo a post the user already successfully created.
        broadcastNewPost(post).catch((err) => console.error("notify: new post -", err.message));

        res.status(201).json({ post: presentPost(post, req) });
    } catch (err) {
        console.error("api/posts POST:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.get("/api/posts/:id", async function(req, res){
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "not-found" });
    try {
        const post = await Posts.findById(req.params.id).populate("author", "username name");
        if (!post) return res.status(404).json({ error: "not-found" });
        res.json({ post: presentPost(post, req), permalinkBase: originOf(req) });
    } catch (err) {
        console.error("api/posts/:id:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// Likes are account-only, matching the ayah favourites. The body carries no
// user id: it comes from the session, so one person cannot like as another.
app.post("/api/posts/:id/like", requireLogin, async function(req, res){
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "not-found" });
    try {
        const post = await Posts.findById(req.params.id);
        if (!post) return res.status(404).json({ error: "not-found" });

        post.likedBy = post.likedBy || [];
        const userId = String(req.user._id);
        const index = post.likedBy.findIndex((id) => String(id) === userId);
        const liked = index === -1;
        if (liked) post.likedBy.push(req.user._id);
        else post.likedBy.splice(index, 1);
        await post.save();

        res.json({ ok: true, liked, likeCount: post.likedBy.length });
    } catch (err) {
        console.error("api/posts/:id/like:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// Edit a post. Ownership is decided from the stored author id, never from
// anything in the body: the feed and profiles are public, so a client can send
// any id it likes and the endpoint has to be the one that says no.
//
// The post type is fixed at creation. A video's `content` is a YouTube id and a
// text post's is its body, so allowing isVideo to flip here would let an edit
// quietly change which one the value means.
app.patch("/api/posts/:id", requireLogin, async function(req, res){
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "not-found" });
    try {
        const post = await Posts.findById(req.params.id);
        if (!post) return res.status(404).json({ error: "not-found" });
        if (!post.author || String(post.author) !== String(req.user._id)) {
            return res.status(403).json({ error: "forbidden" });
        }

        const content = String(req.body.content || "").trim();
        if (!content) return res.status(400).json({ error: "empty-post" });

        post.content = content;
        post.reference = String(req.body.reference || "").trim();
        await post.save();

        const populated = await post.populate("author", "username name");
        res.json({ post: presentPost(populated, req) });
    } catch (err) {
        console.error("api/posts/:id PATCH:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// Delete a post. Same ownership rule as PATCH. The feed is public, so the
// permalink is too - being able to read one is not permission to remove it.
app.delete("/api/posts/:id", requireLogin, async function(req, res){
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "not-found" });
    try {
        const post = await Posts.findById(req.params.id);
        if (!post) return res.status(404).json({ error: "not-found" });
        if (!post.author || String(post.author) !== String(req.user._id)) {
            return res.status(403).json({ error: "forbidden" });
        }

        await post.deleteOne();
        res.json({ ok: true });
    } catch (err) {
        console.error("api/posts/:id DELETE:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// ---- Profile ----

app.get("/api/u/:username", async function(req, res){
    try {
        const author = await User.findOne({ username: String(req.params.username || "").toLowerCase() })
            .select("username name createdAt");
        if (!author) return res.status(404).json({ error: "not-found" });

        const posts = await Posts.find({ author: author._id }).sort({ _id: -1 });
        const isOwner = Boolean(req.isAuthenticated() && req.user && String(req.user._id) === String(author._id));
        res.json({
            owner: author,
            posts: posts.map((post) => presentPost(post, req)),
            permalinkBase: originOf(req),
            isOwner
        });
    } catch (err) {
        console.error("api/u/:username:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// ---- Account ----

app.get("/api/account", requireLogin, function(req, res){
    const user = req.user;
    const username = user.username || "";
    res.json({
        username,
        displayName: username || user.name || (user.email || "?").split("@")[0],
        email: user.email,
        // emailVerifiedAt only exists on accounts created since OTP signup.
        verified: Boolean(user.emailVerifiedAt)
    });
});

// ---- Settings ----

// One payload rather than several: the settings page needs all of it at once,
// and the upstream reads behind it are already cached.
app.get("/api/settings", async function(req, res){
    try {
        const settings = await userData.getSettings(req);

        const [recitersJson, editionsJson] = await Promise.all([
            cachedJsonOrNull("https://quranapi.pages.dev/api/reciters.json"),
            cachedJsonOrNull("https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions.json")
        ]);

        res.json({
            settings: {
                defaultHome: settings.defaultHome || "quran",
                location: settings.location || "Coimbatore",
                favoriteReciter: settings.favoriteReciter || 1,
                favoriteFont: settings.favoriteFont || "QPC-Hafs",
                favoriteEdition: getFavoriteEditions(settings),
                primaryTranslation: getPrimaryEdition(settings) || "",
                theme: settings.theme || "light"
                // audioProgress removed: no frontend file reads it. The player
                // restores from GET /api/quran/progress, which is the only
                // consumer, and it resolves the audio URL itself. Shipping it
                // here duplicated data into a payload the Settings page never
                // used.
            },
            // reciters.json is an object keyed by id ("1": "Name"), which the
            // EJS page iterates directly. Normalised to a list here so the
            // client is not handed two different shapes for the same data.
            reciters: Object.entries(recitersJson || {}).map(([id, name]) => ({ id: String(id), name })),
            fonts: TARTEEL_FONTS,
            homeOptions: HOME_OPTIONS,
            locationOptions: LOCATION_OPTIONS,
            // Language names only. The full catalogue is 98 languages and ~32KB,
            // which was 96% of this response and made the settings page the
            // slowest in the app. Editions are fetched per language on demand -
            // see GET /api/editions.
            editionLanguages: Object.keys(groupEditionsByLanguage(editionsJson)).sort(),
            telegram: {
                enabled: Boolean(notify.telegramPrefs(req.user).enabled),
                chatId: await userData.getTelegramChatId(req),
                botConfigured: botIsConfigured(),
                prefs: notify.telegramPrefs(req.user)
            },
            username: (req.isAuthenticated && req.isAuthenticated() && req.user.username) || "",
            isLoggedIn: Boolean(req.isAuthenticated && req.isAuthenticated())
        });
    } catch (err) {
        console.error("api/settings:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// ============================================================================
// JSON settings API.
//
// The EJS settings page POSTs one large form. The React page does the same
// thing in pieces as the user changes each section, so these endpoints persist
// the same fields through the same userData.updateSettings call - one route per
// concern rather than one route per UI, which keeps the write path identical.
//
// Telegram gets JSON equivalents of the three redirect-only routes, because the
// client has to be able to tell "code issued" from "chat not found" without
// parsing a Location header.
// ============================================================================

// Everything the settings page edits, in one payload. Partial updates are
// fine: absent keys are simply not touched.
app.post("/api/settings", async function(req, res){
    const body = req.body || {};
    const patch = {};

    if (body.theme !== undefined) patch.theme = String(body.theme);
    if (body.defaultHome !== undefined) patch.defaultHome = String(body.defaultHome);
    if (body.font !== undefined) patch.favoriteFont = String(body.font);
    if (body.location !== undefined) patch.location = String(body.location);
    if (body.primaryTranslation !== undefined) patch.primaryTranslation = String(body.primaryTranslation);

    // Reciter is validated against the live catalogue rather than trusted, for
    // the same reason /reciter validates: an unknown id would break playback
    // later with nothing to point at.
    if (body.reciter !== undefined && body.reciter !== "") {
        const reciter = String(body.reciter);
        if (!/^\d+$/.test(reciter)) return res.status(400).json({ error: "invalid-reciter" });
        const catalogue = await cachedJsonOrNull("https://quranapi.pages.dev/api/reciters.json").catch(() => null);
        if (catalogue && !catalogue[reciter]) return res.status(400).json({ error: "unknown-reciter" });
        patch.favoriteReciter = reciter;
    }

    // Editions arrive as the same combined "id:language:author" strings the EJS
    // form sends, so getFavoriteEditions keeps working unchanged.
    if (body.edition !== undefined) {
        const value = body.edition;
        patch.favoriteEdition = Array.isArray(value)
            ? value
            : (String(value).split(",").map((s) => s.trim()).filter(Boolean));
    }

    try {
        await userData.updateSettings(req, patch);
        res.json({ ok: true, patch });
    } catch (err) {
        console.error("api/settings POST:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// ---- Telegram: JSON equivalents of the redirect-only routes ----

app.post("/api/telegram/setup-code", requireLogin, async function(req, res){
    if (!botIsConfigured()) return res.status(503).json({ error: "bot-not-configured" });
    try {
        // Persist the toggle the user just flipped, so issuing a code does not
        // silently discard it - the same reason the EJS route does this.
        await saveTelegramPrefs(req, req.body);
        const code = makeVerifyCode();
        req.session.tgVerifyCode = code;
        req.session.tgVerifyCodeAt = Date.now();
        // The code is returned so the UI can show it if the user cannot see the
        // email, e.g. because Resend is in sandbox mode.
        res.json({ ok: true, code });
    } catch (err) {
        console.error("api/telegram/setup-code:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.post("/api/telegram/chat-id", requireLogin, async function(req, res){
    if (!botIsConfigured()) return res.status(503).json({ error: "bot-not-configured" });
    try {
        await saveTelegramPrefs(req, req.body);

        const code = req.session.tgVerifyCode;
        const issuedAt = req.session.tgVerifyCodeAt || 0;
        if (!code || Date.now() - issuedAt > 15 * 60 * 1000) {
            return res.status(400).json({ error: "no-code" });
        }

        const result = await claimChatByCode(undefined, code);
        if (!result.chatId) {
            return res.status(400).json({ error: result.code || "no-messages" });
        }

        await userData.setTelegramChatId(req, result.chatId);
        // One-shot, so a stale code cannot rebind someone later.
        delete req.session.tgVerifyCode;
        delete req.session.tgVerifyCodeAt;

        res.json({ ok: true, chatId: result.chatId });
    } catch (err) {
        console.error("api/telegram/chat-id:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.post("/api/telegram/test", requireLogin, async function(req, res){
    if (!botIsConfigured()) return res.status(503).json({ error: "bot-not-configured" });

    try {
        const chatId = await userData.getTelegramChatId(req);
        if (!chatId) return res.status(400).json({ error: "missing-chat" });

        const module = req.body.module;
        const known = notify.EVENT_KEYS.concat(["all"]);
        if (module && !known.includes(module)) return res.status(400).json({ error: "unknown-module" });

        const dateLabel = scheduler.dateLabelIn(
            (req.user.telegram && req.user.telegram.timezone) || "UTC", new Date()
        );

        const text = module
            ? await notify.buildModulePreview(req.user, module, { dateLabel })
            : `<b>Hasanath</b> — test message\n\nTelegram notifications are connected.`;
        if (!text) return res.status(400).json({ error: "unknown-module" });

        const result = await sendTelegramMessage({ chatId, text });
        if (!result.sent) return res.status(502).json({ error: result.code || "send-failed" });
        res.json({ ok: true, module: module || "all" });
    } catch (err) {
        console.error("api/telegram/test:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// Persists the notification preferences on their own, so the React settings page
// can save one toggle without posting the whole form. Same helper the EJS
// /settings route uses, so the two write identical state.
app.post("/api/telegram/prefs", requireLogin, async function(req, res){
    try {
        await saveTelegramPrefs(req, req.body);
        res.json({ ok: true });
    } catch (err) {
        console.error("api/telegram/prefs:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// ============================================================================
// JSON API: salah timings and the Islamic calendar.
//
// Both were single-purpose EJS routes whose entire body was "fetch upstream,
// parse, render". The work is extracted into functions so the HTML route and
// the JSON route share it, rather than one of them becoming a second copy that
// quietly rots.
// ============================================================================

// Scrape the prayer widget into a plain object. Shared by /salah-timings and
// /api/salah-timings.
async function fetchPrayerDetails(location) {
    const response = await islamicFinderFetch(
        `https://www.islamicfinder.org/prayer-widget/${locationMap.get(location)}/shafi/3/0/18.0/18.0`
    );
    const pageHtml = await response.text();
    const $ = cheerio.load(pageHtml);

    const prayerTimes = [];
    $(".d-flex.flex-direction-row").each((index, element) => {
        prayerTimes.push({
            timeType: $(element).find("p").first().text().trim(),
            time: $(element).find("p").last().text().trim()
        });
    });

    return {
        location: $(".table-controller a").first().text().trim(),
        hijriDate: $(".table-controller div").first().text().trim(),
        date: new Date().toLocaleDateString("en-US", {
            weekday: "long", month: "short", day: "2-digit", year: "numeric"
        }),
        prayerTimes
    };
}

app.get("/api/salah-timings", async function(req, res){
    try {
        const settings = await userData.getSettings(req);
        const saved = settings.location || "Coimbatore";
        // An override lets the client show a newly chosen location immediately,
        // rather than waiting for the settings write to be visible on re-read.
        const requested = String(req.query.location || "");
        // Only accept a location the app knows how to map, since locationMap is
        // what turns a name into the widget's city id.
        const location = requested && locationMap.has(requested) ? requested : saved;
        res.json({ location, details: await fetchPrayerDetails(location) });
    } catch (err) {
        console.error("api/salah-timings:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// Scrape the special-days table. Shared by /calendar and /api/calendar.
async function fetchSpecialDays() {
    const response = await islamicFinderFetch(`https://www.islamicfinder.org/specialislamicdays`);
    const $ = cheerio.load(await response.text());
    const specialDays = [];

    $("#special-days-table tr").each((index, element) => {
        const month = $(element).find(".date-box .title span").text().trim();
        const day = $(element).find(".date-box .date span").text().trim();
        const event = $(element).find(".day-details h2 a").text().trim();
        const heading = $(element).find(".day-details h4").text();
        if (month && day && event) {
            specialDays.push({
                date: `${month} ${day}`,
                event,
                weekday: heading.split(",")[0].trim(),
                hijriDate: heading.split(",")[1] ? heading.split(",")[1].trim() : "",
                hijriYear: heading.split(",")[2] ? heading.split(",")[2].trim() : ""
            });
        }
    });
    return specialDays;
}

app.get("/api/calendar", async function(req, res){
    try {
        // ?month= and ?year= default to the current Hijri month, and the month
        // name / year labels are taken from the payload rather than computed, so
        // they always agree with the grid.
        let hijriMonth = parseInt(req.query.month, 10);
        let hijriYear = parseInt(req.query.year, 10);
        if (!hijriMonth) hijriMonth = (await cachedJson('https://api.aladhan.com/v1/currentIslamicMonth')).data;
        if (!hijriYear) hijriYear = (await cachedJson('https://api.aladhan.com/v1/currentIslamicYear')).data;

        const json = await cachedJson(`https://api.aladhan.com/v1/hToGCalendar/${hijriMonth}/${hijriYear}`);

        const days = json.data.map((d) => ({
            hijri: d.hijri.day,
            gregorian: d.gregorian.day,
            weekday: d.gregorian.weekday.en,
            date: d.gregorian.date,
            fullHijri: `${d.hijri.day} ${d.hijri.month.en} ${d.hijri.year}`
        }));

        // Pad the front so the first day lands under the right weekday column.
        const first = json.data.find((d) => d && d.gregorian && d.gregorian.date);
        const firstWeekday = first ? (isNaN(new Date(first.gregorian.date).getDay()) ? 0 : new Date(first.gregorian.date).getDay()) : 0;

        const padded = Array(firstWeekday).fill(null).concat(days);
        const weeks = [];
        for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));

        res.json({
            hijriMonth: json.data[0].hijri.month.en,
            hijriMonthNumber: hijriMonth,
            hijriYear: Number(hijriYear),
            gregorianMonth: json.data[0].gregorian.month.en,
            gregorianYear: json.data[0].gregorian.year,
            weeks,
            specialDays: await fetchSpecialDays()
        });
    } catch (err) {
        console.error("api/calendar:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// Editions catalogue, fetched on demand rather than shipped with every settings
// response. ?lang= returns one language, ?q= searches across all of them - which
// is what the settings page does when the user types into the edition search.
//
// The upstream read is already cached, so this is cheap; what it avoids is
// serialising 32KB on every settings load.
app.get("/api/editions", async function(req, res){
    try {
        const editionsJson = await cachedJsonOrNull("https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions.json");
        if (!editionsJson) return res.status(503).json({ error: "editions-unavailable" });

        const grouped = groupEditionsByLanguage(editionsJson);
        const q = String(req.query.q || "").trim().toLowerCase();
        const lang = String(req.query.lang || "");

        if (lang) {
            return res.json({ editions: grouped[lang] || [], languages: Object.keys(grouped).sort() });
        }

        if (q) {
            const hits = [];
            for (const [language, list] of Object.entries(grouped)) {
                for (const e of list) {
                    if (`${e.author} ${language}`.toLowerCase().includes(q)) hits.push({ ...e, language });
                }
            }
            // Capped so a one-character search cannot return hundreds of rows.
            return res.json({ editions: hits.slice(0, 50), truncated: hits.length > 50 });
        }

        res.json({ editions: [], languages: Object.keys(grouped).sort() });
    } catch (err) {
        console.error("api/editions:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// ============================================================================
// JSON auth for the React login / register / verify screens.
//
// The EJS routes render pages on every outcome. These return status codes and a
// message instead, but the underlying operations are the same functions: the
// same validation, the same OTP session fields, the same passport strategy. The
// email and password are never handled differently between the two.
// ============================================================================

const AUTH_MESSAGES = {
    'invalid-email': 'Enter a valid email address.',
    'weak-password': 'Password must be at least 6 characters.',
    'mismatch': 'Passwords do not match.',
    'duplicate': 'That email is already registered.',
    'invalid-credentials': 'Invalid email or password.',
    'invalid-code': 'That code is not correct.',
    'expired': 'That code has expired. Please register again.',
    'no-pending': 'Start by registering again.',
    'too-many-attempts': 'Too many incorrect attempts. Please register again.',
    'email-not-sent': 'We could not send a verification email. Please try again.'
};

app.post("/api/auth/register", async function(req, res){
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const confirm = String(req.body.cpassword || "");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "invalid-email" });
    if (password.length < 6) return res.status(400).json({ error: "weak-password" });
    if (password !== confirm) return res.status(400).json({ error: "mismatch" });

    try {
        if (await User.exists({ email })) return res.status(409).json({ error: "duplicate" });
    } catch (err) {
        return res.status(500).json({ error: "failed" });
    }

    const code = emailService.makeOtp();
    const { hash, salt } = passwordUtil.createPasswordRecord(password);
    req.session.pendingSignup = {
        email, hash, salt,
        otpHash: emailService.hashOtp(code),
        expiresAt: Date.now() + 10 * 60 * 1000,
        attempts: 0,
        sentAt: Date.now()
    };

    const sent = await emailService.sendOtpEmail({ to: email, code });
    if (!sent.ok) {
        // No half-started signup left behind: without a delivered code there is
        // nothing the user can do but retry.
        delete req.session.pendingSignup;
        return res.status(502).json({ error: "email-not-sent" });
    }

    res.json({ ok: true, email, message: AUTH_MESSAGES });
});

app.post("/api/auth/resend", async function(req, res){
    const { ok, pending } = pendingSignup(req);
    if (!ok) return res.status(400).json({ error: "expired" });

    const elapsed = Date.now() - (pending.sentAt || 0);
    if (elapsed < OTP_RESEND_COOLDOWN_MS) {
        return res.status(429).json({
            error: 'cooldown',
            wait: Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000)
        });
    }

    const code = emailService.makeOtp();
    pending.otpHash = emailService.hashOtp(code);
    pending.sentAt = Date.now();
    pending.attempts = 0;
    req.session.pendingSignup = pending;

    const sent = await emailService.sendOtpEmail({ to: pending.email, code });
    if (!sent.ok) return res.status(502).json({ error: "email-not-sent" });
    res.json({ ok: true, message: AUTH_MESSAGES });
});

app.post("/api/auth/verify", async function(req, res){
    const code = String(req.body.code || "").replace(/\D/g, "");
    const { ok, pending, reason } = pendingSignup(req);

    if (!ok) return res.status(400).json({ error: reason === "expired" ? "expired" : "no-pending" });
    if (code.length !== 6) return res.status(400).json({ error: 'invalid-code' });

    if (!emailService.otpMatches(pending.otpHash, code)) {
        // Counted, so a 6-digit code cannot be brute-forced. 10^6 is small
        // enough that an unthrottled attacker would get through it.
        pending.attempts = (pending.attempts || 0) + 1;
        if (pending.attempts >= OTP_MAX_ATTEMPTS) {
            delete req.session.pendingSignup;
            return res.status(429).json({ error: "too-many-attempts" });
        }
        return res.status(400).json({
            error: "invalid-code",
            attemptsLeft: OTP_MAX_ATTEMPTS - pending.attempts,
            message: AUTH_MESSAGES
        });
    }

    try {
        const user = await User.create({
            email: pending.email,
            hash: pending.hash,
            salt: pending.salt,
            username: await allocateUsername(pending.email),
            emailVerifiedAt: new Date()
        });

        delete req.session.pendingSignup;
        await mergeGuestIntoUser(req, user);
        req.logIn(user, (err) => {
            if (err) return res.status(500).json({ error: "failed" });
            userData.clearGuestCookie(req, res);
            res.json({ ok: true, username: user.username });
        });
    } catch (err) {
        const isDuplicate = (err && err.code === 11000) || (err && err.name === "UserExistsError");
        if (isDuplicate) {
            delete req.session.pendingSignup;
            return res.status(409).json({ error: "duplicate" });
        }
        console.error("api/auth/verify:", err);
        res.status(500).json({ error: "failed" });
    }
});

app.post("/api/auth/login", function(req, res, next){
    const email = String(req.body.email || "").trim().toLowerCase();

    passport.authenticate("local", function(err, user, info){
        if (err) return next(err);
        if (!user) return res.status(401).json({ error: "invalid-credentials" });

        req.logIn(user, (err) => {
            if (err) return res.status(500).json({ error: "failed" });
            // The guest cookie is cleared only after the session is established,
            // same order as the EJS route - clearing it first would lose the
            // data being merged.
            userData.clearGuestCookie(req, res);
            res.json({ ok: true, username: user.username || null });
        });
    })(req, res, next);
});

// Sign out. The React app cannot POST to /logout: the frontend's vercel.json
// only forwards /api/* to this backend, so a plain form action would be
// swallowed by the SPA catch-all and return index.html - i.e. Sign out would
// silently do nothing. Every write the client makes must live under /api.
app.post("/api/auth/logout", function(req, res){
    req.logout((err) => {
        if (err) return res.status(500).json({ error: "failed" });
        // Destroy the session rather than just clearing req.session: a session
        // that survives logout can still be resumed with its cookie.
        if (req.session && typeof req.session.destroy === "function") {
            req.session.destroy(() => res.json({ ok: true }));
            return;
        }
        res.json({ ok: true });
    });
});

// ---- Everything else redirects to the frontend -----------------------------
//
// The React SPA is the only user-facing surface; this backend serves /api/*.
// A bare path reaching here used to be server-rendered, so old links are still
// out there - /posts, /surah/18, /u/umirfan29 in anything shared or bookmarked.
//
// Redirect rather than 404 so those keep working. Uses FRONTEND_URL when set,
// and otherwise derives it, so local development redirects to Vite instead of
// bouncing the developer to production.
//
// POSTs are NOT redirected: a 302 turns them into GETs and silently discards
// the body, which is how the old form handlers quietly lost data. Those now
// return 405 with a pointer to the JSON endpoint.
const FRONTEND_URL = (
    process.env.FRONTEND_URL ||
    (process.env.NODE_ENV === "production"
        ? "https://hasanath.vercel.app"
        : "http://localhost:5173")
).replace(/\/+$/, "");

app.use(function(req, res){
    // Unknown API path: JSON 404, never a redirect. The client is expecting
    // JSON and reports a parse failure on an HTML body.
    if (req.path === "/api" || req.path.startsWith("/api/")) {
        return res.status(404).json({ error: "not-found", path: req.path });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
        return res.status(405).json({
            error: "method-not-allowed",
            hint: "This backend serves the JSON API under /api. Use the React frontend.",
            path: req.path
        });
    }

    res.redirect(302, FRONTEND_URL + req.originalUrl);
});
