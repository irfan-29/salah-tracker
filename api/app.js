require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const serverless = require("serverless-http");
const path = require("path");
const mongoose = require("mongoose");
const ejs = require("ejs");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const session = require('express-session');
const cookieParser = require("cookie-parser");
const { MongoStore } = require("connect-mongo");

// internal
const { islamicFinderFetch } = require("../api/utils/islamic-finder.js");
const { sendTelegramMessage, claimChatByCode, makeVerifyCode, buildStreakSummary, normalizeChatId, normalizeToken, extractToken, isValidToken, botIsConfigured, ERROR_MESSAGES } = require("../api/utils/telegram.js");
const { passport, requireLogin, attachUser } = require("./middleware/auth.js");
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
const User = require("./models/User.js");



const app=express();

app.set('view engine', 'ejs');
// QStash signs the raw request body, so keep an untouched copy. Without this the
// signature cannot be verified: re-serialising the parsed JSON does not reproduce
// the exact bytes that were signed.
app.use(express.json({
    verify(req, res, buf) {
        req.rawBody = buf && buf.length ? buf.toString("utf8") : "";
    }
}));
app.use(bodyParser.urlencoded({extended: true}));
// app.use(express.static("public"));
app.use(express.static(path.join(__dirname, "../public")));
app.set("views", path.join(__dirname, "../views"));

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
// Lets nav and views branch on sign-in state.
app.use(attachUser);






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

function parseEdition(combinedStr) {
    const parts = String(combinedStr || '').split(':');
    return {
        id: parts[0] || '',
        lan: parts[1] || '',
        author: parts[2] || parts[0] || ''
    };
}

// Shown to anyone who hasn't chosen a translation yet, so the surah page and
// the daily ayah are never blank for a guest or a brand-new account.
// Abdullah Yusuf Ali is a widely used, freely available English translation.
const DEFAULT_TRANSLATION = "eng-abdullahyusufal:English:Abdullah Yusuf Ali";

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
async function resolveAyahText(entry, edition) {
    if (!entry || entry.arabicText !== undefined && entry.translationText !== undefined && entry.arabicText !== null) {
        return entry;
    }
    const chosen = edition || DEFAULT_TRANSLATION;
    const { id, lan, author } = parseEdition(chosen);

    try {
        const [arabicSurah, translationJson] = await Promise.all([
            cachedJson(`https://quranapi.pages.dev/api/${entry.surahNo}.json`),
            cachedJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${id}/${entry.surahNo}.json`)
        ]);
        const ayahIndex = entry.ayahNo - 1;

        entry.arabicText = arabicSurah.arabic1?.[ayahIndex] || "";
        entry.translationText = translationJson.chapter?.[ayahIndex]?.text || "";
        entry.translationLabel = `${lan} - ${author}`;
        entry.surahName = arabicSurah.surahName || entry.surahName;
        entry.surahNameArabic = arabicSurah.surahNameArabic || entry.surahNameArabic;
        entry.resolvedAt = new Date();
        await entry.save();
    } catch (err) {
        // Never let an upstream fetch failure break the page.
        console.error("ayah of the day: text fetch failed -", err.message);
    }
    return entry;
}

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
    isVideo: Boolean
});
const Posts = mongoose.model("Posts", postsSchema);






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

    app.use(async (req, res, next) => {
      res.locals.footerAudio = null;
      // The daily ayah is global: one document per date, identical for every
      // visitor, so it can be resolved once and shared.
      res.locals.ayahOfTheDay = null;

      const settings = await userData.getSettings(req);
      res.locals.theme = settings.theme || 'light';

      try {
        // Surah pages don't render the shared daily-ayah widget, and resolving it
        // there costs two upstream reads per page view for no benefit.
        if (!req.path.startsWith("/surah")) {
          const entry = await AyahOfTheDay.findOne({ date: todayDateKey() });
          if (entry) {
            await resolveAyahText(entry, settings.primaryTranslation);
            res.locals.ayahOfTheDay = entry.toObject();
          }
        }
      } catch (err) {
        console.error("ayah of the day: lookup failed -", err.message);
      }

      // The audio bar is rendered on every page of the Quran module, not only
      // when something is already playing. Surah pages used to carry their own
      // inline <audio>, which meant the site had two audio elements sharing no
      // state: play in the reader, navigate, and the footer arrived paused on a
      // different element. One player, everywhere.
      res.locals.audioShell = req.path === "/quran"
        || req.path.startsWith("/quran/")
        || req.path.startsWith("/surah");

      if (settings.audioProgress && settings.audioProgress.surahNo) {
         const audioSurah = await cachedJsonOrNull(
            `https://quranapi.pages.dev/api/${settings.audioProgress.surahNo}.json`
        );
         const reciterAudio = audioSurah && audioSurah.audio
             ? audioSurah.audio[settings.favoriteReciter] || audioSurah.audio[1]
             : null;

         if (audioSurah && reciterAudio) {
           res.locals.footerAudio = {
             url: reciterAudio.originalUrl,
             surahNo: settings.audioProgress.surahNo,
             surahName: settings.audioProgress.surahName,
             reciterName: reciterAudio.reciter,
             time: settings.audioProgress.time
           };
         } else {
           res.locals.footerAudio = null;
         }
      } else {
        res.locals.footerAudio = null;
      }

      next();
    });

  
  
    app.get("/audio-time", async (req, res) => {
      const { surahNo } = req.query;
      const settings = await userData.getSettings(req);
      const progress = settings.audioProgress;
      let audioTime = 0;
      if (progress && String(progress.surahNo) === String(surahNo)) {
        audioTime = progress.time || 0;
      }
      res.json({ time: audioTime });
    });

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
  

    app.post("/hide-audio", async (req, res) => {
      res.locals.canShowAudio = false; // update it here as well, instead of app.use alone, to hide audio immediately
      res.locals = {};
      await userData.updateSettings(req, { audioProgress: null });
      const referer = req.get("Referer") || "/";
      res.redirect(referer);
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

  app.post("/update-audio-time", async (req, res) => {
    const { surahNo, surahName, time } = req.body;

    try {
      await userData.updateSettings(req, {
        audioProgress: { surahNo, surahName, time }
      });

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false });
    }
  });

  
  app.get("/posts", async(req, res) => {
    // Newest first, with the author populated for attribution.
    const post = await Posts.find({}).sort({ _id: -1 }).populate("author", "name username");
    res.render('posts', { post, permalinkBase: originOf(req) });
  });

  app.get("/add-post", requireLogin, async(req, res) => {
    res.render("add-post");
  });


  // Public profile: /u/<username>. Posts stay public (the feed already is), so
// this is intentionally NOT behind requireLogin - it is the thing a user shares
// a link to. Lookup is case-insensitive to match how usernames are stored.
// Absolute origin for share links. `trust proxy` is configured, so req.protocol
// and the host header reflect the public URL rather than an internal hop.
function originOf(req) {
    const host = req.get("host");
    return host ? `${req.protocol || "https"}://${host}` : "";
}

