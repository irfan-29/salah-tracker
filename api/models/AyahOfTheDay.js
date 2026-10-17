const mongoose = require("mongoose");

// The daily ayah is global: one document per date, shared by every visitor.
// Kept in its own module so the scheduler can require it directly instead of
// depending on app.js having been loaded first.
const ayahOfTheDaySchema = new mongoose.Schema({
    date: { type: String, unique: true },
    surahNo: Number,
    ayahNo: Number,
    // Resolved text is cached so the daily ayah costs one upstream fetch per day
    // rather than one per page view, and so guests (who have no saved
    // translation preference) still see it.
    //
    // `variants` is keyed by the full edition string, e.g.
    // "taml-abdulhameedbaqavi:Tamil:Abdulhameed Baqavi". Caching one
    // translation on the date document meant the first visitor of the day
    // decided it for everyone - usually the English default, because a guest
    // usually arrives first. Keying by edition keeps the caching benefit while
    // giving each reader their own primary translation.
    variants: { type: Map, of: Object, default: () => new Map() },
    // Top-level copies of whichever variant resolved most recently, kept so
    // existing readers of this model keep working.
    surahName: String,
    surahNameArabic: String,
    arabicText: String,
    translationText: String,
    translationLabel: String,
    resolvedAt: Date
});

module.exports = mongoose.models.AyahOfTheDay
    || mongoose.model("AyahOfTheDay", ayahOfTheDaySchema);
