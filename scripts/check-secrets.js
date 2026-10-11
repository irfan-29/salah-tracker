// Fails if a credential is committed. Cheap insurance: the reason MONGO_URI is
// no longer hard-coded is that a real Atlas password sat in api/app.js from the
// first commit until 2026, in a public repository.
//
//   npm run check:secrets
//
// Scans tracked files for the shapes real credentials take. It is a guardrail,
// not a substitute for rotating anything already exposed - a secret that has
// been public is compromised, full stop.

const { execSync } = require("child_process");

// The allow-lists must match only "this is a read from the environment" or
// "this is a documented placeholder". An earlier version included a quote
// character, which silently neutered the QStash rule on quoted assignments -
// the most common shape a hard-coded secret takes.
const PLACEHOLDER = /process\.env|<[a-z_]*>|your[_-]|changeme|placeholder|example|\bxxx\b|INSERT|YOUR_/i;

const RULES = [
    {
        name: "MongoDB connection string",
        pattern: /mongodb(\+srv)?:\/\/[^:\s/@"]+:[^@\s/"]+@/,
        allow: PLACEHOLDER,
    },
    {
        name: "Telegram bot token",
        // No trailing \b: real tokens are exactly 35 chars, but anchoring to
        // that length made the rule miss anything adjacent to the token.
        pattern: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/,
        // Deliberately does NOT allow-list /token/i - base64 in a real token can
        // contain that substring, and blanket-allowing it would hide live tokens.
        allow: /<|example|YOUR_|\bxxx\b|process\.env/i,
    },
    {
        name: "Upstash QStash token",
        pattern: /\bQSTASH_TOKEN\s*=\s*\S{8,}/,
        allow: PLACEHOLDER,
    },
    {
        name: "Generic assigned secret",
        pattern: /\b(password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i,
        allow: PLACEHOLDER,
    },
];

function trackedFiles() {
    return execSync("git ls-files", { encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
        // Binary-ish and vendored paths: scanning them is slow and noisy.
        .filter((f) => !/\.(png|jpe?g|gif|svg|ico|woff2?|mp3|mp4|pdf|lock)$/i.test(f))
        .filter((f) => !f.startsWith("node_modules/"));
}

const findings = [];

for (const file of trackedFiles()) {
    let text;
    try {
        text = require("fs").readFileSync(file, "utf8");
    } catch {
        continue;
    }

    for (const rule of RULES) {
        const lines = text.split("\n");
        lines.forEach((line, i) => {
            if (!rule.pattern.test(line)) return;
            if (rule.allow.test(line)) return;
            findings.push({ file, line: i + 1, rule: rule.name });
        });
    }
}

if (findings.length) {
    console.error("Possible committed credentials:\n");
    for (const f of findings) {
        console.error(`  ${f.file}:${f.line}  ${f.rule}`);
    }
    console.error("\nMove these into .env / the deployment's environment variables.");
    console.error("If one was ever pushed to a public remote, rotate it - removing it");
    console.error("from the working tree does not remove it from git history.");
    process.exit(1);
}

console.log(`No committed credentials found in ${trackedFiles().length} tracked files.`);