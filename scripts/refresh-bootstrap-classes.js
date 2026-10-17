// Regenerates bootstrap-classes.txt, the class list check-classnames.js diffs

const https = require("https");
// against. Run after bumping the Bootstrap version in frontend/index.html:
//
//   node scripts/refresh-bootstrap-classes.js
//
// The version and integrity hash live in two places - this only refreshes the
// list, so update index.html by hand too, or the checker will validate against
// classes the page no longer loads.
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "frontend", "index.html"), "utf8");
const m = html.match(/bootstrap@([\d.]+)\/dist\/css\/bootstrap\.min\.css/);
if (!m) {
  console.error("No Bootstrap <link> found in frontend/index.html.");
  process.exit(1);
}
const version = m[1];
const url = `https://cdn.jsdelivr.net/npm/bootstrap@${version}/dist/css/bootstrap.min.css`;

https.get(url, (res) => {
  if (res.statusCode !== 200) {
    console.error(`Fetch failed: ${res.statusCode} for ${url}`);
    process.exit(1);
  }
  let css = "";
  res.on("data", (d) => (css += d));
  res.on("end", () => {
    const classes = [...new Set(
      (css.replace(/\/\*[\s\S]*?\*\//g, "").match(/\.(-?[_A-Za-z][\w-]*)/g) || [])
        .map((s) => s.slice(1))
    )].sort();
    const out = path.join(__dirname, "bootstrap-classes.txt");
    fs.writeFileSync(out, classes.join("\n") + "\n");
    console.log(`Bootstrap ${version}: ${classes.length} classes -> bootstrap-classes.txt`);
  });
}).on("error", (e) => { console.error(e.message); process.exit(1); });
