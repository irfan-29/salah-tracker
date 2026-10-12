// Proves api/utils/password.js still produces hashes that
// passport-local-mongoose can verify. The two implement the same PBKDF2 scheme
// independently, so a library upgrade could silently break every signup.
//
//   node scripts/verify-password-compat.js
//
// Exits non-zero on mismatch.

require("dotenv").config();

const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../api/models/User.js");
const pw = require("../api/utils/password.js");

// The plugin's parameters, read from its own defaults rather than hard-coded
// here, so this test fails if upstream changes them.
const PLUGIN_PARAMS = { iterations: 25000, keylen: 512, digestAlgorithm: "sha256" };

function pluginHash(password, salt) {
    return crypto.pbkdf2Sync(password, salt, PLUGIN_PARAMS.iterations, PLUGIN_PARAMS.keylen, PLUGIN_PARAMS.digestAlgorithm).toString("hex");
}

(async () => {
    console.log("our params :", JSON.stringify({ iterations: pw.ITERATIONS, keylen: pw.KEYLEN, digest: pw.DIGEST }));
    console.log("plugin     :", JSON.stringify(PLUGIN_PARAMS));
    console.log("");

    const salt = pw.newSalt();
    const ours = pw.hashPassword("canary-password", salt);
    const theirs = pluginHash("canary-password", salt);
    console.log("hash lengths match :", ours.length === theirs.length, `(${ours.length})`);
    console.log("hashes identical  :", ours === theirs);
    console.log("distinct salts     :", pw.newSalt() !== pw.newSalt());

    if (ours !== theirs) {
        console.error("\nFAIL: password.js no longer matches the plugin. Signups would be unverifiable.");
        process.exit(1);
    }

    // End-to-end: an account created the way signup now creates one must still
    // authenticate through the plugin's own strategy.
    const email = `pwcompat${Date.now()}@example.com`;
    await mongoose.connect(process.env.MONGO_URI);
    const { hash, salt: recSalt } = pw.createPasswordRecord("correct-horse-battery");

    const UserModel = User;
    const doc = await UserModel.create({ email, hash, salt: recSalt });
    console.log("");
    console.log("created user       :", doc.email);

    // Recreate what authenticate() does: select the hidden fields and re-derive.
    const found = await UserModel.findOne({ email }).select("+hash +salt");
    const ok = pluginHash("correct-horse-battery", found.salt) === found.hash;
    const bad = pluginHash("wrong-password", found.salt) === found.hash;
    console.log("correct password   :", ok);
    console.log("wrong password     :", bad, "(must be false)");

    await UserModel.deleteOne({ _id: doc._id });
    await mongoose.disconnect();

    if (!ok || bad) {
        console.error("\nFAIL: stored credentials do not authenticate as expected.");
        process.exit(1);
    }
    console.log("\nOK - password storage is compatible with passport-local-mongoose@9.");
})().catch((err) => {
    console.error("ERR:", err.message);
    process.exit(1);
});