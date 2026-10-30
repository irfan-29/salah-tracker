// Warms the hadith cache: downloads every collection's Arabic + English
// editions from the jsDelivr CDN and stores them split per section, so the
// API routes only ever read small documents. Run with:
//
//   node scripts/seed-hadiths.js
//
// Idempotent - re-running refreshes the cached documents. The texts are
// immutable, so there is no need to run this on a schedule.

require("dotenv").config();
const mongoose = require("mongoose");
const { COLLECTIONS, seedCollection } = require("../api/utils/hadithStore.js");

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error("MONGO_URI is not set - add it to .env first.");
    process.exit(1);
}

(async () => {
    await mongoose.connect(MONGO_URI);
    // Optional argv ids: `node scripts/seed-hadiths.js qudsi dehlawi` seeds
    // only those collections - useful after a partial run.
    const wanted = process.argv.slice(2);
    const targets = wanted.length
        ? COLLECTIONS.filter((c) => wanted.includes(c.id) || wanted.some((w) => c.id.startsWith(w)))
        : COLLECTIONS;
    console.log("Connected. Seeding", targets.length, "hadith collections…");

    let failed = 0;
    for (const { id, name } of targets) {
        try {
            const t0 = Date.now();
            const result = await seedCollection(id);
            console.log(
                `✓ ${name}: ${result.hadiths} hadiths in ${result.sections} sections [${result.languages}] (${((Date.now() - t0) / 1000).toFixed(1)}s)`
            );
        } catch (err) {
            failed += 1;
            console.error(`✗ ${name}:`, err.message);
        }
    }

    await mongoose.disconnect();
    if (failed) {
        console.error(`${failed} collection(s) failed.`);
        process.exit(1);
    }
    console.log("Done.");
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
