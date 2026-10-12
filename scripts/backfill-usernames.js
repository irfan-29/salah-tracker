// Assigns a username to accounts that predate the field.
//
//   npm run backfill:usernames          # dry run - reports the plan only
//   npm run backfill:usernames -- --apply
//
// Dry run by default: this writes to a live collection, and a mistake here
// produces duplicate or reserved handles that are annoying to unwind after
// somebody has already shared a /u/<username> link.
//
// Idempotent - accounts that already have a valid username are left alone, so
// it is safe to re-run after adding new users.

require("dotenv").config();

const mongoose = require("mongoose");
const User = require("../api/models/User.js");
const u = require("../api/utils/username.js");

const APPLY = process.argv.includes("--apply");

(async () => {
    await mongoose.connect(process.env.MONGO_URI);
    const U = mongoose.connection.collection("users");

    const all = await U.find({}).sort({ _id: 1 }).toArray();
    console.log(`accounts: ${all.length}  mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

    // Reserve names already in use, so a backfilled account cannot steal a
    // handle that a verified signup claimed in the meantime.
    const claimed = new Set();
    for (const u0 of all) {
        if (u0.username) claimed.add(u0.username);
    }

    const planned = [];
    for (const doc of all) {
        if (doc.username && u.isValid(doc.username)) {
            planned.push({ email: doc.email, username: doc.username, action: "keep" });
            continue;
        }

        const name = await u.allocate(u.fromEmail(doc.email), async (candidate) => claimed.has(candidate));
        if (!name) {
            console.error(`  ${doc.email}: could not allocate a username - skipped`);
            continue;
        }
        claimed.add(name);
        planned.push({ email: doc.email, username: name, action: doc.username ? "replace" : "set" });
    }

    const width = Math.max(...planned.map((p) => p.email.length));
    for (const p of planned) {
        const mark = p.action === "keep" ? "=" : p.action === "set" ? "+" : "~";
        console.log(`  ${mark} ${p.email.padEnd(width)}  ->  ${p.username}`);
    }

    const changes = planned.filter((p) => p.action !== "keep");
    console.log(`\n${changes.length} to change, ${planned.length - changes.length} unchanged.`);

    if (!APPLY) {
        console.log("\nDry run. Re-run with --apply to write.");
    } else {
        for (const p of changes) {
            await U.updateOne({ email: p.email }, { $set: { username: p.username } });
        }
        console.log(`\nApplied ${changes.length} changes.`);

        // Confirm no duplicates survived the write.
        const dupes = await U.aggregate([
            { $match: { username: { $type: "string" } } },
            { $group: { _id: "$username", n: { $sum: 1 } } },
            { $match: { n: { $gt: 1 } } },
        ]).toArray();
        console.log(dupes.length ? `DUPLICATES: ${JSON.stringify(dupes)}` : "No duplicate usernames.");
    }

    await mongoose.disconnect();
})().catch((err) => {
    console.error("ERR:", err.message);
    process.exit(1);
});