app.get("/u/:username", async function(req, res){
    const wanted = String(req.params.username || "").toLowerCase();
    const author = await User.findOne({ username: wanted }).select("username name emailVerifiedAt createdAt");

    if (!author) {
        return res.status(404).render("error", { err: "No profile with that username." });
    }

    const posts = await Posts.find({ author: author._id }).sort({ _id: -1 });

    res.render("profile", {
        // Posts render their own author line; passing the owner keeps the header
        // and the list consistent without a second lookup.
        owner: author,
        post: posts,
        permalinkBase: originOf(req),
        isOwner: Boolean(req.isAuthenticated() && req.user && String(req.user._id) === String(author._id))
    });
});

// Permalink for a single post, so a post can be shared directly rather than
// only as "the one at the top of the feed".
app.get("/post/:id", async function(req, res){
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(404).render("error", { err: "That post does not exist." });
    }
    const post = await Posts.findById(req.params.id).populate("author", "username name");
    if (!post) {
        return res.status(404).render("error", { err: "That post does not exist." });
    }
    res.render("post", { post, permalinkBase: originOf(req) });
});

app.post("/add-post", requireLogin, async(req, res) => {
    let date = new Date(req.query.date);
    if(isNaN(date.getTime())) date = new Date();
    const options = { weekday: "long", month: "short", day: "2-digit", year: "numeric" };
    const formattedDate = date.toLocaleDateString("en-US", options);
    const content=req.body.content;
    const reference=req.body.reference;
    const post = new Posts({
        postedDate: formattedDate,
        author: req.user._id,
        authorName: req.user.name || req.user.email,
        content: content,
        reference: reference
    });
    post.save();
    // Announce to every subscriber who asked for new-post alerts.
    await broadcastNewPost(post).catch((err) => console.error("notify: new post -", err.message));
    res.redirect("/posts");
  });

  app.get("/add-video", requireLogin, async(req, res) => {
    res.render("add-video");
  });


  app.post("/add-video", requireLogin, async(req, res) => {
    let date = new Date(req.query.date);
    if(isNaN(date.getTime())) date = new Date();
    const options = { weekday: "long", month: "short", day: "2-digit", year: "numeric" };
    const formattedDate = date.toLocaleDateString("en-US", options);
    const link=req.body.link;
    const description=req.body.description;
    // youtu.be/<id>?... -> <id>; otherwise keep whatever was pasted rather than
    // throwing on a non-youtu.be link.
    const raw = String(link || "");
    const match = raw.split("youtu.be/")[1];
    const videoId = match ? match.split("?")[0] : raw.trim();
    const post = new Posts({
        postedDate: formattedDate,
        author: req.user._id,
        authorName: req.user.name || req.user.email,
        content: videoId,
        reference: description,
        isVideo: true
    });
    post.save();
    await broadcastNewPost(post).catch((err) => console.error("notify: new video -", err.message));
    res.redirect("/posts");
  });

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

app.get("/", async (req, res) => {
    const settings = await userData.getSettings(req);
    res.redirect("/" + (settings.defaultHome || "salah"));
});


// --- Quran module ---------------------------------------------------------
// Three sub-modules sharing one page: Read, Audio and Favourites. They switch
// client-side so the audio element in the footer is never destroyed - a page
// load would stop playback mid-ayah, which is the bug the Audio module exists
// to fix.

