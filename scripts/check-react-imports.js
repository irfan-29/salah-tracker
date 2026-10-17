// Fails the build when a component uses a React hook it did not import.
//
// This exists because of a shipped bug. Navbar.jsx called useCallback but the
// import edit missed, so `useCallback` resolved as an unbound global. Vite and
// Rollup both treat that as legal - it is a runtime ReferenceError, not a
// module resolution error - so the build passed, tests passed, and the page
// deployed to a blank white screen with `rootChildren: 0`.
//
// The failure is invisible to every check that already exists. A lint rule
// (react-hooks) would catch it, but that needs a flat ESLint config for the
// whole frontend, which is a larger change than the bug warrants. This covers
// the narrow case that has actually bitten: a hook used but not imported.
//
// Wired into frontend:build so Vercel refuses the deploy rather than publishing
// a blank page. Extend this to other unbound-identifier classes if they recur.

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "frontend", "src");

// Hooks that come from react, and hooks that come from react-router-dom.
const REACT_HOOKS = [
  "useCallback", "useMemo", "useRef", "useEffect", "useState",
  "useReducer", "useLayoutEffect", "useDeferredValue", "useTransition",
  "useImperativeHandle", "useId", "useSyncExternalStore", "useContext",
];
const ROUTER_HOOKS = ["useNavigate", "useLocation", "useParams", "useSearchParams"];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Imported names from a given module, across default+named, bare named, and
// multi-line forms. Matching on the whole statement first and then pulling the
// braces out is what makes `import React, { useContext } from 'react'` work -
// anchoring the brace group directly after `import` silently missed it.
//
// The statement body is a TEMPERED dot: it may span newlines (multi-line
// imports have no semicolon until the end) but must not cross the next
// `import`. A plain [\s\S]*? reached from one statement's `import` all the way
// to a later `from`, so it captured the wrong brace group and reported every
// router hook as missing.
function importedFrom(source, moduleName) {
  const names = new Set();
  const stmt = new RegExp(
    `import\\s+((?:(?!\\bimport\\b)[\\s\\S])*?)\\s+from\\s*['"\`]${moduleName}['"\`]`,
    "g"
  );
  let m;
  while ((m = stmt.exec(source))) {
    const braces = m[1].match(/\{([^}]*)\}/);
    if (!braces) continue; // default-only or namespace import
    braces[1].split(",").forEach((n) => {
      const name = n.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    });
  }
  return names;
}

const problems = [];

for (const file of walk(SRC)) {
  const source = fs.readFileSync(file, "utf8");
  const rel = path.relative(path.join(__dirname, ".."), file);
  const reactNames = importedFrom(source, "react");
  const routerNames = importedFrom(source, "react-router-dom");

  const checks = [
    ...REACT_HOOKS.map((h) => [h, reactNames]),
    ...ROUTER_HOOKS.map((h) => [h, routerNames]),
  ];

  for (const [hook, imported] of checks) {
    if (imported.has(hook)) continue;
    // Word-boundary match, so useState does not match inside useStateXyz and
    // the definition inside a local helper does not count as an import.
    const uses = new RegExp(`(^|[^\\w$.])${hook}\\s*\\(`, "m").test(source);
    if (uses) problems.push({ rel, hook });
  }
}

if (problems.length) {
  console.error("Unimported React hook(s) - these build but throw at runtime:\n");
  for (const { rel, hook } of problems) {
    console.error(`  ${rel}: ${hook}`);
  }
  console.error(
    "\nFix: add it to the import from 'react' (or 'react-router-dom')."
  );
  process.exit(1);
}

console.log("React hook imports OK.");