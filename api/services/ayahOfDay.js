// Resolves the text of the daily ayah in a specific translation edition.
//
// This lives in its own module because two very different callers need it:
//
//   - GET /api/quran/index, rendering the widget on the Quran page
//   - notifyScheduler, building the Telegram message
//
// They used to read the same shared document and disagree: the page took
// `entry.translationText` and the scheduler took `ayah.translationText`, but
// that single cached field held whichever edition resolved FIRST that day.
// Usually a guest, who has no saved preference and so gets the English default -
// which is why Ayah of the Day kept arriving in English for everyone who had
// chosen another primary translation, on screen and in Telegram alike.
//
// The fix is to cache per edition. Resolved text is keyed by the full edition
// string in the document's `variants` map, so each reader gets their own
// translation and the cache still saves the upstream fetch for everyone else
// using that edition.

const { cachedJson } = require("../utils/quranCache.js");

// Shown to anyone who has not chosen a translation yet, so the daily ayah is
// never blank for a guest or a brand-new account.
const DEFAULT_TRANSLATION = "eng-abdullahyusufal:English:Abdullah Yusuf Ali";

function parseEdition(combinedStr) {
    const parts = String(combinedStr || "").split(":");
    return {
        id: parts[0] || "",
        lan: parts[1] || "",
        author: parts[2] || parts[0] || "",
    };
}

// Copies a variant onto the document's top-level fields so existing readers of
// the model keep working.
function applyVariant(entry, variant) {
    entry.arabicText = variant.arabicText;
    entry.translationText = variant.translationText;
    entry.translationLabel = variant.translationLabel;
    return entry;
}

/**
 * Ensures `entry` has resolved text for `edition`, and leaves that edition's
 * text on the document's top-level fields.
 *
 * Returns immediately when the edition is already cached, so calling this on
 * every request is cheap. Accepts either a Mongoose document or a lean object;
 * a lean object is fetched again only when the variant is missing.
 */
async function resolveAyahText(entry, edition) {
    if (!entry) return entry;

    const chosen = edition || DEFAULT_TRANSLATION;

    // A lean object from findOne().lean() has no .set(), so re-read as a
    // document before writing.
    let doc = entry;
    if (!doc.variants || typeof doc.variants.get !== "function") {
        const AyahOfTheDay = require("../models/AyahOfTheDay.js");
        doc = await AyahOfTheDay.findOne({ date: entry.date });
        if (!doc) return entry;
    }

    if (!doc.variants) doc.variants = new Map();
    const cached = doc.variants.get(chosen);
    if (cached && cached.translationText !== undefined) {
        return applyVariant(doc, cached);
    }

    const { id, lan, author } = parseEdition(chosen);

    try {
        const [arabicSurah, translationJson] = await Promise.all([
            cachedJson(`https://quranapi.pages.dev/api/${doc.surahNo}.json`),
            cachedJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${id}/${doc.surahNo}.json`),
        ]);
        const ayahIndex = doc.ayahNo - 1;

        const variant = {
            arabicText: arabicSurah.arabic1?.[ayahIndex] || "",
            translationText: translationJson.chapter?.[ayahIndex]?.text || "",
            translationLabel: `${lan} - ${author}`,
            resolvedAt: new Date(),
        };

        doc.variants.set(chosen, variant);
        // Surah names are edition-independent, so they live on the document
        // rather than in every variant.
        doc.surahName = arabicSurah.surahName || doc.surahName;
        doc.surahNameArabic = arabicSurah.surahNameArabic || doc.surahNameArabic;
        doc.resolvedAt = new Date();
        await doc.save();

        return applyVariant(doc, variant);
    } catch (err) {
        // Never let an upstream fetch failure break the page or the send.
        console.error("ayah of the day: text fetch failed -", err.message);
        return doc;
    }
}

/**
 * Read-only variant for callers that must not write: used by the scheduler,
 * which fans out over every user and would otherwise hammer the database with
 * a save per recipient. Falls back to whatever is cached if the upstream fetch
 * fails.
 */
async function ayahTextForEdition(leanEntry, edition) {
    if (!leanEntry) return null;
    const chosen = edition || DEFAULT_TRANSLATION;

    const variants = leanEntry.variants;
    const cached = variants && typeof variants.get === "function"
        ? variants.get(chosen)
        : variants && typeof variants === "object"
            ? variants[chosen]
            : null;

    if (cached) return { ...leanEntry, ...cached };

    const AyahOfTheDay = require("../models/AyahOfTheDay.js");
    const fresh = await AyahOfTheDay.findOne({ date: leanEntry.date });
    if (!fresh) return leanEntry;
    const resolved = await resolveAyahText(fresh, chosen);
    return { ...leanEntry, arabicText: resolved.arabicText, translationText: resolved.translationText, translationLabel: resolved.translationLabel };
}

module.exports = {
    DEFAULT_TRANSLATION,
    parseEdition,
    resolveAyahText,
    ayahTextForEdition,
};