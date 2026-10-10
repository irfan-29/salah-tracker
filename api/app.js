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
const { sendTelegramMessage, findChatId, buildStreakSummary, normalizeChatId, normalizeToken, extractToken, isValidToken, botIsConfigured, ERROR_MESSAGES } = require("../api/utils/telegram.js");
const { passport, requireLogin, attachUser } = require("./middleware/auth.js");
// Named `userData` rather than `data`: several routes bind a local `data` to a
// fetched surah/prayer payload, which would shadow the service module.
const userData = require("./services/userData.js");
const { mergeGuestIntoUser } = require("./utils/guestStore.js");
const User = require("./models/User.js");



const app=express();

app.set('view engine', 'ejs');
app.use(express.json());
app.use(bodyParser.urlencoded({extended: true}));
// app.use(express.static("public"));
app.use(express.static(path.join(__dirname, "../public")));
app.set("views", path.join(__dirname, "../views"));

mongoose.set({strictQuery: true});
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://admin-irfan:Irf6360944@cluster0.jo7etur.mongodb.net/salahDB";
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

const ayahOfTheDaySchema = new mongoose.Schema({
    date: { type: String, unique: true },
    surahNo: Number,
    ayahNo: Number,
    // Resolved text is cached so the daily ayah costs one external fetch per
    // day rather than one per page view, and so guests (who have no saved
    // translation preference) still see it.
    surahName: String,
    surahNameArabic: String,
    arabicText: String,
    translationText: String,
    translationLabel: String,
    resolvedAt: Date
});
const AyahOfTheDay = mongoose.model("AyahOfTheDay", ayahOfTheDaySchema);

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
        const [arabicRes, translationRes] = await Promise.all([
            fetch(`https://quranapi.pages.dev/api/${entry.surahNo}.json`),
            fetch(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${id}/${entry.surahNo}.json`)
        ]);

        const arabicSurah = await arabicRes.json();
        const translationJson = await translationRes.json();
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
        const entry = await AyahOfTheDay.findOne({ date: todayDateKey() });
        if (entry) {
          await resolveAyahText(entry, settings.primaryTranslation);
          res.locals.ayahOfTheDay = entry.toObject();
        }
      } catch (err) {
        console.error("ayah of the day: lookup failed -", err.message);
      }

      // Skip footer audio on surah pages (they have their own inline player)
      if (req.path.startsWith("/surah")) {
        return next();
      }

      if (settings.audioProgress && settings.audioProgress.surahNo) {
         const response = await fetch(
            `https://quranapi.pages.dev/api/${settings.audioProgress.surahNo}.json`
        );
        const audioSurah = await response.json();

        res.locals.footerAudio = {
          url: audioSurah.audio[settings.favoriteReciter].originalUrl,
          surahNo: settings.audioProgress.surahNo,
          surahName: settings.audioProgress.surahName,
          reciterName: audioSurah.audio[settings.favoriteReciter].reciter,
          time: settings.audioProgress.time
        };
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
        const response = await fetch(`https://quranapi.pages.dev/api/${surahNo}.json`);
        const surah = await response.json();

        if (!surah.audio || !surah.audio[reciter]) {
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

  app.post('/play-surah', (req, res) => {
    req.session.favoriteReciterName = req.body.reciterName;
    req.session.favoriteReciterUrl = req.body.audioUrl;
    req.session.canShowAudio = true;
    
    const referer = req.get("Referer") || "/";
    res.redirect(referer);
  });

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
    res.render('posts', { post });
  });

  app.get("/add-post", requireLogin, async(req, res) => {
    res.render("add-post");
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
    res.redirect("/posts");
  });

















// GET methods

app.get("/", async (req, res) => {
    const settings = await userData.getSettings(req);
    res.redirect("/" + (settings.defaultHome || "salah"));
});


app.get("/quran", async(req, res) => {
    const response = await fetch(`https://quranapi.pages.dev/api/surah.json`);
    const data = await response.json();

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
        }
    });
});



