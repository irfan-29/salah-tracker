// Upstash QStash integration: verifies that a request really came from QStash,
// and owns the schedule that drives the notification sweep.
//
// Why QStash and not a plain cron
// -------------------------------
// Vercel Hobby rejects sub-daily cron expressions, and GitHub Actions' scheduled
// workflows gave no delivery guarantee at all (measured: one run in nearly three
// hours against a */5 schedule). QStash is a real scheduler that bills by
// message, so the interval is a cost decision rather than a guess - see
// api/utils/qstash.js -> SWEEP_CRON below and scripts/qstash-schedule.js.
//
// Cost safety
// -----------
// QStash's free tier allows 1,000 messages/day and bills EVERY delivery attempt,
// retries included. So the daily cost is:
//
//     triggers/day * attempts-per-trigger
//
// The sweep schedule therefore pins `retries` low instead of inheriting the
// account default ("the maximum retry quota associated with your account",
// which is exactly the setting that turns a broken endpoint into a bill). At the
// default interval that is 144 * 2 = 288 messages/day worst case, ~29% of the
// free tier - it still fits on a day when every single delivery fails.
//
// The endpoint deliberately does NOT re-publish itself. A self-chaining endpoint
// is one dropped request away from splitting into two chains and doubling the
// bill, and it needs a watchdog to recover. A QStash schedule is owned by
// QStash: it cannot fork, and it survives endpoint failures on its own.
//
// Everything here is lazy. The app must boot fine with no QStash configuration
// at all, since the sweep is only one of several ways notifications are sent.

const { Client, Receiver } = require("@upstash/qstash");

// How often the sweep runs. Every 10 minutes costs 144 messages/day, or 288/day
// with one retry - comfortably inside the 1,000/day free tier.
//
// Going to */5 would cost 288/day (576 worst case) and still fit, but it halves
// the headroom for free in exchange for 5 minutes of latency. Change it only if
// delivery precision starts to matter more than the margin, and re-check the
// arithmetic above first.
const SWEEP_CRON = process.env.QSTASH_SWEEP_CRON || "*/10 * * * *";

// One retry, not the account default. A sweep that 500s is usually a transient
// Vercel cold start, and one more attempt is enough; each additional retry is
// another billed message.
const SWEEP_RETRIES = 1;

// A stable name so re-running the setup script updates the existing schedule
// rather than creating a second one (the free tier allows 10, but duplicates
// would double the daily cost).
const SCHEDULE_NAME = "salah-notify-sweep";

let receiver;
let client;

// QStash's console gives a per-region QSTASH_URL (e.g.
// https://qstash-us-east-1.upstash.io). The SDK falls back to the global
// https://qstash.upstash.io when that is unset - which accepts the request and
// then rejects it, because the token belongs to a regional instance. Passing it
// explicitly turns a confusing runtime auth failure into a startup check.
function baseUrl() {
    return (process.env.QSTASH_URL || "").replace(/\/+$/, "");
}

function token() {
    return process.env.QSTASH_TOKEN || "";
}

function receiverConfig() {
    return {
        currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
        nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
    };
}

function isConfigured() {
    return Boolean(
        token() &&
        baseUrl() &&
        process.env.QSTASH_CURRENT_SIGNING_KEY &&
        process.env.QSTASH_APP_URL
    );
}

// Environment variables missing for the QStash feature to work at all. Reported
// together so a half-configured deploy is obvious in one place.
function missingConfig() {
    const required = {
        QSTASH_TOKEN: "QStash REST API token",
        QSTASH_URL: "QStash API URL, e.g. https://qstash-us-east-1.upstash.io",
        QSTASH_CURRENT_SIGNING_KEY: "current signing key",
        QSTASH_NEXT_SIGNING_KEY: "next signing key",
        QSTASH_APP_URL: "public base URL of this app",
    };
    return Object.entries(required)
        .filter(([key]) => !process.env[key])
        .map(([key, desc]) => `${key} (${desc})`);
}

function getReceiver() {
    if (!receiver) receiver = new Receiver(receiverConfig());
    return receiver;
}

function getClient() {
    if (!client) client = new Client({ token: token(), baseUrl: baseUrl() });
    return client;
}

// The public URL QStash delivers to. Taken from configuration rather than the
// request, because signature verification covers the URL and the app may see it
// as http, on a different host, or behind a proxy.
function sweepUrl() {
    const base = (process.env.QSTASH_APP_URL || "").replace(/\/+$/, "");
    return `${base}/api/qstash/sweep`;
}

// Verify the Upstash-Signature header. The body must be the RAW bytes QStash
// signed - a re-serialised JSON object will not match.
async function verify({ signature, body }) {
    if (!signature) return false;
    try {
        return await getReceiver().verify({
            signature,
            body: body || "",
            url: sweepUrl(),
        });
    } catch (err) {
        // SignatureError (bad/rotated key) and anything else both mean "do not
        // trust this request". Never rethrow into the route's error path.
        console.error("qstash: signature verification threw -", err.message);
        return false;
    }
}

// QStash schedules have no user-assignable name - a Schedule is identified by its
// destination URL, which we control, so matching on it is enough to keep `create`
// idempotent and stop a second schedule doubling the daily cost.
async function listSchedules() {
    return await getClient().schedules.list();
}

async function findSchedule() {
    const schedules = await listSchedules();
    const url = sweepUrl();
    return schedules.find((s) => s.destination === url) || null;
}

// Create the sweep schedule, or update it in place if it already exists. Safe to
// run repeatedly - the upsert is what stops a second schedule doubling the bill.
async function ensureSchedule({ cron = SWEEP_CRON, retries = SWEEP_RETRIES } = {}) {
    const destination = sweepUrl();
    const existing = await findSchedule();

    if (existing) {
        await getClient().schedules.update({
            scheduleId: existing.scheduleId,
            destination,
            cron,
            retries,
        });
        return { action: "updated", scheduleId: existing.scheduleId };
    }

    const created = await getClient().schedules.create({
        label: [SCHEDULE_NAME],
        destination,
        cron,
        retries,
    });
    return { action: "created", scheduleId: created.scheduleId };
}

async function deleteSchedule() {
    const existing = await findSchedule();
    if (!existing) return { action: "missing" };
    await getClient().schedules.delete({ scheduleId: existing.scheduleId });
    return { action: "deleted", scheduleId: existing.scheduleId };
}

// Worst case messages/day, used by the setup script to keep the cost visible
// rather than implicit. Returns null for any cron shape it cannot reason about
// (e.g. "0 9 * * *"), so an unrecognised schedule reports no estimate rather
// than a wrong one.
function dailyCost(cron = SWEEP_CRON, retries = SWEEP_RETRIES) {
    const fields = String(cron).trim().split(/\s+/);
    if (fields.length !== 5) return null;

    const min = fields[0];
    let perDay;
    if (min === "*") {
        perDay = 1440;
    } else {
        const step = /^\*\/(\d+)$/.exec(min);
        if (!step) return null;
        const n = Number(step[1]);
        if (!Number.isFinite(n) || n <= 0) return null;
        perDay = Math.floor(1440 / n);
    }
    return { perDay, worstCase: perDay * (1 + retries) };
}

module.exports = {
    SWEEP_CRON,
    SWEEP_RETRIES,
    SCHEDULE_NAME,
    isConfigured,
    missingConfig,
    verify,
    sweepUrl,
    baseUrl,
    listSchedules,
    findSchedule,
    ensureSchedule,
    deleteSchedule,
    dailyCost,
};