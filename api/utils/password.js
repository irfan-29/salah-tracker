// Password hashing for the pending-signup window.
//
// passport-local-mongoose v9 does NOT use bcrypt. It PBKDF2-SHA256s the
// password with a random 32-byte salt (25,000 iterations, 512-byte key, hex).
// A User row is only created once the emailed OTP is confirmed, but the
// password still has to survive the ~10 minutes in between - and it should not
// sit in the session store in plaintext.
//
// So the same scheme is reproduced here. Verified against User.register() by
// scripts/verify-password-compat.js, because a mismatch would produce accounts
// nobody can ever log in to.
//
// The alternative - calling User.register() on a throwaway document - would keep
// this in step with the library automatically, at the cost of writing and
// deleting a row to end up with a hash. If the plugin ever changes its
// parameters, the verification script is what catches it.

const crypto = require("crypto");

// Mirrors passport-local-mongoose@9 defaults.
const ITERATIONS = 25000;
const KEYLEN = 512;
const DIGEST = "sha256";
const SALT_BYTES = 32;

function newSalt() {
    return crypto.randomBytes(SALT_BYTES).toString("hex");
}

function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString("hex");
}

/** Produce the { hash, salt } pair the plugin expects to find on a User. */
function createPasswordRecord(password) {
    const salt = newSalt();
    return { hash: hashPassword(password, salt), salt };
}

/** True when these parameters still produce hashes the plugin can verify. */
function verifyAgainstPlugin() {
    const crypto2 = require("crypto");
    const salt = newSalt();
    const pluginHash = crypto2.pbkdf2Sync("canary-password", salt, ITERATIONS, KEYLEN, DIGEST).toString("hex");
    return pluginHash === hashPassword("canary-password", salt);
}

module.exports = { createPasswordRecord, hashPassword, newSalt, ITERATIONS, KEYLEN, DIGEST, SALT_BYTES };