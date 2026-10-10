const mongoose = require("mongoose");
// v9 ships as a transpiled ES module, so the plugin function lives on the
// default export rather than the module object.
const passportLocalMongoose = require("passport-local-mongoose").default;

// Per-user copies of the data that used to live in global collections.
// Embedded subdocuments keep a user's whole record in one document, matching
// the approach used in the class-irfan project.
const challengeSchema = new mongoose.Schema({
    challenge: String,
    currentStreak: Number,
    maxStreak: Number,
    lastUpdated: String
}, { _id: true });

const salahEntrySchema = new mongoose.Schema({
    date: String,
    name: String,
    value: String
}, { _id: false });

const settingsSchema = new mongoose.Schema({
    defaultHome: { type: String, default: "salah" },
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
    phone: String,
    lastReadSurahs: [String],
    challenges: [challengeSchema],
    salahLog: [salahEntrySchema],
    settings: { type: settingsSchema, default: () => ({}) },
    // Chat the app-level Salah Tracker bot should notify. Never a bot token:
    // one shared bot, many subscribers.
    telegramChatId: String,
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
    if (!this.settings) this.settings = {};
    next();
});

// Surah progress is capped so a long-lived account cannot grow unbounded.
userSchema.methods.pushLastReadSurah = function (surahNo) {
    const value = String(surahNo);
    this.lastReadSurahs = this.lastReadSurahs
        .filter((n) => n !== value)
        .unshift(value)
        .slice(0, 5);
};

module.exports = mongoose.model("User", userSchema);
module.exports.challengeSchema = challengeSchema;
module.exports.salahEntrySchema = salahEntrySchema;
module.exports.settingsSchema = settingsSchema;