app.get("/quran", async(req, res) => {
    const data = await cachedJsonOrNull(`https://quranapi.pages.dev/api/surah.json`);
    if (!data) return res.status(503).send("Could not load the surah index.");

    const settings = await userData.getSettings(req);
    const lastReadSurahs = await userData.getLastReadSurahs(req);
    const favoriteFont = settings.favoriteFont || 'Amiri';

    // Middleware already resolved today's ayah (shared across users and cached
    // on the document). Fall back to creating it if this is the first request
    // of the day, before that middleware ran.
    let ayahEntry = res.locals.ayahOfTheDay;
    if (!ayahEntry) {
        const created = await getOrCreateAyahOfTheDay(data);
        if (created) {
            await resolveAyahText(created, getPrimaryEdition(settings));
            ayahEntry = created.toObject();
        }
    }
    if (!ayahEntry) {
        ayahEntry = { surahNo: 1, ayahNo: 1, surahName: '', surahNameArabic: '' };
    }
    const surahMeta = data[ayahEntry.surahNo - 1] || {};

    // Reciters come from one surah's payload and apply to all of them, so a
    // single cached read populates the whole Audio tab.
    const reciterSource = await cachedJsonOrNull(`https://quranapi.pages.dev/api/1.json`);
    const reciters = reciterSource && reciterSource.audio
        ? Object.entries(reciterSource.audio).map(([id, a]) => ({
            id: String(id),
            name: a.reciter,
            url: a.originalUrl
        }))
        : [];

    res.render("quran", {
        surahs: data,
        lastReadSurahs: lastReadSurahs,
        favoriteFont: favoriteFont,
        ayahOfTheDay: {
            surahNo: ayahEntry.surahNo,
            ayahNo: ayahEntry.ayahNo,
            surahName: ayahEntry.surahName || surahMeta.surahName || '',
            surahNameArabic: ayahEntry.surahNameArabic || surahMeta.surahNameArabic || '',
            arabicText: ayahEntry.arabicText || '',
            translationText: ayahEntry.translationText || '',
            translationLabel: ayahEntry.translationLabel || ''
        },
        reciters,
        activeReciter: settings.favoriteReciter ? String(settings.favoriteReciter) : "1",
        // The reader marks hearts from this list; sent on every page that can
        // show one so the initial paint is correct without a round trip.
        favouriteKeys: Array.from(favourites.keysFor(req)),
        // Resolved server-side so the Favourites tab is populated on first
        // paint rather than flashing empty while a fetch completes.
        favourites: await favourites.resolveFavourites(req, {
            loadSurah: (n) => cachedJsonOrNull(`https://quranapi.pages.dev/api/${n}.json`),
            loadEdition: (id, n) => cachedJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${id}/${n}.json`),
            editionId: (() => { const p = getPrimaryEdition(settings); const parsed = p ? parseEdition(p) : null; return parsed ? parsed.id : ""; })(),
            editionLabel: (() => { const p = getPrimaryEdition(settings); const parsed = p ? parseEdition(p) : null; return parsed ? `${parsed.language || "Translation"} - ${parsed.author || parsed.id}` : ""; })()
        }).catch((err) => {
            // A failure here must not take the whole Quran module down - the
            // Read and Audio tabs do not depend on it.
            console.error("quran: favourites render failed -", err.message);
            return [];
        }),
        isLoggedIn: Boolean(req.isAuthenticated && req.isAuthenticated())
    });
});

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
// Two paths, one handler. The EJS tabs call /quran/audio; the React client
// calls /api/quran/audio. Registering the handler twice rather than having two
// copies is what stopped the two clients drifting - as they already had.
app.get("/quran/audio", handleQuranAudio);
app.get("/api/quran/audio", handleQuranAudio);

// Favourites for the tab. JSON rather than a page fragment so toggling one
// ayah refreshes the list without a reload.
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
            editionLabel: parsed ? `${parsed.language || "Translation"} - ${parsed.author || parsed.id}` : ""
        });

        res.json({ ok: true, entries });
    } catch (err) {
        console.error("quran/favourites:", err.message);
        res.status(500).json({ error: "failed" });
    }
};
app.get("/quran/favourites", handleQuranFavourites);
app.get("/api/quran/favourites", handleQuranFavourites);

const handleToggleFavourite = async(req, res) => {
    const settings = await userData.getSettings(req);
    // The surah's real length is enforced when it is known, so an out-of-range
    // ayah is rejected rather than stored and left permanently unresolvable.
    const surahNo = parseInt(req.body.surahNo, 10);
    let totalAyah;
    if (Number.isInteger(surahNo) && surahNo >= 1 && surahNo <= 114) {
        const meta = await cachedJsonOrNull(`https://quranapi.pages.dev/api/surah.json`).catch(() => null);
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
app.post("/quran/favourites/toggle", requireLogin, handleToggleFavourite);
app.post("/api/quran/favourites/toggle", requireLogin, handleToggleFavourite);

app.get("/surah/:surahNo", async (req, res, next) => {
    const surahNo = parseInt(req.params.surahNo);
    let reciter = 1;
    let favoriteEdition = [];
    let favoriteFont = 'Amiri';
    let time = 0;

    const settings = await userData.getSettings(req);

    if (settings.favoriteReciter) reciter = settings.favoriteReciter;
    favoriteEdition = getFavoriteEditions(settings);
    if (settings.favoriteFont) favoriteFont = settings.favoriteFont;
    if (settings.audioProgress && String(settings.audioProgress.surahNo) === String(surahNo)) {
        time = settings.audioProgress.time || 0;
    }

    const primaryEdition = getPrimaryEdition(settings);
    const primaryTranslationId = primaryEdition ? parseEdition(primaryEdition).id : null;

    // Cached upstream reads: both sources are static, so re-fetching per request
    // only burned the serverless invocation budget.
    const surah = await cachedJsonOrNull(`https://quranapi.pages.dev/api/${surahNo}.json`);
    if (!surah) {
        return res.status(503).send("Could not load this surah right now. Please try again.");
    }
    const surahName = surah.surahName;

    const translationData = {};
    if (favoriteEdition.length > 0) {
        const translationPromises = favoriteEdition.map((combinedStr) => {
            const parts = combinedStr.split(':');
            const id = parts[0];
            const lan = parts[1] || "";
            const author = parts[2] || id;

            return cachedJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${id}/${surahNo}.json`)
                .then((data) => {
                    return { ...data, displayLabel: `${lan} - ${author}` };
                })
                .catch((err) => {
                    console.error(`Error fetching ${id}:`, err);
                    return null;
                });
        });

        const results = await Promise.all(translationPromises);
        const orderedEditions = [...favoriteEdition];
        if (primaryEdition) {
            const primaryIdx = orderedEditions.indexOf(primaryEdition);
            if (primaryIdx > 0) {
                orderedEditions.splice(primaryIdx, 1);
                orderedEditions.unshift(primaryEdition);
            }
        }

        orderedEditions.forEach((combinedStr) => {
            const index = favoriteEdition.indexOf(combinedStr);
            const id = parseEdition(combinedStr).id;
            if (index >= 0 && results[index]) {
                translationData[id] = results[index];
            }
        });
    }

    // Progress tracking is secondary to showing the surah: if the write fails
    // the reader still gets the page instead of an error.
    try {
        await userData.recordSurahReadAndProgress(req, { surahNo, surahName, time });
    } catch (err) {
        console.error("surah: could not record progress -", err.message);
    }

    res.render("surah", {
        surah: surah,
        translations: translationData,
        favoriteReciter: String(reciter),
        favoriteFont: favoriteFont,
        surahNo: surahNo,
        // audioTime / alwaysShowAudio fed the inline player that moved to the
        // Audio tab. The footer bar reads its own state from the middleware.
        primaryTranslationId: primaryTranslationId,
        highlightAyah: parseInt(req.query.ayah, 10) || null,
        favouriteKeys: Array.from(favourites.keysFor(req)),
        isLoggedIn: Boolean(req.isAuthenticated && req.isAuthenticated())
    });
});  
  


app.get("/salah", async function(req, res){
    let date = new Date(req.query.date);
    if(isNaN(date.getTime())) date = new Date();
    const options = { weekday: "long", month: "short", day: "2-digit", year: "numeric" };
    const formattedDate = date.toLocaleDateString("en-US", options);

    // Marking a prayer is a personal record, so it needs an account. Guests get
    // a read-only view plus a sign-in prompt rather than a form that would 302.
    const canManage = req.isAuthenticated();
    const entries = await userData.listSalah(req);
    res.render('salah', {
        keyDate: formattedDate,
        keySalah: entries.filter((s) => s.date === formattedDate),
        canManage
    });
});


app.get("/salah-timings", async(req, res)=>{
    const settings = await userData.getSettings(req);
    const location = settings.location || "Coimbatore";

    const response = await islamicFinderFetch(`https://www.islamicfinder.org/prayer-widget/${locationMap.get(location)}/shafi/3/0/18.0/18.0`);
    // Named `pageHtml`, not `data` - that identifier is the user-data service.
    const pageHtml = await response.text();

    const $ = cheerio.load(pageHtml);
    const prayerDetails = {};

    prayerDetails.location = $(".table-controller a").first().text().trim();
    prayerDetails.hijriDate = $(".table-controller div").first().text().trim();
    const today = new Date();
    const options = { weekday: "long", month: "short", day: "2-digit", year: "numeric" };
    const formattedDate = today.toLocaleDateString("en-US", options);
    prayerDetails.date = formattedDate;

    const prayerTimes = [];
    $(".d-flex.flex-direction-row").each((index, element) => {
        const timeType = $(element).find("p").first().text().trim();
        const time = $(element).find("p").last().text().trim();
        prayerTimes.push({ timeType, time });
    });
    prayerDetails.prayerTimes = prayerTimes;

    res.render('salah-timings', { location: location, keyPrayerDetails: prayerDetails, keyData: pageHtml });
});


// Helper function to get current Hijri date
async function getCurrentHijriDate() {
    const data = await cachedJson('https://api.aladhan.com/v1/gToH');
    return {
      hijriMonth: parseInt(data.data.hijri.month.number),
      hijriYear: parseInt(data.data.hijri.year),
    };
  }



  app.get('/calendar', async (req, res) => {
    try{
        let hijriMonth = parseInt(req.query.month);
        let hijriYear = parseInt(req.query.year);

        if(!hijriMonth){
            const json1 = await cachedJson('https://api.aladhan.com/v1/currentIslamicMonth');
            hijriMonth = json1.data;
        }
        if(!hijriYear){
            const json2 = await cachedJson('https://api.aladhan.com/v1/currentIslamicYear');
            hijriYear = json2.data;
        }

        const apiUrl = `https://api.aladhan.com/v1/hToGCalendar/${hijriMonth}/${hijriYear}`;
        const json = await cachedJson(apiUrl);

        const hijriMonthName = json.data[0].hijri.month.en;
        const gregorianMonth = json.data[0].gregorian.month.en;
        const gregorianYear = json.data[0].gregorian.year;

        // Map dates into weeks
        const days = json.data.map(d => ({
            hijri: d.hijri.day,
            gregorian: d.gregorian.day,
            weekday: d.gregorian.weekday.en,
            date: d.gregorian.date,
            fullHijri: `${d.hijri.day} ${d.hijri.month.en} ${d.hijri.year}`,
        }));

        let firstValidDate = json.data.find(d => d && d.gregorian && d.gregorian.date);
        let firstWeekday = 0;

        if (firstValidDate) {
            const date = new Date(firstValidDate.gregorian.date);
            firstWeekday = isNaN(date.getDay()) ? 0 : date.getDay();
        }

        const paddedDays = Array(firstWeekday).fill(null).concat(days);


        const weeks = [];
        for (let i = 0; i < paddedDays.length; i += 7) {
            weeks.push(paddedDays.slice(i, i + 7));
        }


        // special days

        const response2 = await islamicFinderFetch(`https://www.islamicfinder.org/specialislamicdays`);
        const data = await response2.text();
    
        const $ = cheerio.load(data);
        const specialDays = [];

        // Loop through each row of special days
        $("#special-days-table tr").each((index, element) => {
            const month = $(element).find(".date-box .title span").text().trim();
            const day = $(element).find(".date-box .date span").text().trim();
            const event = $(element).find(".day-details h2 a").text().trim();
            const weekday = $(element).find(".day-details h4").text().split(",")[0].trim();
            const hijriDate = $(element).find(".day-details h4").text().split(",")[1].trim();
            const hijriYear = $(element).find(".day-details h4").text().split(",")[2].trim();

            if (month && day && event) {
                specialDays.push({
                    date: `${month} ${day}`,
                    event,
                    weekday,
                    hijriDate,
                    hijriYear,
                });
            }
        });

        res.render('calendar', {
            hijriMonthName,
            hijriMonth,
            hijriYear,
            gregorianMonth,
            gregorianYear,
            weeks,
            calendarData: "", specialDays
        });
    }catch(err){
        res.render("error", {err});
    }
});




app.get("/special-days", async(req, res) => {
    const response = await islamicFinderFetch(`https://www.islamicfinder.org/specialislamicdays`);
    const data = await response.text();
    
    const $ = cheerio.load(data);
    const specialDays = [];

    // Loop through each row of special days
    $("#special-days-table tr").each((index, element) => {
        const month = $(element).find(".date-box .title span").text().trim();
        const day = $(element).find(".date-box .date span").text().trim();
        const event = $(element).find(".day-details h2 a").text().trim();
        const weekday = $(element).find(".day-details h4").text().split(",")[0].trim();
        const hijriDate = $(element).find(".day-details h4").text().split(",")[1].trim();
        const hijriYear = $(element).find(".day-details h4").text().split(",")[2].trim();
            
        if (month && day && event) {
            specialDays.push({
                date: `${month} ${day}`,
                event,
                weekday,
                hijriDate,
                hijriYear,
            });
        }
        res.render('calendar', {calendarData: "", specialDays});
    });
});


// Challenges are an explicit "add / edit / delete" surface, so they need an
// account. Guests see a read-only view of whatever they tracked in the cookie
// alongside a sign-in prompt, rather than controls that would 302 on submit.
app.get("/challenges", async function(req, res){
    const keyChallenge = await userData.listChallenges(req);
    const canManage = req.isAuthenticated();
    res.render('challenges', { keyChallenge, canManage });
});

app.get("/add-challenge", requireLogin, function(req, res){
    res.render("challenge-form", { mode: "add", challenge: null });
});

app.get("/edit-challenge/:id", requireLogin, async function(req, res){
    try {
        const all = await userData.listChallenges(req);
        const challenge = all.find((c) => String(c._id) === String(req.params.id));
        if (!challenge) return res.redirect("/challenges");
        res.render("challenge-form", { mode: "edit", challenge });
    } catch (err) {
        console.error(err);
        res.redirect("/challenges");
    }
});
  

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
    analytics: 'Analytics',
    posts: 'Posts',
    settings: 'Settings'
};

const LOCATION_OPTIONS = ['Coimbatore', 'Hosur', 'Salem', 'Ramanathapuram', 'Bengaluru'];

app.get("/settings", async (req, res) => {
    const recitersJson = await cachedJsonOrNull("https://quranapi.pages.dev/api/reciters.json");
    const editionsJson = await cachedJsonOrNull("https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions.json");

    const settings = await userData.getSettings(req);

    let reciter = settings.favoriteReciter || 1;
    let defaultHome = settings.defaultHome || "salah";
    let location = settings.location || "Coimbatore";
    let favoriteEdition = [];
    let favoriteFont = settings.favoriteFont || "QPC-Hafs";
    let theme = settings.theme || "light";
    let primaryTranslation = settings.primaryTranslation || "";
    const telegramChatId = await userData.getTelegramChatId(req);

    if (settings.favoriteEdition) {
        favoriteEdition = getFavoriteEditions(settings);
    }
    primaryTranslation = getPrimaryEdition(settings) || "";

    // Official Tarteel QUL Font Mapping
    const tarteelFonts = TARTEEL_FONTS; // eslint-disable-line no-unused-vars
    const _unusedTarteelFonts = { 
        'QPC-Hafs': { label: 'QPC Hafs (Standard)', tag: 'HAFS' },
        // 'DigitalKhatt-V2': { label: 'Digital Khatt V2', tag: 'HAFS' },
        // 'Me-Quran': { label: 'Me Quran', tag: 'HAFS' },
        'QPC-Nastaleeq': { label: 'QPC Hafs Nastaleeq', tag: 'HAFS' },
        // 'Uthman-Taha': { label: 'Madani (Uthman Taha)', tag: 'HAFS' },
        // 'Indopak-PDMS': { label: 'Indopak (PDMS Saleem)', tag: 'INDOPAK' },
        'Indopak-Nastaleeq': { label: 'Indopak Nastaleeq', tag: 'INDOPAK' },
        // 'DigitalKhatt-Indopak': { label: 'Digital Khatt Indopak', tag: 'INDOPAK' },
        // 'Tajweed-V4': { label: 'KFGQPC V4 Tajweed', tag: 'HAFS' }
    };

    const editionsByLanguage = groupEditionsByLanguage(editionsJson || {});

    res.render('settings', {
        favoriteReciter: String(reciter), 
        favoriteEdition: favoriteEdition,
        primaryTranslation: primaryTranslation, 
        defaultHome: defaultHome, 
        location: location, 
        favoriteFont: favoriteFont,
        theme: theme,
        telegramChatId: telegramChatId,
        botConfigured: botIsConfigured(),
        tgSetupCode: (req.session && req.session.tgVerifyCode) || "",
        tgPrefs: notify.telegramPrefs(res.locals.currentUser),
        isLoggedIn: Boolean(res.locals.currentUser),
        tgStatus: Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, req.query.tg || "") ||
                  req.query.tg === "sent" ? req.query.tg : "",
        tgFoundChatId: normalizeChatId(req.query.chat || ""),
        tgMessages: ERROR_MESSAGES,
        tarteelFonts: tarteelFonts,
        reciters: recitersJson,
        editions: editionsByLanguage
    });
});

// Account: identity only - username, profile link, and the email address.
// Settings stays about app preferences (theme, reciter, notifications), so the
// username field moved here rather than sitting among unrelated options.
app.get("/account", requireLogin, function(req, res){
    const user = req.user;
    // Fall back to the email local-part so the page is usable for an account
    // that predates the username backfill.
    const username = user.username || "";
    res.render("account", {
        username,
        displayName: username || user.name || (user.email || "?").split("@")[0],
        email: user.email,
        // emailVerifiedAt only exists on accounts created since OTP signup; the
        // older ones are genuinely verified in practice but have no stamp.
        verified: Boolean(user.emailVerifiedAt),
        usernameError: req.query.un || "",
        usernameOk: req.query.un_ok === "1"
    });
});

// Change the public handle. On its own formaction rather than part of a larger
// settings save, because it has to be validated and de-duplicated on its own -
// quietly failing on a duplicate would leave someone stuck re-saving settings.
app.post("/settings/username", requireLogin, async function(req, res){
    // Unlike signup, a username chosen here is NOT run through sanitize(). That
    // would silently turn "my name" into "myname" and leave the user wondering
    // why their profile is not what they typed. Case and surrounding whitespace
    // are the only things forgiven; anything else is rejected and explained.
    const requested = String(req.body.username || "").trim().toLowerCase();

    // Allow-list, not a prefix test: "//evil.example.com" is protocol-relative
    // and a naive `startsWith("/")` would treat it as a local path.
    // The SPA posts JSON and expects JSON back; the EJS form posts a redirectTo
    // and expects a redirect. Same validation, two response shapes.
    const wantsJson = String(req.get("content-type") || "").includes("application/json");
    const target = String(req.body.redirectTo || "") === "/settings" ? "/settings" : "/account";
    const done = (usernameError, ok) => {
        if (wantsJson) {
            if (usernameError) return res.status(400).json({ error: usernameError });
            return res.json({ ok: true, username: requested });
        }
        return res.redirect(`${target}?un=${encodeURIComponent(usernameError)}${ok ? "&un_ok=1" : ""}`);
    };

    if (!requested) return done("Enter a username.");
    // Reserved words are checked before the shape test: isValid() also rejects
    // them, so testing shape first would report "letters, numbers, dots or
    // underscores" for "posts" and never reach the explanation below.
    if (usernameUtil.isReserved(requested)) {
        return done("That username is reserved.");
    }
    if (!usernameUtil.isValid(requested)) {
        return done("Usernames must be 3-30 characters: letters, numbers, dots or underscores.");
    }

    try {
        // Exclude self, otherwise re-saving your own unchanged username would
        // collide with itself and report "taken".
        if (await User.exists({ username: requested, _id: { $ne: req.user._id } })) {
            return done("That username is already taken.");
        }
        if (req.user.username === requested) {
            return done("", true);
        }

        const previous = req.user.username;
        req.user.username = requested;
        await req.user.save();

        // Posts store a denormalised authorName, but they link by author id, so
        // existing posts and shared /u/<name> links follow the change. Only the
        // denormalised copy needs rewriting, for the anonymous fallback.
        if (previous) {
            await mongoose.connection.collection("posts").updateMany(
                { authorName: previous },
                { $set: { authorName: requested } }
            );
        }

        return done("", true);
    } catch (err) {
        if (err && err.code === 11000) return done("That username is already taken.");
        console.error("settings/username:", err.message);
        return done("Could not update your username.");
    }
});





// POST methods

app.post("/salah", requireLogin, async function(req, res){
    const date=new Date(req.body.date);
    const options = { weekday: "long", month: "short", day: "2-digit", year: "numeric" };
    const formattedDate = date.toLocaleDateString("en-US", options);
    const name=req.body.salah_name;
    const value=req.body.salah_value;
    await userData.recordSalah(req, {
        date: formattedDate,
        name: name,
        value: value
    });

    // Event-driven: this request is the trigger, so no scheduler is involved.
    if (req.isAuthenticated && notify.wantsEvent(req.user, "salahTracker")) {
        await notify.safeDeliver(req.user, notify.buildSalahLogMessage(req.user, formattedDate));
    }
    res.redirect("/salah");
});


app.post("/add-challenge", requireLogin, async function(req, res){
    const challenge = (pickField(req.body.challenge) || '').trim();
    if (!challenge) return res.redirect("/challenges");
    try {
        await userData.addChallenge(req, challenge);
    } catch (err) {
        console.error(err);
    }
    res.redirect("/challenges");
});

app.post("/edit-challenge", requireLogin, async function(req, res){
    const id = pickField(req.body.id);
    const challenge = (pickField(req.body.challenge) || '').trim();
    if (!id || !challenge) return res.redirect("/challenges");
    try {
        await userData.renameChallenge(req, id, challenge);
    } catch (err) {
        console.error(err);
    }
    res.redirect("/challenges");
});

app.post("/delete-challenge", requireLogin, async function(req, res){
    const id = pickField(req.body.id);
    if (!id) return res.redirect("/challenges");
    try {
        await userData.deleteChallenge(req, id);
    } catch (err) {
        console.error(err);
    }
    res.redirect("/challenges");
});


app.post('/update-streaks', requireLogin, async (req, res) => {
    // `completed[]` arrives as an array, but a lone value parses as a string
    const completed = [].concat(req.body.completed || []).map(String);

    const options = { weekday: "long", month: "short", day: "2-digit", year: "numeric" };
    const lastUpdated = new Date(req.body.date);
    if (isNaN(lastUpdated.getTime())) {
        console.error("update-streaks: missing or invalid date", req.body.date);
        return res.redirect('/challenges');
    }
    const formattedDate = lastUpdated.toLocaleDateString("en-US", options);

    let updatedChallenges = [];

    try {
        const allChallenges = await userData.applyStreakUpdate(req, {
            completedIds: completed,
            lastUpdated: formattedDate
        });

        updatedChallenges = allChallenges.map((c) => ({
            id: String(c._id),
            name: c.challenge,
            currentStreak: c.currentStreak,
            maxStreak: c.maxStreak,
        }));

        // Awaited deliberately: on Vercel the function can be frozen once the
        // response is sent, which would silently drop a fire-and-forget send.
        // The fetch is timeout-bounded so a slow API cannot stall the redirect.
        await notifyStreakUpdate(req, { formattedDate, completed, updatedChallenges });
    } catch (err) {
        console.error(err);
    }

    res.redirect('/challenges');
});

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


app.post("/default-home", function(req,res){
    const defaultHome = req.body.defaultHome;

    userData.updateSettings(req, { defaultHome })
        .then(() => {
            res.redirect("/settings");
        })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating default home.");
    });
});

app.post("/reciter", function(req, res){
    const reciter = req.body.reciter;
    const redirectTo = req.body.redirectTo;

    // The Audio tab posts JSON and expects JSON back, rather than a redirect it
    // would never follow. Same validation either way: an unknown reciter id
    // would otherwise persist and silently break the player later.
    const wantsJson = String(req.get("accept") || "").includes("application/json")
        || String(req.get("content-type") || "").includes("application/json");

    if (!/^\d+$/.test(String(reciter || ""))) {
        if (wantsJson) return res.status(400).json({ ok: false, error: "invalid-reciter" });
        return res.redirect(redirectTo || "/quran");
    }

    userData.updateSettings(req, { favoriteReciter: reciter })
        .then(() => {
            if (wantsJson) return res.json({ ok: true });
            res.redirect(redirectTo);
        })
        .catch((err) => {
            console.error(err);
            if (wantsJson) return res.status(500).json({ ok: false, error: "failed" });
            res.status(500).send("Error updating reciter.");
        });
});

app.post("/set-edition", function(req, res){
    const selectedEdition = req.body.edition;

    userData.updateSettings(req, { favoriteEdition: selectedEdition })
        .then(() => {
            res.redirect("/settings");
        })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating Edition.");
        });
  });

// --- Auth ---

app.get("/login", function(req, res){
    if (req.isAuthenticated()) return res.redirect("/challenges");
    res.render("login", { authError: "", authEmail: "", authMode: "login" });
});

app.get("/register", function(req, res){
    if (req.isAuthenticated()) return res.redirect("/challenges");
    res.render("login", { authError: "", authEmail: "", authMode: "register" });
});

app.post("/register", async function(req, res){
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const confirm = String(req.body.cpassword || "");

    const fail = (authError) => res.status(400).render("login", { authError, authEmail: email, authMode: "register" });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a valid email address.");
    if (password.length < 6) return fail("Password must be at least 6 characters.");
    if (password !== confirm) return fail("Passwords do not match.");

    try {
        if (await User.exists({ email })) return fail("That email is already registered.");
    } catch (err) {
        console.error("register: existence check failed -", err.message);
        return fail("Could not create the account. Please try again.");
    }

    // No User is created here. Making the row first would let anyone reserve an
    // email they do not own simply by typing it - the owner could then never
    // sign up. Instead the intent lives in the session until the emailed code
    // proves control of the address.
    const code = emailService.makeOtp();
    const { hash, salt } = passwordUtil.createPasswordRecord(password);
    req.session.pendingSignup = {
        email,
        // Stored hashed, not in plaintext: the session lives in the database, and
        // a leaked session should not hand over a working password.
        hash,
        salt,
        otpHash: emailService.hashOtp(code),
        // 10 minutes is long enough to find an email and short enough to keep
        // the window small.
        expiresAt: Date.now() + 10 * 60 * 1000,
        attempts: 0,
        sentAt: Date.now()
    };

    const sent = await emailService.sendOtpEmail({ to: email, code });

    if (!sent.ok) {
        // Do not leave a half-started signup behind: without a delivered code
        // there is nothing the user can do but retry.
        delete req.session.pendingSignup;
        // Two distinct causes, and telling them apart is the difference between
        // "check Vercel env vars" and "regenerate your App Password". The detail
        // stays in the server log; the user gets the actionable half.
        console.error("register: OTP not delivered -", sent.reason);
        return fail(sent.reason === "not-configured"
            ? "We could not send a verification email - the site has no email service set up yet. Please try again shortly."
            : "We could not send a verification email. Please check the address and try again.");
    }

    res.render("verify-email", {
        authError: null,
        pendingEmail: email,
        canResend: true,
        resendIn: 0
    });
});

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

app.post("/resend-otp", async function(req, res){
    const { ok, pending, reason } = pendingSignup(req);
    if (!ok) {
        return res.status(400).render("login", {
            authError: "That verification session has expired. Please register again.",
            authEmail: String(req.body.email || ""),
            authMode: "register"
        });
    }

    const elapsed = Date.now() - (pending.sentAt || 0);
    if (elapsed < OTP_RESEND_COOLDOWN_MS) {
        const wait = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).render("verify-email", {
            authError: `Please wait ${wait} seconds before requesting another code.`,
            pendingEmail: pending.email,
            canResend: false,
            resendIn: wait
        });
    }

    const code = emailService.makeOtp();
    pending.otpHash = emailService.hashOtp(code);
    pending.sentAt = Date.now();
    pending.attempts = 0;
    req.session.pendingSignup = pending;

    const sent = await emailService.sendOtpEmail({ to: pending.email, code });
    if (!sent.ok) console.error("resend-otp: delivery failed -", sent.reason);
    res.status(sent.ok ? 200 : 502).render("verify-email", {
        authError: sent.ok ? null : "We could not send another code. Please try again.",
        pendingEmail: pending.email,
        canResend: true
    });
});

app.post("/verify-email", async function(req, res){
    const code = String(req.body.code || "").replace(/\D/g, "");
    const { ok, pending, reason } = pendingSignup(req);

    const retry = (authError, extra = {}) => res.status(400).render("verify-email", {
        authError,
        pendingEmail: pending ? pending.email : String(req.body.email || ""),
        canResend: Boolean(pending),
        ...extra
    });

    if (!ok) {
        return res.status(400).render("login", {
            authError: reason === "expired"
                ? "That code has expired. Please register again."
                : "Start by registering again.",
            authEmail: String(req.body.email || ""),
            authMode: "register"
        });
    }

    if (code.length !== 6) return retry("Enter the 6-digit code from the email.");
    if (!emailService.otpMatches(pending.otpHash, code)) {
        // Count attempts so a 6-digit code cannot be brute-forced. 10^6 is small
        // enough that an unthrottled attacker would get through it.
        pending.attempts = (pending.attempts || 0) + 1;
        if (pending.attempts >= OTP_MAX_ATTEMPTS) {
            delete req.session.pendingSignup;
            return res.status(400).render("login", {
                authError: "Too many incorrect attempts. Please register again.",
                authEmail: pending.email,
                authMode: "register"
            });
        }
        const left = OTP_MAX_ATTEMPTS - pending.attempts;
        return retry(`That code is not correct. ${left} attempt${left === 1 ? "" : "s"} left.`);
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
            if (err) return res.status(500).send("Could not sign you in.");
            userData.clearGuestCookie(req, res);
            res.redirect("/settings?welcome=1");
        });
    } catch (err) {
        // The email can only become taken between the check in /register and
        // here, but that race is exactly what this catches.
        const isDuplicate = (err && err.code === 11000) || (err && err.name === "UserExistsError");
        if (isDuplicate) {
            delete req.session.pendingSignup;
            return res.status(400).render("login", {
                authError: "That email is already registered.",
                authEmail: pending.email,
                authMode: "register"
            });
        }
        console.error("verify-email:", err);
        res.status(500).render("login", {
            authError: "Could not create the account. Please try again.",
            authEmail: pending.email,
            authMode: "register"
        });
    }
});

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

