// Diagnose the signup email transport without deploying.
//
//   npm run check:email -- you@example.com
//
// Sends a real OTP to the given address using the SAME credentials the app uses.
// The point is to separate the two things that look identical from the signup
// form:
//
//   fails here   -> the App Password or 2FA is wrong. Nothing to do with Vercel.
//   works here   -> the credentials are fine, so a failure in production means
//                   the deploy host is the problem (Vercel shares IP ranges that
//                   Gmail sometimes challenges).
//
// Reads GMAIL_USER / GMAIL_APP_PASSWORD from .env, so put the real values there
// rather than passing them on the command line, where they land in shell history.

require("dotenv").config();

const email = require("../api/services/email.js");

const GMAIL_ERRORS = {
    535: {
        what: "Gmail rejected the App Password.",
        fix: "Regenerate it at https://myaccount.google.com/apppasswords and update the value. If it is definitely correct, check that 2-Step Verification is still ON on the account."
    },
    534: {
        what: "Gmail requires 2-Step Verification before App Passwords work.",
        fix: "Turn on 2-Step Verification for the Google account, then create a new App Password."
    },
    421: {
        what: "Gmail is temporarily refusing sign-ins from this host.",
        fix: "Usually transient. Wait ~10 minutes and retry. Persistent 421 from a datacentre IP means Gmail is throttling this network."
    },
    550: {
        what: "Gmail refused the sender address.",
        fix: "The From address must be the same Gmail account you authenticate as."
    }
};

(async () => {
    const to = process.argv[2];
    if (!to) {
        console.error("Usage: npm run check:email -- you@example.com");
        process.exit(1);
    }

    const provider = email.resolvedProvider();
    console.log("provider    :", provider);
    console.log("configured  :", email.isConfigured());

    const problem = email.warning();
    if (problem) {
        console.error("PROBLEM     :", problem);
        process.exit(1);
    }

    const nodemailer = require("nodemailer");
    const user = process.env.GMAIL_USER || "";
    const pass = String(process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");

    const transport = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user, pass },
    });

    console.log("sending     : a real verification code to", to);
    console.log("from        :", user);
    console.log("");

    const started = Date.now();
    try {
        const info = await transport.sendMail({
            from: `"Hasanath" <${user}>`,
            to,
            subject: `${email.makeOtp()} is your Hasanath verification code`,
            text: "This is a test of the signup email transport.",
        });
        console.log(`SUCCESS in ${Date.now() - started}ms  (messageId ${info.messageId})`);
        console.log("");
        console.log("The credentials and this host are both fine.");
        console.log("If signup still fails on Vercel, the deploy host is being blocked -");
        console.log("check the Function Logs for the SMTP response there.");
    } catch (err) {
        const code = err && err.responseCode;
        console.error(`FAILED in ${Date.now() - started}ms`);
        console.error("  responseCode:", code, "| code:", err && err.code);
        console.error("  message     :", String(err && err.message).split("\n")[0].slice(0, 140));
        console.error("");
        const known = GMAIL_ERRORS[code];
        if (known) {
            console.error("WHAT    :", known.what);
            console.error("FIX     :", known.fix);
        } else {
            console.error("No specific guidance for this code - see the message above.");
        }
        process.exitCode = 1;
    } finally {
        email.close();
        transport.close();
    }
})();