// Manage the QStash sweep schedule.
//
//   node scripts/qstash-schedule.js status
//   node scripts/qstash-schedule.js create
//   node scripts/qstash-schedule.js delete
//
// This is a CLI rather than an admin route on purpose. An HTTP endpoint that can
// create or delete schedules is an abuse target: every create is a billed
// message from the moment its first tick lands, and the free tier only allows 10
// active schedules. Keeping it here means it needs shell access to the deploy.
//
// `create` is an upsert. Running it twice updates the existing schedule instead
// of adding a second one, which is the difference between 144 messages/day and
// 288.

require("dotenv").config();

const qstash = require("../api/utils/qstash.js");

function checkConfig() {
    const missing = qstash.missingConfig();

    if (missing.length) {
        console.error("Missing environment variables:\n" + missing.map((m) => "  " + m).join("\n"));
        console.error("\nCopy the .env block from https://console.upstash.com/qstash into .env");
        console.error("QSTASH_URL must match your region - the token only works against it.");
        process.exit(1);
    }
}

function printCost() {
    const cost = qstash.dailyCost();
    if (!cost) {
        console.log(`cron "${qstash.SWEEP_CRON}" - not a simple */N form, cost not estimated.`);
        return;
    }
    console.log(`cron            ${qstash.SWEEP_CRON}  (${cost.perDay} ticks/day)`);
    console.log(`retries         ${qstash.SWEEP_RETRIES}  (pinned, not the account default)`);
    console.log(`messages/day    ${cost.perDay} typical, ${cost.worstCase} if every delivery fails`);
    console.log(`free tier       1000/day -> ${(cost.worstCase / 10).toFixed(0)}% at worst case`);
    if (cost.worstCase > 1000) {
        console.error("\n!! Worst case exceeds the free tier - this could be billed.");
        console.error("   Lengthen the interval (e.g. */15) or lower retries.");
    }
}

async function main() {
    const command = (process.argv[2] || "status").toLowerCase();

    if (!["status", "create", "delete"].includes(command)) {
        console.error(`Unknown command "${command}". Use: status | create | delete`);
        process.exit(1);
    }

    // Validate QSTASH_APP_URL before spending an API call on it.
    //
    // The failure this guards against is real and already happened once: two
    // assignments collided onto one .env line, so dotenv kept the raw text
    // (it only strips quotes when the value both opens AND closes with one).
    // QStash answered with an opaque "endpoint has invalid scheme" 400 that
    // pointed at the scheme, when the actual problem was a stray GMAIL_USER=
    // glued to the end of a URL. Checking here names the real cause.
    const raw = process.env.QSTASH_APP_URL;
    if (raw !== undefined && raw !== "") {
        // Quote/whitespace first. new URL() is far too permissive here: it
        // happily parses https://host"GLUE=a@b.com as a valid https URL with a
        // quote in the query, so validating parseability alone would have
        // passed exactly the value that broke this.
        if (/["'\s]/.test(raw)) {
            console.error("QSTASH_APP_URL contains a quote or whitespace.");
            console.error(`  reads as: ${JSON.stringify(raw)}`);
            console.error("  two assignments were merged onto one .env line, e.g.");
            console.error('    QSTASH_APP_URL="https://host"GMAIL_USER=a@b.com');
            console.error("  put each on its own line.");
            process.exit(1);
        }
        let parsed = null;
        try { parsed = new URL(raw); } catch { /* reported below */ }
        if (!parsed || !/^https?:$/.test(parsed.protocol)) {
            console.error("QSTASH_APP_URL is not a valid http(s) URL.");
            console.error(`  reads as: ${JSON.stringify(raw)}`);
            process.exit(1);
        }
    }

    if (command === "delete") {
        // Schedules are matched on destination URL, so delete needs the same
        // config as create - but not the signing keys, which are only used for
        // verification and can legitimately be rotated away.
        if (!process.env.QSTASH_TOKEN || !process.env.QSTASH_APP_URL) {
            console.error("QSTASH_TOKEN and QSTASH_APP_URL are required to identify the schedule.");
            process.exit(1);
        }
        const result = await qstash.deleteSchedule();
        console.log(result.action === "missing"
            ? `No schedule targeting ${process.env.QSTASH_APP_URL || "(QSTASH_APP_URL unset)"} - nothing to delete.`
            : `Deleted schedule ${result.scheduleId}. No further messages will be billed.`);
        return;
    }

    checkConfig();
    console.log(`target          ${qstash.sweepUrl()}\n`);
    printCost();
    console.log("");

    if (command === "status") {
        const schedules = await qstash.listSchedules();
        const mine = schedules.filter((s) => s.destination === qstash.sweepUrl());
        if (!mine.length) {
            console.log(`No schedule targeting ${qstash.sweepUrl()}.`);
            console.log("Run: npm run qstash:schedule -- create");
        } else {
            for (const s of mine) {
                console.log(`schedule        ${s.scheduleId}`);
                console.log(`  cron          ${s.cron}`);
                console.log(`  retries       ${s.retries}`);
                console.log(`  destination   ${s.destination}`);
                console.log(`  paused        ${Boolean(s.isPaused)}`);
            }
        }
        console.log(`\nschedules in use ${schedules.length}/10 (free tier limit)`);
        return;
    }

    const result = await qstash.ensureSchedule();
    console.log(`${result.action} schedule ${result.scheduleId} -> ${qstash.sweepUrl()}`);
    console.log("\nDone. Verify with: npm run qstash:schedule -- status");
}

main().catch((err) => {
    console.error(`${err.name || "Error"}: ${err.message}`);
    process.exit(1);
});