app.post("/login", function(req, res, next){
    const email = String(req.body.email || "").trim().toLowerCase();
    passport.authenticate("local", function(err, user, info){
        if (err) return next(err);
        if (!user) {
            return res.status(401).render("login", {
                authError: (info && info.message) || "Invalid email or password.",
                authEmail: email,
                authMode: "login"
            });
        }
        req.logIn(user, async (loginErr) => {
            if (loginErr) return res.status(500).send("Could not sign you in.");
            try {
                // Fold anything tracked while logged out into the account.
                await mergeGuestIntoUser(req, user);
                userData.clearGuestCookie(req, res);
                const target = req.session.returnTo || "/challenges";
                delete req.session.returnTo;
                return res.redirect(target);
            } catch (mergeErr) {
                console.error("guest merge failed:", mergeErr);
                return res.redirect("/challenges");
            }
        });
    })(req, res, next);
});

app.post("/logout", function(req, res, next){
    req.logout(function(err){
        if (err) return next(err);
        req.session.destroy(function(destroyErr){
            if (destroyErr) return next(destroyErr);
            res.clearCookie("connect.sid");
            res.redirect("/quran");
        });
    });
});

// Sends one module's notification on demand - this is what each per-module
// "Send now" button posts to. `module` decides which message is produced.
app.post("/test-telegram", requireLogin, async function(req, res){
    const redirectTo = pickField(req.body.redirectTo) || '/settings';
    try {
        if (!botIsConfigured()) return res.redirect(`${redirectTo}?tg=bot-missing`);

        const chatId = await userData.getTelegramChatId(req);
        if (!chatId) return res.redirect(`${redirectTo}?tg=missing`);

        const module = pickField(req.body.module);
        const known = notify.EVENT_KEYS.concat(["all"]);
        if (module && !known.includes(module)) {
            return res.redirect(`${redirectTo}?tg=unknown-module`);
        }

        const label = (key) => ({
            challenges: "Challenges",
            salahTracker: "Salah Tracker",
            newPost: "New post",
            salahTimings: "Salah timings",
            ayahOfTheDay: "Ayah of the day"
        }[key] || key);

        const dateLabel = scheduler.dateLabelIn(
            (req.user.telegram && req.user.telegram.timezone) || "UTC", new Date()
        );

        const text = module
            ? await notify.buildModulePreview(req.user, module, { dateLabel })
            : `<b>Salah Tracker</b> — test message\n\nTelegram notifications are connected.`;

        if (!text) return res.redirect(`${redirectTo}?tg=unknown-module`);

        const result = await sendTelegramMessage({ chatId, text });
        res.redirect(`${redirectTo}?tg=${result.sent ? "sent" : result.code}&mod=${encodeURIComponent(module || "all")}`);
    } catch (err) {
        console.error(err);
        res.redirect(`${redirectTo}?tg=error`);
    }
});

