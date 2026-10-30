// --- Hadith module data ------------------------------------------------------
// The hadith texts come from the same publisher as the Quran editions
// (fawazahmed0, served over jsDelivr), but a whole book is far too large to
// fetch per request the way surah files are: Bukhari's Arabic edition alone is
// ~9MB. Instead each edition is split once into per-section documents and
// stored in the same immutable-JSON cache the Quran module uses (QuranCache).
// The seed script (scripts/seed-hadiths.js) warms every collection; the routes
// only ever read small per-section documents.

const fetch = require("node-fetch");
const mongoose = require("mongoose");

const FETCH_TIMEOUT_MS = 30000; // whole-edition downloads are megabytes

// Same collection and document shape as quranCache.js - immutable JSON keyed
// by string. Registering the same model name returns the existing model when
// the app already created it.
const cacheSchema = new mongoose.Schema({
    key: { type: String, required: true },
    value: mongoose.Schema.Types.Mixed,
    fetchedAt: { type: Date, default: Date.now }
}, { _id: false, versionKey: false });
const Cache = mongoose.models.QuranCache || mongoose.model("QuranCache", cacheSchema);

// Display order is also reading order: the two Saheehs first, then the other
// four canonical books, then the curated forties people actually memorise.
const COLLECTIONS = [
    { id: "bukhari", name: "Sahih al-Bukhari", translator: "Muhsin Khan" },
    { id: "muslim", name: "Sahih Muslim", translator: "Abdul Hamid Siddiqui" },
    { id: "abudawud", name: "Sunan Abu Dawud", translator: "English translation" },
    { id: "tirmidhi", name: "Jami at-Tirmidhi", translator: "English translation" },
    { id: "nasai", name: "Sunan an-Nasai", translator: "English translation" },
    { id: "ibnmajah", name: "Sunan Ibn Majah", translator: "English translation" },
    { id: "malik", name: "Muwatta Malik", translator: "English translation" },
    { id: "nawawi", name: "40 Hadith of Nawawi", translator: "Imam an-Nawawi" },
    { id: "qudsi", name: "40 Hadith Qudsi", translator: "English translation" },
    { id: "dehlawi", name: "40 Hadith of Dehlawi", translator: "Shah Waliullah Dehlawi" }
];

const EDITION_BASE = "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions";
const editionUrl = (id, lang) => `${EDITION_BASE}/${lang}-${id}.min.json`;

const manifestKey = (id) => `hadith:${id}:manifest`;
const sectionKey = (id, lang, section) => `hadith:${id}:${lang}:sec:${section}`;

// Flattens one edition's metadata into a section list. `section_details` maps
// every section id to the hadith-number range it covers; "0" is a synthetic
// root with no hadiths and is dropped.
function editionSections(editionJson) {
    const details = editionJson?.metadata?.section_details || {};
    const titles = editionJson?.metadata?.sections || {};
    return Object.keys(details)
        .filter((id) => id !== "0")
        .map((id) => ({
            id,
            title: (titles[id] || "").trim() || `Section ${id}`,
            first: details[id].hadithnumber_first,
            last: details[id].hadithnumber_last
        }))
        .filter((s) => s.last >= s.first);
}

// Joins the Arabic and English arrays of one section. The two editions are
// independent exports - lengths can differ by a narration or two - so entries
// are paired by their hadith number, and anything unmatched keeps its own text.
function zipSection(eng, ara) {
    const arabicByNumber = new Map((ara || []).map((h) => [String(h.hadithnumber), h.text]));
    return (eng || []).map((h) => ({
        number: h.hadithnumber,
        arabic: arabicByNumber.get(String(h.hadithnumber)) || "",
        text: h.text || "",
        grades: h.grades || [],
        reference: h.reference || null
    }));
}

