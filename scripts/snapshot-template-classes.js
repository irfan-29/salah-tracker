// Rebuilds scripts/template-classes.txt from the EJS templates at a given ref.
//
// The templates were deleted when the backend became API-only, but check-
// classnames.js still needs to know which names the old pages used: a class that
// appeared there is a legitimate structural hook even when no CSS rule targets
// it, and flagging those would train us to ignore the check.
//
//   node scripts/snapshot-template-classes.js c763c37
//
// Pass the last commit that still contains views/. Review the diff before
// committing - this file is an allowlist, so a too-narrow rebuild produces
// false positives on names the templates did use.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ref = process.argv[2];
if (!ref) {
  console.error("Usage: node scripts/snapshot-template-classes.js <git-ref>");
  process.exit(1);
}

let files;
try {
  files = execSync(`git ls-tree --name-only ${ref} views/`, { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
} catch {
  console.error(`No views/ directory at ${ref}`);
  process.exit(1);
}
if (!files.length) {
  console.error(`views/ is empty at ${ref}`);
  process.exit(1);
}

const names = new Set();
const add = (raw) => String(raw).split(/\s+/).forEach((c) => {
  c = c.trim();
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(c)) names.add(c);
});

for (const f of files) {
  const src = execSync(`git show ${ref}:${f}`, { encoding: "utf8", maxBuffer: 4e6 });
  // Static class attributes.
  for (const m of src.matchAll(/class="([^"]*)"/g)) add(m[1]);
  // Classes created at runtime. edition-pill only ever appears as
  // `pill.className = 'edition-pill'`, so a class="..." scan alone misses it.
  for (const m of src.matchAll(/className\s*=\s*[`'"]([^`'"']+)[`'"]/g)) add(m[1]);
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle|replace)\(\s*[`'"]([^`'"']+)[`'"]/g)) add(m[1]);
  // Classes referenced in selectors.
  for (const m of src.matchAll(/querySelector(?:All)?\(`?\.([A-Za-z_][A-Za-z0-9_-]*)/g)) add(m[1]);
}

const out = [...names].sort();
fs.writeFileSync(path.join(__dirname, "template-classes.txt"), out.join("\n") + "\n");
console.log(`${out.length} class names from ${files.length} templates at ${ref}`);