// Reads back the user's most recent message to the bot so they never have to
// hunt down their own chat id.
// Persist the notification preferences carried by a settings submit. Shared by
// /settings and by the setup-code / connect buttons, which post the same form
// via formaction - without this, following the setup steps discarded the toggle
// the user had just switched on, because those requests re-render the page.
async function saveTelegramPrefs(req, body) {
    if (!req.isAuthenticated()) return;

    const telegramChatId = pickField(body.telegramChatId);
    const tgEnabled = String(body.tgEnabled || "") === "on";
    const tgTimezone = String(body.tgTimezone || "").trim();
    const tgAyahTime = notify.normaliseHhMm(pickField(body.tgAyahTime), "05:30");
    const tgSalahTime = notify.normaliseHhMm(pickField(body.tgSalahTime), "05:00");

    const user = req.user;
    user.telegram = user.telegram || {};
    user.telegram.enabled = tgEnabled;
    if (tgTimezone) user.telegram.timezone = tgTimezone;
    user.telegram.events = {
        ...(user.telegram.events || {}),
        challenges: String(body.tgEventChallenges) === "on",
        salahTracker: String(body.tgEventSalahTracker) === "on",
        newPost: String(body.tgEventNewPost) === "on",
        salahTimings: String(body.tgEventSalahTimings) === "on",
        ayahOfTheDay: String(body.tgEventAyah) === "on"
    };
    user.telegram.times = { ayahOfTheDay: tgAyahTime, salahTimings: tgSalahTime };

    // Only accept a chat id that actually looks like one.
    const cleanChat = normalizeChatId(telegramChatId);
    if (cleanChat) user.telegramChatId = cleanChat;

    await user.save();
}