async function fetchEdition(id, lang) {
    const res = await fetch(editionUrl(id, lang), { timeout: FETCH_TIMEOUT_MS });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${lang}-${id}`);
    return res.json();
}

async function putCache(key, value) {
    await Cache.updateOne(
        { key },
        { $set: { value, fetchedAt: new Date() } },
        { upsert: true }
    );
}

async function getCache(key) {
    const hit = await Cache.findOne({ key }).lean();
    return hit?.value || null;
}

// One-collection seed: downloads both editions, splits every section into a
// merged cache document, writes the manifest. Returns counts for the log.
async function seedCollection(id) {
    const [eng, ara] = await Promise.all([
        fetchEdition(id, "eng"),
        fetchEdition(id, "ara")
    ]);

    const sections = editionSections(eng);
    const engBySection = {};
    for (const h of (eng.hadiths || [])) {
        const sid = sectionIdFor(eng, h.hadithnumber);
        if (sid === null) continue;
        (engBySection[sid] = engBySection[sid] || []).push(h);
    }
    const araBySection = {};
    for (const h of (ara.hadiths || [])) {
        const sid = sectionIdFor(ara, h.hadithnumber);
        if (sid === null) continue;
        (araBySection[sid] = araBySection[sid] || []).push(h);
    }

    let written = 0;
    for (const section of sections) {
        const merged = zipSection(
            engBySection[section.id] || [],
            araBySection[section.id] || []
        );
        if (!merged.length) continue;
        await putCache(sectionKey(id, "eng", section.id), merged);
        written += merged.length;
    }

    const manifest = {
        id,
        name: eng?.metadata?.name || id,
        sections,
        total: (eng.hadiths || []).length
    };
    await putCache(manifestKey(id), manifest);
    return { sections: sections.length, hadiths: written };
}

// Maps a hadith's number to its section id using the edition's section_details
// ranges. Built per call from the closure edition - small enough at seed time.
function sectionIdFor(edition, hadithnumber) {
    const details = edition?.metadata?.section_details || {};
    for (const sid of Object.keys(details)) {
        const d = details[sid];
        if (hadithnumber >= d.hadithnumber_first && hadithnumber <= d.hadithnumber_last) {
            return sid === "0" ? null : sid;
        }
    }
    return null;
}

// --- Runtime reads ------------------------------------------------------------

async function getCollection(id) {
    const known = COLLECTIONS.find((c) => c.id === id);
    if (!known) return null;
    let manifest = await getCache(manifestKey(id));
    if (!manifest) {
        // Not seeded: build the manifest on demand from the network. Small
        // books succeed; the big ones are only reliable via the seed script.
        try {
            const [eng, ara] = await Promise.all([
                fetchEdition(id, "eng"),
                fetchEdition(id, "ara")
            ]);
            const sections = editionSections(eng);
            manifest = { id, name: eng?.metadata?.name || id, sections, total: (eng.hadiths || []).length };
            await putCache(manifestKey(id), manifest);
            for (const section of sections) {
                const engSect = (eng.hadiths || []).filter((h) => sectionIdFor(eng, h.hadithnumber) === section.id);
                const araSect = (ara.hadiths || []).filter((h) => sectionIdFor(ara, h.hadithnumber) === section.id);
                await putCache(sectionKey(id, "eng", section.id), zipSection(engSect, araSect));
            }
        } catch (err) {
            console.error("hadithStore: on-demand build failed -", err.message);
            return null;
        }
    }
    return { ...known, ...manifest, sections: manifest.sections || [] };
}

// One page of one section, merged Arabic + English.
async function getSection(id, sectionId, { page = 1, per = 25 } = {}) {
    const manifest = await getCache(manifestKey(id));
    if (!manifest) return null;
    const section = (manifest.sections || []).find((s) => String(s.id) === String(sectionId));
    if (!section) return null;

    const hadiths = (await getCache(sectionKey(id, "eng", section.id))) || [];
    const pages = Math.max(1, Math.ceil(hadiths.length / per));
    const safePage = Math.min(Math.max(1, page), pages);
    const slice = hadiths.slice((safePage - 1) * per, safePage * per);

    return {
        collection: id,
        name: manifest.name,
        section: { id: section.id, title: section.title },
        page: safePage,
        pages,
        per,
        total: hadiths.length,
        hadiths: slice
    };
}

module.exports = {
    COLLECTIONS,
    editionUrl,
    editionSections,
    seedCollection,
    getCollection,
    getSection
};
