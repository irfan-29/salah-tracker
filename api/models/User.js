const mongoose = require("mongoose");
// v9 ships as a transpiled ES module, so the plugin function lives on the
// default export rather than the module object.
const passportLocalMongoose = require("passport-local-mongoose").default;

// Per-user copies of the data that used to live in global collections.
// Embedded subdocuments keep a user's whole record in one document, matching
// the approach used in the class-irfan project.
const salahEntrySchema = new mongoose.Schema({
    date: String,
    name: String,
    value: String
}, { _id: false });

const donationSchema = new mongoose.Schema({
    amount: { type: Number, required: true, min: [0.01, "Donations must be greater than zero"] },
    // ISO YYYY-MM-DD. A donation is attached to a calendar day because charity
    // targets recur: daily / weekly / monthly / yearly totals are built by
    // filtering on this key.
    date: { type: String, required: true },
    note: { type: String, default: "", trim: true }
}, { _id: false });

const charitySchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    // A recurring target. The matching donations are summed only inside the
    // day / week / month / year a charity is viewed in, so progress resets the
    // way the user chose while lifetime totals remain on the donations.
    targetAmount: { type: Number, required: true, min: 0 },
    period: {
        type: String,
        enum: ["daily", "weekly", "monthly", "yearly"],
        default: "monthly"
    },
    donations: [donationSchema],
    createdAt: { type: Date, default: Date.now }
}, { _id: true });

const challengeSchema = new mongoose.Schema({
    challenge: String,
    currentStreak: Number,
    maxStreak: Number,
    lastUpdated: String,
    // ISO dates the challenge was checked in on. Streak counts are enough for
    // the tracker list, but the stats report needs actual days to plot, so
    // every future check-in records its date here.
    history: [String]
}, { _id: true });

const settingsSchema = new mongoose.Schema({
    defaultHome: { type: String, default: "quran" },
    location: { type: String, default: "Coimbatore" },
    favoriteReciter: { type: Number, default: 1 },
    favoriteFont: String,
    favoriteEdition: [String],
    primaryTranslation: String,
    theme: { type: String, default: "light" },
    audioProgress: {
        surahNo: Number,
        surahName: String,
        time: Number
    }
}, { _id: false });

const userSchema = new mongoose.Schema({
    name: String,
    // Public handle, derived from the email local-part at signup and used in
    // /u/<username>. Unique because two people may share a local-part across
    // different providers (irfan@gmail.com vs irfan@yahoo.com) - the collision
    // is resolved with a numeric suffix by api/utils/username.js.
    // sparse so an account that predates this field does not collide with
    // every other account at the single null value.
    username: { type: String, unique: true, sparse: true },
    // Set once the emailed OTP is confirmed. Signup does not create a User at
    // all until then, so this is a backstop rather than the primary gate.
    emailVerifiedAt: Date,
    phone: String,
    lastReadSurahs: [String],
    // Ayahs the user has starred. Stored as { surahNo, ayahNo } rather than the
    // text itself: the text is served from the same cached upstream the reader
    // uses, so copying it would freeze one translation per favourite and make
    // changing edition pointless.
    favoriteAyahs: [{
        surahNo: { type: Number, required: true },
        ayahNo: { type: Number, required: true },
        addedAt: { type: Date, default: Date.now }
    }],
    challenges: [challengeSchema],
    charities: [charitySchema],
    salahLog: [salahEntrySchema],
    settings: { type: settingsSchema, default: () => ({}) },
    // Chat the app-level Hasanath bot should notify. Never a bot token:
    // one shared bot, many subscribers.
    telegramChatId: String,
    // Notification preferences. Time-based ones are evaluated in the user's own
    // timezone because Vercel cron is always UTC.
    telegram: {
        enabled: { type: Boolean, default: false },
        timezone: { type: String, default: "UTC" },
        events: {
            challenges: { type: Boolean, default: true },
            salahTracker: { type: Boolean, default: false },
            newPost: { type: Boolean, default: false },
            salahTimings: { type: Boolean, default: false },
            ayahOfTheDay: { type: Boolean, default: true }
        },
        times: {
            // HH:MM in the user's timezone. Only the two daily, time-based
            // modules take a time; challenges / salah log / new post are
            // event-driven and fire the moment the action happens.
            ayahOfTheDay: { type: String, default: "05:30" },
            salahTimings: { type: String, default: "05:00" }
        },
        // Date keys ("YYYY-MM-DD") of the last time each scheduled event fired,
        // so a due-check never sends the same day's message twice.
        lastSent: {
            ayahOfTheDay: String,
            salahTimings: String
        }
    },
    claimsMigratedAt: Date
});

// Field names are configured on the PLUGIN, not on createStrategy() - in v9
// createStrategy() takes no arguments and reads these closure options. The
// plugin adds `email` (unique), `hash` and `salt`; hash/salt are select:false.
userSchema.plugin(passportLocalMongoose, {
    usernameField: "email",
    passwordField: "password",
    usernameLowerCase: true
});

userSchema.pre("save", function (next) {
    if (this.isModified("email") && this.email) this.email = this.email.trim().toLowerCase();
    // Usernames are compared case-insensitively everywhere, so normalise on the
    // way in rather than relying on every reader to remember to lower-case.
    if (this.isModified("username") && this.username) {
        this.username = this.username.trim().toLowerCase();
    }
    if (!this.settings) this.settings = {};
    next();
});

// Surah progress is capped so a long-lived account cannot grow unbounded.
// Build a plain array: `this.lastReadSurahs` is a Mongoose DocumentArray, whose
// .filter() returns a plain array that has no .unshift().
userSchema.methods.pushLastReadSurah = function (surahNo) {
    const value = String(surahNo);
    const existing = Array.from(this.lastReadSurahs || []);
    this.lastReadSurahs = [value, ...existing.filter((n) => String(n) !== value)].slice(0, 5);
};

// Favourites are capped for the same reason as last-read: unbounded growth on a
// single user document eventually hits the 16MB document limit.
const MAX_FAVORITE_AYAHS = 300;

// Star or unstar an ayah. Returns true when it ended up favourited, so the
// caller can answer the click without re-reading the array.
userSchema.methods.toggleFavoriteAyah = function (surahNo, ayahNo) {
    const s = Number(surahNo);
    const a = Number(ayahNo);
    const list = Array.from(this.favoriteAyahs || []);
    const index = list.findIndex((f) => Number(f.surahNo) === s && Number(f.ayahNo) === a);

    if (index !== -1) {
        list.splice(index, 1);
        this.favoriteAyahs = list;
        return false;
    }

    // Newest first, so the favourites list reads in the order things were added.
    this.favoriteAyahs = [{ surahNo: s, ayahNo: a, addedAt: new Date() }, ...list].slice(0, MAX_FAVORITE_AYAHS);
    return true;
};

userSchema.methods.isFavoriteAyah = function (surahNo, ayahNo) {
    const s = Number(surahNo);
    const a = Number(ayahNo);
    return Array.from(this.favoriteAyahs || []).some((f) => Number(f.surahNo) === s && Number(f.ayahNo) === a);
};

module.exports = mongoose.model("User", userSchema);
module.exports.MAX_FAVORITE_AYAHS = MAX_FAVORITE_AYAHS;
module.exports.challengeSchema = challengeSchema;
module.exports.charitySchema = charitySchema;
module.exports.donationSchema = donationSchema;
module.exports.salahEntrySchema = salahEntrySchema;
module.exports.settingsSchema = settingsSchema;
