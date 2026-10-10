const fetch = require("node-fetch");
const mongoose = require("mongoose");

// Surah text and translations are immutable, but every page view was re-fetching
// them from two upstreams. On Vercel that stack of sequential external calls is
// what pushed /surah/:no past the 10s invocation limit. Cache them in Mongo
// instead, with a bounded timeout so a slow upstream degrades instead of
// hanging the function.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const FETCH_TIMEOUT_MS = 5000;

const cacheSchema = new mongoose.Schema({
    key: { type: String, required: true },
    value: mongoose.Schema.Types.Mixed,
    fetchedAt: { type: Date, default: Date.now }
}, { _id: false, versionKey: false });

cacheSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: CACHE_TTL_MS / 1000 });
const Cache = mongoose.models.QuranCache || mongoose.model("QuranCache", cacheSchema);

// Per-instance memo so a warm function doesn't hit Mongo either.
const memo = new Map();
const MEMO_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function fetchJson(url) {
    const res = await fetch(url, { timeout: FETCH_TIMEOUT_MS });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
}

async function cachedJson(url) {
    const key = url;

    const hot = memo.get(key);
    if (hot && Date.now() - hot.at < MEMO_TTL_MS) return hot.value;

    try {
        const hit = await Cache.findOne({ key }).lean();
        if (hit && hit.value) {
            memo.set(key, { value: hit.value, at: Date.now() });
            return hit.value;
        }
    } catch (err) {
        // Cache unavailable (e.g. slow start-up) - fall through to the network.
        console.error("quranCache: read failed -", err.message);
    }

    const value = await fetchJson(url);

    memo.set(key, { value, at: Date.now() });
    try {
        await Cache.updateOne(
            { key },
            { $set: { value, fetchedAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        console.error("quranCache: write failed -", err.message);
    }
    return value;
}

// Best-effort variant: returns null instead of throwing, for callers that can
// still render something useful without the data.
async function cachedJsonOrNull(url) {
    try {
        return await cachedJson(url);
    } catch (err) {
        console.error("quranCache: fetch failed -", url, err.message);
        return null;
    }
}

module.exports = { cachedJson, cachedJsonOrNull, FETCH_TIMEOUT_MS };