// Issue a setup code. It lives in the session (not the account) so it expires
// with the login and never becomes a long-lived shared secret.
app.post("/telegram-setup-code", requireLogin, async function(req, res){
    const redirectTo = pickField(req.body.redirectTo) || '/settings';
    try {
        if (!botIsConfigured()) return res.redirect(`${redirectTo}?tg=bot-missing`);
        // Keep the toggle the user just flipped.
        await saveTelegramPrefs(req, req.body);
        req.session.tgVerifyCode = makeVerifyCode();
        req.session.tgVerifyCodeAt = Date.now();
        res.redirect(`${redirectTo}?tg=code`);
    } catch (err) {
        console.error("telegram-setup-code:", err.message);
        res.redirect(`${redirectTo}?tg=error`);
    }
});

// The user has sent that code to the bot, so bind their chat to their account.
// Matching on the code is what keeps multiple users apart.
app.post("/telegram-chat-id", requireLogin, async function(req, res){
    const redirectTo = pickField(req.body.redirectTo) || '/settings';
    try {
        if (!botIsConfigured()) return res.redirect(`${redirectTo}?tg=bot-missing`);

        await saveTelegramPrefs(req, req.body);

        const code = req.session.tgVerifyCode;
        const issuedAt = req.session.tgVerifyCodeAt || 0;
        if (!code || Date.now() - issuedAt > 15 * 60 * 1000) {
            return res.redirect(`${redirectTo}?tg=no-code`);
        }

        const result = await claimChatByCode(undefined, code);
        if (!result.chatId) {
            return res.redirect(`${redirectTo}?tg=${result.code || 'no-messages'}`);
        }

        await userData.setTelegramChatId(req, result.chatId);
        // One-shot: clear it so a stale code can't rebind someone later.
        delete req.session.tgVerifyCode;
        delete req.session.tgVerifyCodeAt;

        res.redirect(`${redirectTo}?chat=${encodeURIComponent(result.chatId)}`);
    } catch (err) {
        console.error(err);
        res.redirect(`${redirectTo}?tg=error`);
    }
});

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

