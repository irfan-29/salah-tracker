// One-time-password email delivery, via Resend.
//
// Sending the OTP is the part of signup that reaches outside the app, so it is
// isolated here: the routes above it only care whether a code was sent, not how.
//
// Two things this deliberately does not do:
//
//  * It does not decide when to send. Resend rate limits and the OTP rate limit
//    are enforced at the route, where the session lives.
//
//  * It does not throw on send failure. A signup must not be reported as failed
//    because a mail provider hiccupped - the account is still unverified, so
//    returning false lets the caller offer a resend instead of a dead end.

const crypto = require("crypto");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.RESEND_FROM || "Salah Tracker <onboarding@resend.dev>";

// The onboarding@resend.dev address only delivers to the account's own email,
// which is fine for local testing and useless in production. Catch that
// misconfiguration early rather than silently dropping every OTP.
function isProductionAddress() {
    return /@resend\.dev>\s*$/.test(FROM);
}

function isConfigured() {
    return Boolean(RESEND_API_KEY);
}

function warning() {
    if (!isConfigured()) return "RESEND_API_KEY is not set";
    if (isProductionAddress()) return "RESEND_FROM is still onboarding@resend.dev - that only delivers to your own inbox";
    return null;
}

/**
 * A 6-digit numeric code from a CSPRNG.
 *
 * Math.random() is not acceptable here: the code is a one-shot bearer token for
 * an account, and a predictable sequence lets someone claim an email they do
 * not own.
 */
function makeOtp() {
    // Rejection sampling, so every digit is equally likely. % 10 alone biases the
    // low digits whenever 2^32 is not a multiple of 10.
    let n;
    do {
        n = crypto.randomBytes(4).readUInt32BE(0);
    } while (n >= 4294967296 - (4294967296 % 1000000));
    return String(n % 1000000).padStart(6, "0");
}

/**
 * Hash an OTP for storage. A database or session-store read should not be
 * enough to log someone in, so the plaintext code is never persisted.
 */
function hashOtp(code) {
    return crypto.createHash("sha256").update(String(code)).digest("hex");
}

/** Constant-time comparison of two hex digests. */
function otpMatches(storedHash, candidate) {
    if (!storedHash) return false;
    const a = Buffer.from(String(storedHash), "utf8");
    const b = Buffer.from(hashOtp(candidate), "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

let resendClient = null;
function client() {
    if (!resendClient) {
        const { Resend } = require("resend");
        resendClient = new Resend(RESEND_API_KEY);
    }
    return resendClient;
}

// Development-only escape hatch. Without it the signup flow cannot be exercised
// locally, because the code is emailed and Resend is not configured there.
//
// Gated on BOTH flags on purpose. NODE_ENV alone is easy to leave unset in a
// deploy (this app runs on Vercel, where it commonly is), which would print
// every real user's code to the logs. Requiring OTP_DEV_ECHO as well means the
// only way to leak a code is to opt in twice.
function devEchoEnabled() {
    return process.env.OTP_DEV_ECHO === "true" && process.env.NODE_ENV !== "production";
}

async function sendOtpEmail({ to, code }) {
    if (!isConfigured()) {
        if (devEchoEnabled()) {
            console.warn(`email: RESEND_API_KEY not set - DEV ONLY, code for ${to}: ${code}`);
            return true;
        }
        console.error("email: RESEND_API_KEY is not set - OTP not sent.");
        return false;
    }
    try {
        const { error } = await client().emails.send({
            from: FROM,
            to: [to],
            subject: `${code} is your Salah Tracker verification code`,
            text: [
                `Your verification code is ${code}.`,
                "",
                "It expires in 10 minutes. If you did not try to create an account,",
                "you can ignore this email - no account was created.",
            ].join("\n"),
            html: [
                `<p>Your verification code is:</p>`,
                `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:20px 0">${code}</p>`,
                `<p style="color:#666">It expires in 10 minutes. If you did not try to create an account, you can ignore this email &mdash; no account was created.</p>`,
            ].join(""),
        });

        if (error) {
            console.error("email: Resend rejected the send -", error.message);
            return false;
        }
        return true;
    } catch (err) {
        console.error("email: send failed -", err.message);
        return false;
    }
}

module.exports = {
    isConfigured,
    warning,
    devEchoEnabled,
    makeOtp,
    hashOtp,
    otpMatches,
    sendOtpEmail,
};