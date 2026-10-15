// Favourite ayahs: storage, validation, and rendering the text for display.
//
// Only the coordinates ({ surahNo, ayahNo }) are stored, never the text. The
// text comes from the same cached upstream the reader uses, so a user who later
// changes their primary translation sees their favourites in that edition too -
// and the document cannot grow without bound as ayahs accumulate.

const User = require("../models/User.js");

const MAX_AYAHS_PER_SURAH = 286; // Al-Baqarah, the longest surah

/** Coerce and bounds-check a surah/ayah pair. Returns null when unusable. */
function normalise(surahNo, ayahNo, totalAyah) {
    const s = Number.parseInt(surahNo, 10);
    const a = Number.parseInt(ayahNo, 10);

    if (!Number.isInteger(s) || s < 1 || s > 114) return null;
    if (!Number.isInteger(a) || a < 1 || a > MAX_AYAHS_PER_SURAH) return null;
    // When the surah's real length is known, enforce it - otherwise an ayah 999
    // of Al-Fatiha would be stored and fail to resolve forever on display.
    if (Number.isInteger(totalAyah) && a > totalAyah) return null;
    return { surahNo: s, ayahNo: a };
}

/** True when the signed-in user has this ayah starred. Guests never have any. */
function isFavorite(req, surahNo, ayahNo) {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) return false;
    return req.user.isFavoriteAyah(surahNo, ayahNo);
}

/** The coordinates only, newest first - what the reader needs to paint hearts. */
function listCoordinates(req) {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) return [];
    return Array.from(req.user.favoriteAyahs || [])
        .map((f) => ({ surahNo: Number(f.surahNo), ayahNo: Number(f.ayahNo) }))
        .filter((f) => Number.isInteger(f.surahNo) && Number.isInteger(f.ayahNo));
}

/** A "surahNo:ayahNo" key, which is what the client uses to match buttons. */
function keyOf(surahNo, ayahNo) {
    return `${Number(surahNo)}:${Number(ayahNo)}`;
}

function keysFor(req) {
    return new Set(listCoordinates(req).map((f) => keyOf(f.surahNo, f.ayahNo)));
}

/**
 * Resolve saved ayahs to displayable entries.
 *
 * Grouped by surah so each surah is fetched once: a user with 40 favourites
 * spread over 30 surahs costs 30 cached reads, not 40, and the surah cache has a
 * 30 day TTL so these are usually already warm.
 *
 * `loadSurah(surahNo)` and `loadEdition(id, surahNo)` are injected so this
 * module does not depend on the HTTP client, and so callers can share one
 * cache-aware fetcher.
 */
async function resolveFavourites(req, { loadSurah, loadEdition, editionId, editionLabel }) {
    const coords = listCoordinates(req);
    if (!coords.length) return [];

    const bySurah = new Map();
    for (const c of coords) {
        if (!bySurah.has(c.surahNo)) bySurah.set(c.surahNo, []);
        bySurah.get(c.surahNo).push(c.ayahNo);
    }

    const entries = [];
    for (const [surahNo, ayahNos] of bySurah) {
        const surah = await loadSurah(surahNo).catch(() => null);
        if (!surah) {
            // Keep the coordinate so the user can still see that something is
            // saved, rather than the entry silently vanishing.
            entries.push({
                surahNo,
                surahName: `Surah ${surahNo}`,
                ayahNo: ayahNos[0],
                unavailable: true,
                arabicText: "",
                translationText: ""
            });
            continue;
        }

        let edition = null;
        if (editionId) {
            edition = await loadEdition(editionId, surahNo).catch(() => null);
        }

        for (const ayahNo of ayahNos) {
            const arabic = Array.isArray(surah.arabic1) ? surah.arabic1[ayahNo - 1] : null;
            const translated = edition && edition.chapter ? edition.chapter[ayahNo - 1] : null;

            entries.push({
                surahNo,
                ayahNo,
                surahName: surah.surahName || `Surah ${surahNo}`,
                surahNameArabic: surah.surahNameArabic || "",
                // Arabic is required for the card to be meaningful; a translation
                // is not, since the user may have no edition configured.
                arabicText: arabic || "",
                translationText: translated ? translated.text : "",
                translationLabel: editionLabel || ""
            });
        }
    }

    // Newest first, matching the order they were added.
    const order = new Map(coords.map((c, i) => [keyOf(c.surahNo, c.ayahNo), i]));
    entries.sort((a, b) => order.get(keyOf(a.surahNo, a.ayahNo)) - order.get(keyOf(b.surahNo, b.ayahNo)));

    return entries;
}

module.exports = {
    MAX_AYAHS_PER_SURAH,
    normalise,
    isFavorite,
    listCoordinates,
    keysFor,
    keyOf,
    resolveFavourites,
};