app.post("/location", function(req, res) {
    const location = req.body.location;
    const redirectTo = req.body.redirectTo;

    userData.updateSettings(req, { location })
        .then(() => {
            res.redirect(redirectTo);
        })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating location.");
    });
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

//  });
app.post("/settings", function(req, res){
    const body = req.body;
    const defaultHome = pickField(body.defaultHome);
    const reciter = pickField(body.reciter);
    const edition = pickField(body.edition);
    const font = pickField(body.font);
    const location = pickField(body.location);
    const theme = pickField(body.theme);
    const primaryTranslation = pickField(body.primaryTranslation);
    const redirectTo = pickField(body.redirectTo);
    const telegramChatId = pickField(body.telegramChatId);

    // Parse the JSON string sent from the frontend hidden input
    let parsedEditions = [];
    try {
        if (edition) parsedEditions = JSON.parse(edition);
    } catch (e) {
        // Fallback in case of parsing error
        if (typeof edition === 'string') parsedEditions = [edition];
    }
    parsedEditions = parsedEditions.filter((v) => v && String(v).trim() !== '');

    // The bot is app-wide now; a user only opts in their own chat. A malformed
    // id is dropped without blocking the rest of the save.
    const cleanChatId = normalizeChatId(telegramChatId);
    const telegramRejected = Boolean(telegramChatId) && !cleanChatId;
    if (telegramRejected) {
        console.error("settings: telegram chat id malformed, saving the rest only");
    }

    let resolvedPrimary = primaryTranslation || '';
    if (resolvedPrimary && !parsedEditions.includes(resolvedPrimary)) {
        const primaryId = parseEdition(resolvedPrimary).id;
        resolvedPrimary = parsedEditions.find((e) => parseEdition(e).id === primaryId) || '';
    }
    if (!resolvedPrimary && parsedEditions.length) {
        resolvedPrimary = parsedEditions[0];
    }

    userData.updateSettings(req, {
        defaultHome: defaultHome,
        favoriteReciter: reciter,
        favoriteEdition: parsedEditions,
        primaryTranslation: resolvedPrimary,
        favoriteFont: font,
        location: location,
        theme: theme || 'light'
    })
    .then(async () => {
        // Notification preferences belong to the account, so a guest toggling
        // them here is meaningless - the helper no-ops for signed-out users.
        await saveTelegramPrefs(req, req.body);
        const target = redirectTo || '/settings';
        res.redirect(telegramRejected ? `${target}?tg=incomplete` : target);
    })
    .catch((err) => {
        console.error(err);
        res.status(500).send("Error updating settings.");
    });
});







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
        const entry = res.locals.ayahOfTheDay || await getOrCreateAyahOfTheDay(surahs);
        if (entry) {
            if (!entry.translationText) await resolveAyahText(entry, edition);
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
        favoriteFont: settings.favoriteFont || 'Amiri',
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
    const surah = await cachedJsonOrNull(`https://quranapi.pages.dev/api/${surahNo}.json`);
    if (!surah) return res.status(503).json({ error: "surah-unavailable" });

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
        favoriteFont: settings.favoriteFont || 'Amiri',
        favouriteKeys: Array.from(favourites.keysFor(req)),
        isLoggedIn: Boolean(req.isAuthenticated && req.isAuthenticated())
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
        await userData.recordSurahReadAndProgress(req, {
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
app.get("/api/quran/progress", async function(req, res){
    const settings = await userData.getSettings(req);
    const progress = settings.audioProgress;
    if (!progress || !progress.surahNo) return res.json({ track: null });

    const surah = await cachedJsonOrNull(`https://quranapi.pages.dev/api/${progress.surahNo}.json`).catch(() => null);
    const track = surah && surah.audio ? (surah.audio[settings.favoriteReciter] || surah.audio[1]) : null;
    if (!track) return res.json({ track: null });

    res.json({
        track: {
            url: track.originalUrl,
            surahNo: Number(progress.surahNo),
            surahName: progress.surahName || surah.surahName,
            reciterName: track.reciter,
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
    try {
        const challenge = await userData.addChallenge(req, { challenge: req.body.challenge });
        res.status(201).json({ challenge });
    } catch (err) {
        console.error("api/challenges POST:", err.message);
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

// Mirrors POST /update-streaks exactly, including the date validation that
// rejects a missing or unparseable date before anything is written.
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
            lastUpdated: formattedDate
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

// ---- Salah log ----

app.get("/api/salah", async function(req, res){
    try {
        const entries = await userData.listSalah(req);
        // Optional ?date=YYYY-MM-DD, defaulting to today in the SERVER's zone.
        // The client's clock is not trusted: a device set to the wrong date
        // should not be able to write into another day.
        let label = null;
        if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
            const parsed = new Date(`${req.query.date}T12:00:00Z`);
            if (!isNaN(parsed.getTime())) {
                label = parsed.toLocaleDateString("en-US", {
                    weekday: "long", month: "short", day: "2-digit", year: "numeric", timeZone: "UTC"
                });
            }
        }
        if (!label) {
            label = new Date().toLocaleDateString("en-US", {
                weekday: "long", month: "short", day: "2-digit", year: "numeric"
            });
        }
        res.json({ date: label, entries: entries.filter((s) => s.date === label), canManage: Boolean(req.isAuthenticated && req.isAuthenticated()) });
    } catch (err) {
        console.error("api/salah:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

app.post("/api/salah", requireLogin, async function(req, res){
    try {
        const updated = await userData.recordSalah(req, {
            date: req.body.date,
            name: req.body.name,
            value: req.body.value
        });
        res.json({ entries: updated });
    } catch (err) {
        console.error("api/salah POST:", err.message);
        res.status(500).json({ error: "failed" });
    }
});

// ---- Posts ----

app.get("/api/posts", async function(req, res){
    try {
        const post = await Posts.find({}).sort({ _id: -1 }).populate("author", "name username");
        res.json({ posts: post, permalinkBase: originOf(req) });
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
    if (!content && !isVideo) return res.status(400).json({ error: "empty-post" });

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

        res.status(201).json({ post });
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
        res.json({ post, permalinkBase: originOf(req) });
    } catch (err) {
        console.error("api/posts/:id:", err.message);
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
        res.json({ owner: author, posts, permalinkBase: originOf(req), isOwner });
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
                defaultHome: settings.defaultHome || "salah",
                location: settings.location || "Coimbatore",
                favoriteReciter: settings.favoriteReciter || 1,
                favoriteFont: settings.favoriteFont || "QPC-Hafs",
                favoriteEdition: getFavoriteEditions(settings),
                primaryTranslation: getPrimaryEdition(settings) || "",
                theme: settings.theme || "light",
                audioProgress: settings.audioProgress || null
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
            : `<b>Salah Tracker</b> — test message\n\nTelegram notifications are connected.`;
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
