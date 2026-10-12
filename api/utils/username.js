// Turning an email address into a public, shareable username.
//
// The obvious rule - take the part before the "@" - is right most of the time
// and wrong in a way that matters: local-parts are only unique WITHIN a domain.
// irfan@gmail.com and irfan@yahoo.com both want "irfan", so uniqueness has to be
// enforced separately from derivation.
//
// Handles the awkward cases:
//   "First.Last+tag@x.com"  -> "first.last"   (dot is meaningful, plus is not)
//   "  IRFAN@X.com  "       -> "irfan"        (case + whitespace normalised)
//   "1234" / "a" / very long -> reserved + suffix rather than accepted as-is
//   "posts" / "settings"    -> reserved, because they collide with real routes

// Routes that resolve at the top level. A username equal to one of these would
// make /u/posts ambiguous with the actual page, so it is never handed out.
const RESERVED = new Set([
    "admin", "administrator", "root", "api", "app", "settings", "login",
    "logout", "register", "signup", "signin", "posts", "add", "post", "edit",
    "profile", "user", "users", "u", "challenges", "salah", "quran", "calendar",
    "salah-timings", "surah", "video", "videos", "support", "help", "about",
    "terms", "privacy", "contact", "search", "explore", "home", "index",
    "null", "undefined", "me", "my", "new", "delete", "logout", "telegram",
    "surat", "ayah", "post-1", "new-task", "edit-challenge", "add-post",
    "add-video", "telegram-setup-code", "telegram-chat-id", "location",
]);

const MAX_LENGTH = 30;
const MIN_LENGTH = 3;

// Keeps what a person would expect to type. Deliberately stricter than the
// email rules: this is a public URL, and "/" "#" "%" would need escaping in one.
const VALID = /^[a-z0-9._]+$/;

/**
 * Normalise an arbitrary string into a candidate username.
 * Returns "" when nothing usable survives.
 */
function sanitize(raw) {
    let s = String(raw == null ? "" : raw).trim().toLowerCase();

    // The plus-addressing suffix (user+tag@host) is not part of the identity.
    const at = s.indexOf("@");
    if (at !== -1) s = s.slice(0, at);
    const plus = s.indexOf("+");
    if (plus !== -1) s = s.slice(0, plus);

    // Collapse runs of separators, and trim them from the edges so
    // ".irfan." does not become ".irfan".
    s = s.replace(/[.\-_]+/g, ".");
    s = s.replace(/^\.+|\.+$/g, "");

    // Strip anything outside the allowed set rather than rejecting outright:
    // "irfan!99" should still yield a usable "irfan99".
    s = s.replace(/[^a-z0-9._]/g, "");

    if (s.length > MAX_LENGTH) s = s.slice(0, MAX_LENGTH).replace(/\.+$/, "");
    return s;
}

/**
 * The natural username for an email address. Not guaranteed unique - callers
 * must run allocate() to resolve collisions.
 */
function fromEmail(email) {
    return sanitize(email);
}

function isReserved(name) {
    return RESERVED.has(name);
}

/**
 * Shape check only. Uniqueness requires a database round-trip; see allocate().
 */
function isValid(name) {
    return typeof name === "string"
        && name.length >= MIN_LENGTH
        && name.length <= MAX_LENGTH
        && VALID.test(name)
        && !isReserved(name)
        && name === name.toLowerCase()
        && !/^[.\-_]|[.\-_]$/.test(name);
}

/**
 * Find a free username, appending 2, 3, 4... until one is unused.
 *
 * `taken` must be an async predicate: (candidate) => Promise<boolean>. It is a
 * function rather than a query so this stays testable and so callers decide
 * whether the uniqueness scope is the whole table or a subset.
 *
 * Bounded rather than looping forever: a pathological case (every suffix taken)
 * gives up and returns null instead of spinning.
 */
async function allocate(preferred, taken, { maxAttempts = 50 } = {}) {
    const base = isValid(preferred) ? preferred : sanitize(preferred);

    // If the cleaned-up form is unusable (too short, reserved, empty), fall back
    // to a neutral base. "member" rather than "user", because "user" is itself
    // reserved and would silently become "user2".
    const stem = isValid(base) ? base : "member";

    if (!isReserved(stem) && !(await taken(stem))) return stem;

    for (let n = 2; n <= maxAttempts; n++) {
        const suffix = String(n);
        const trimmed = stem.slice(0, MAX_LENGTH - suffix.length).replace(/\.+$/, "");
        const candidate = `${trimmed}${suffix}`;
        if (!(await taken(candidate))) return candidate;
    }
    return null;
}

module.exports = { RESERVED, MIN_LENGTH, MAX_LENGTH, sanitize, fromEmail, isReserved, isValid, allocate };