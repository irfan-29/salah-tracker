// Copies the app stylesheet into the React frontend.
//
// The frontend imports the SAME CSS the EJS views use, rather than a parallel
// copy. A first attempt gave the React shell its own ~500-line stylesheet with
// similar-looking class names, which made the two designs drift apart. One
// stylesheet, one set of class names.
//
// Run via `npm run frontend:sync-css`. Wired into frontend:build so a stale
// copy cannot reach a deploy.

const fs = require("fs");
const path = require("path");

const SOURCE = path.join(__dirname, "..", "public", "css", "styles.css");
const TARGET = path.join(__dirname, "..", "frontend", "src", "styles", "base.css");
const BANNER = `/* GENERATED - do not edit.
   Copied from public/css/styles.css by scripts/sync-frontend-css.js.
   Edit the original; this file is overwritten on every build. */\n\n`;

const source = fs.readFileSync(SOURCE, "utf8");

// Skip the write when nothing changed, so this does not dirty the working tree
// or bust Vite's cache on every build.
let existing = null;
try { existing = fs.readFileSync(TARGET, "utf8"); } catch (err) { /* first run */ }

if (existing === BANNER + source) {
    process.exit(0);
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, BANNER + source);
console.log(`synced ${source.length} bytes -> ${path.relative(process.cwd(), TARGET)}`);