app.get("/surah/:surahNo", async (req, res) => {
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

    const response = await fetch(`https://quranapi.pages.dev/api/${surahNo}.json`);
    const surah = await response.json();
    const surahName = surah.surahName;

    const translationData = {};
    if (favoriteEdition.length > 0) {
        const translationPromises = favoriteEdition.map((combinedStr) => {
            const parts = combinedStr.split(':');
            const id = parts[0];
            const lan = parts[1] || "";
            const author = parts[2] || id;

            return fetch(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${id}/${surahNo}.json`)
                .then((res) => res.json())
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

    // Reading a surah counts as progress. Logged in it persists to the account;
    // anonymous readers get it in the cookie so it merges in on sign-in.
    await userData.recordSurahRead(req, surahNo);
    await userData.updateSettings(req, { audioProgress: { surahNo, surahName, time } });

    res.render("surah", {
        surah: surah,
        translations: translationData,
        favoriteReciter: String(reciter),
        favoriteFont: favoriteFont,
        surahNo: surahNo,
        audioTime: time,
        alwaysShowAudio: true,
        primaryTranslationId: primaryTranslationId,
        highlightAyah: parseInt(req.query.ayah, 10) || null,
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
    const response = await fetch('https://api.aladhan.com/v1/gToH');
    const data = await response.json();
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
            const responseMonth = await fetch(`https://api.aladhan.com/v1/currentIslamicMonth`);
            const json1 = await responseMonth.json();
            hijriMonth = json1.data;
        }
        if(!hijriYear){
            const responseYear = await fetch(`https://api.aladhan.com/v1/currentIslamicYear`);
            const json2 = await responseYear.json();
            hijriYear = json2.data;
        }

        const apiUrl = `https://api.aladhan.com/v1/hToGCalendar/${hijriMonth}/${hijriYear}`;
        const response = await fetch(apiUrl);
        const json = await response.json();

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
  

app.get("/settings", async (req, res) => {
    const reciters = await fetch(`https://quranapi.pages.dev/api/reciters.json`);
    const edition = await fetch('https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions.json');

    const recitersJson = await reciters.json();
    const editionsJson = await edition.json();

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
    const tarteelFonts = { 
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

    // Group by language
    const editionsByLanguage = {};
    for (let key in editionsJson) {
      const edition = editionsJson[key];
      const lang = edition.language || "Unknown";
      if (!editionsByLanguage[lang]) editionsByLanguage[lang] = [];
      editionsByLanguage[lang].push({
        name: edition.name,
        author: edition.author
      });
    }

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
        tgStatus: Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, req.query.tg || "") ||
                  req.query.tg === "sent" ? req.query.tg : "",
        tgFoundChatId: normalizeChatId(req.query.chat || ""),
        tgMessages: ERROR_MESSAGES,
        tarteelFonts: tarteelFonts,
        reciters: recitersJson, 
        editions: editionsByLanguage
    });
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

    const chatId = await userData.getTelegramChatId(req);
    if (!chatId) return;

    const text = buildStreakSummary({
        date: formattedDate,
        completed,
        challenges: updatedChallenges,
    });

    await sendTelegramMessage({ chatId, text });
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

    userData.updateSettings(req, { favoriteReciter: reciter })
        .then(() => {
            res.redirect(redirectTo);
        })
        .catch((err) => {
            console.error(err);
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
        // passport-local-mongoose v9 exposes register() as a Model static, not
        // an instance method (v8 had it on both).
        const user = await User.register({ email: email }, password);
        await mergeGuestIntoUser(req, user);
        req.logIn(user, (err) => {
            if (err) return res.status(500).send("Could not sign you in.");
            userData.clearGuestCookie(req, res);
            res.redirect(req.session.returnTo || "/challenges");
        });
    } catch (err) {
        // The plugin signals a duplicate with UserExistsError or a 11000 key
        // violation, depending on how the race resolves.
        const isDuplicate = (err && err.code === 11000)
            || (err && err.name === "UserExistsError");
        if (isDuplicate) return fail("That email is already registered.");
        console.error(err);
        return fail("Could not create the account. Please try again.");
    }
});

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

app.post("/test-telegram", async function(req, res){
    const redirectTo = pickField(req.body.redirectTo) || '/settings';
    try {
        if (!botIsConfigured()) return res.redirect(`${redirectTo}?tg=bot-missing`);
        const chatId = await userData.getTelegramChatId(req);
        if (!chatId) return res.redirect(`${redirectTo}?tg=missing`);

        const result = await sendTelegramMessage({
            chatId,
            text: `<b>Salah Tracker</b> — test message\n\nTelegram notifications are connected.`,
        });
        res.redirect(`${redirectTo}?tg=${result.sent ? 'sent' : result.code}`);
    } catch (err) {
        console.error(err);
        res.redirect(`${redirectTo}?tg=error`);
    }
});

// Reads back the user's most recent message to the bot so they never have to
// hunt down their own chat id.
app.post("/telegram-chat-id", async function(req, res){
    const redirectTo = pickField(req.body.redirectTo) || '/settings';
    try {
        if (!botIsConfigured()) return res.redirect(`${redirectTo}?tg=bot-missing`);
        const result = await findChatId();
        if (!result.chatId) {
            return res.redirect(`${redirectTo}?tg=${result.code || 'no-messages'}`);
        }
        // Remember it so the user doesn't have to re-discover it next session.
        await userData.setTelegramChatId(req, result.chatId);
        res.redirect(`${redirectTo}?chat=${encodeURIComponent(result.chatId)}`);
    } catch (err) {
        console.error(err);
        res.redirect(`${redirectTo}?tg=error`);
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
        if (!telegramRejected && cleanChatId) {
            await userData.setTelegramChatId(req, cleanChatId);
        }
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
});
