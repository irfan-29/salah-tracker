// One-time-password email delivery.
//
// Two transports, because they suit different situations:
//
//   gmail   - sends from a plain Gmail address over SMTP. Needs no domain and no
//             third-party account, but requires 2FA plus an App Password on that
//             Gmail, and consumer Gmail is capped around 500 messages/day. There
//             is no SPF/DKIM for the domain, so some mail lands in spam.
//
//   resend  - needs a domain you control and have verified in the Resend
//             dashboard. Better deliverability and far higher limits;
//             `onboarding@resend.dev` only ever delivers to the account's own
//             inbox, which is fine for local testing and useless for signups.
//
// EMAIL_PROVIDER picks one; "auto" prefers Gmail when its App Password is set
// and falls back to Resend, so a half-finished configuration still works.
//
// Sending the OTP is the part of signup that reaches outside the app, so it is
// isolated here: the routes above only care whether a code was sent, not how.
//
// It never throws on send failure. A signup must not be reported as failed
// because a mail provider hiccupped - the account is still unverified, so
// returning false lets the caller offer a resend instead of a dead end.

const crypto = require("crypto");

const PROVIDER = (process.env.EMAIL_PROVIDER || "auto").toLowerCase();

const GMAIL_USER = process.env.GMAIL_USER || "";
// Google shows app passwords in groups of four with spaces and expects them
// without, so they are stripped here rather than trusting users to paste right.
const GMAIL_APP_PASSWORD = String(process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const GMAIL_FROM_NAME = process.env.GMAIL_FROM_NAME || "Salah Tracker";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "Salah Tracker <onboarding@resend.dev>";

// onboarding@resend.dev only delivers to the account's own email, which is fine
// for local testing and useless in production. Catch that misconfiguration
// early rather than silently dropping every OTP.
function resendIsSandbox() {
    return /@resend\.dev>\s*$/.test(RESEND_FROM);
}

function resolvedProvider() {
    if (PROVIDER === "gmail" || PROVIDER === "resend") return PROVIDER;
    if (GMAIL_USER && GMAIL_APP_PASSWORD) return "gmail";
    if (RESEND_API_KEY) return "resend";
    return "none";
}

function isConfigured() {
    const provider = resolvedProvider();
    if (provider === "gmail") return Boolean(GMAIL_USER && GMAIL_APP_PASSWORD);
    if (provider === "resend") return Boolean(RESEND_API_KEY);
    return false;
}

/** Human-readable misconfiguration, or null when the transport looks usable. */
function warning() {
    const provider = resolvedProvider();
    if (provider === "none") {
        return "No email transport configured (set GMAIL_APP_PASSWORD or RESEND_API_KEY)";
    }
    if (provider === "gmail" && !GMAIL_USER) return "EMAIL_PROVIDER=gmail but GMAIL_USER is not set";
    if (provider === "gmail" && !GMAIL_APP_PASSWORD) {
        return "EMAIL_PROVIDER=gmail but GMAIL_APP_PASSWORD is not set (a Google App Password, spaces removed)";
    }
    if (provider === "resend" && !RESEND_API_KEY) return "EMAIL_PROVIDER=resend but RESEND_API_KEY is not set";
    if (provider === "resend" && resendIsSandbox()) {
        return "RESEND_FROM is still onboarding@resend.dev - that only delivers to your own inbox";
    }
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
function resend() {
    if (!resendClient) {
        const { Resend } = require("resend");
        resendClient = new Resend(RESEND_API_KEY);
    }
    return resendClient;
}

// One pooled SMTP connection, created lazily. Gmail rejects auth from unexpected
// hosts, so the transport is reused across sends rather than dialling per OTP.
let gmailTransport = null;
function gmail() {
    if (!gmailTransport) {
        const nodemailer = require("nodemailer");
        gmailTransport = nodemailer.createTransport({
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
            // Keep the connection warm between the rare sends this app makes.
            pool: true,
            maxConnections: 1,
        });
    }
    return gmailTransport;
}

function messageFor(code) {
    return {
        subject: `${code} is your Salah Tracker verification code`,
        text: [
            `Your verification code is ${code}.`,
            "",
            "It expires in 10 minutes. If you did not try to create an account,",
            "you can ignore this email - no account was created.",
        ].join("\n"),
        html: [
            "<p>Your verification code is:</p>",
            `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:20px 0">${code}</p>`,
            '<p style="color:#666">It expires in 10 minutes. If you did not try to create an account, you can ignore this email &mdash; no account was created.</p>',
        ].join(""),
    };
}

async function sendViaGmail({ to, code }) {
    const info = await gmail().sendMail({
        from: `"${GMAIL_FROM_NAME}" <${GMAIL_USER}>`,
        to,
        ...messageFor(code),
    });
    if (!info || !info.messageId) throw new Error("Gmail accepted the message but returned no id");
    return true;
}

async function sendViaResend({ to, code }) {
    const { error } = await resend().emails.send({
        from: RESEND_FROM,
        to: [to],
        ...messageFor(code),
    });
    if (error) throw new Error(error.message || "Resend rejected the send");
    return true;
}

// Development-only escape hatch. Without it the signup flow cannot be exercised
// locally, because the code is emailed and neither transport is configured
// there.
//
// Gated on BOTH flags, and the environment test is an ALLOWLIST rather than
// "anything that is not production". The first version read
//
//     OTP_DEV_ECHO === "true" && NODE_ENV !== "production"
//
// which is exactly backwards for this app: it runs on Vercel, where NODE_ENV is
// commonly UNSET. An unset NODE_ENV is not "production", so that comparison was
// true and the code was printed to the logs - a working test and a confirmed
// leak, since running with NODE_ENV unset is the realistic deploy case.
//
// Now it only unlocks when NODE_ENV is positively known to be development or
// test. Everything else, including unset, refuses.
function devEchoEnabled() {
    const env = String(process.env.NODE_ENV || "").toLowerCase();
    return process.env.OTP_DEV_ECHO === "true" && (env === "development" || env === "test");
}

/**
 * Deliver an OTP. Returns true on success, false on any failure - never throws,
 * because the caller can offer a resend but cannot handle an exception here.
 */
async function sendOtpEmail({ to, code }) {
    const provider = resolvedProvider();

    if (!isConfigured()) {
        if (devEchoEnabled()) {
            console.warn(`email: no transport configured - DEV ONLY, code for ${to}: ${code}`);
            return true;
        }
        console.error("email: transport not configured - OTP not sent. " + (warning() || ""));
        return false;
    }

    try {
        return provider === "gmail"
            ? await sendViaGmail({ to, code })
            : await sendViaResend({ to, code });
    } catch (err) {
        // Gmail surfaces 535 "Invalid credentials" for a wrong App Password and
        // 534 for 2FA not being enabled; both are misconfiguration rather than
        // a transient fault, so say so rather than logging a bare failure.
        const authHint = err && err.responseCode === 535
            ? " - Gmail rejected the App Password (check it is current and 2FA is on)"
            : "";
        console.error(`email: ${provider} send failed -${err.message}${authHint}`);
        return false;
    }
}

/** Release pooled SMTP sockets. Used by scripts and tests; harmless otherwise. */
function close() {
    if (gmailTransport && typeof gmailTransport.close === "function") {
        gmailTransport.close();
        gmailTransport = null;
    }
}

module.exports = {
    isConfigured,
    resolvedProvider,
    warning,
    close,
    devEchoEnabled,
    makeOtp,
    hashOtp,
    otpMatches,
    sendOtpEmail,
};