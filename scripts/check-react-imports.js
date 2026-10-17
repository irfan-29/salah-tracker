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


// ---- Hook order ------------------------------------------------------------
//
// A hook placed after an early `if (...) return` renders conditionally. React
// compares the hook list between renders, so the first render calls fewer hooks
// than the second and it throws:
//
//   Rendered more hooks than during the previous render
//
// That blanks the ENTIRE app, not just the component, and it happened here: an
// effect added below `if (!data) return <Loader/>` in SurahPage took the whole
// site down while the build stayed green and every other check passed.
//
// An earlier attempt at this walked the source counting braces by hand and
// missed the bug twice - JSX, arrow functions and multi-line returns all move
// the counters. This parses instead, so the structure is the real structure.
//
// @babel/parser ships with Vite's dependency tree; it is resolved from
// frontend/node_modules rather than added as a direct dependency, since this is
// a build-time guard and not shipped code.
const parser = require(require.resolve("@babel/parser", {
  paths: [path.join(__dirname, "..", "frontend")],
}));

const HOOK_PREFIX = /^use[A-Z]/;

function isHookName(name) {
  return HOOK_PREFIX.test(name) && name !== "use";
}

// Walks one function body, reporting hooks called after the first top-level
// return. Nested functions get their own walk, so a hook inside a callback is
// judged by that callback's rules, not the outer one's.
function checkFunctionBody(node, file, problems) {
  if (!node || !node.body || !Array.isArray(node.body.body)) return;

  // Collect, for THIS function only: every hook call, and every return.
  //
  // The rule is positional and needs no control-flow analysis: a hook is unsafe
  // when some return appears before it in source order, because there is then a
  // path that skips it while continuing to render. `if (!data) return <Loader/>`
  // followed by a hook is caught, and so is a bare `return`.
  //
  // Nested functions are skipped entirely - a return inside a callback says
  // nothing about whether the outer component's later hooks will run, and
  // hooks inside a callback are the callback's own business.
  let firstReturn = Infinity;

  const collect = (n, isRoot) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach((c) => collect(c, false)); return; }
    if (!n.type) return;

    // Stop at every nested function, including ones reached as array elements.
    // useState(() => { ... return x }) is the common case: that return belongs
    // to the initialiser, not to the component, and treating it as the
    // component's early return flagged every hook after it. The check has to
    // live here rather than in the key loop, or call arguments skip it.
    if (!isRoot && isFunctionNode(n)) return;

    if (n.type === "ReturnStatement") {
      firstReturn = Math.min(firstReturn, n.start);
      // A return's argument may contain an IIFE-ish hook call, but those are
      // evaluated as expressions, not conditionally. Keep walking anyway.
    }

    if (n.type === "CallExpression" && isHookName(n.callee.name || "")) {
      hooks.push({ start: n.start, line: n.loc.start.line, name: n.callee.name });
    }

    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      const child = n[key];
      if (child === null || typeof child !== "object") continue;
      collect(child, false);
    }
  };

  const hooks = [];
  collect(node.body, true);

  for (const h of hooks) {
    if (h.start > firstReturn) {
      problems.push({ file, line: h.line, hook: h.name });
    }
  }

  // Judge each nested function by its own rules.
  const walk = (n, isRoot) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach((c) => walk(c, false)); return; }
    if (!n.type) return;
    if (!isRoot && isFunctionNode(n)) { checkFunctionBody(n, file, problems); return; }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (isRoot && key === "body") continue;
      walk(n[key], false);
    }
  };
  walk(node.body, true);
}

function isFunctionNode(n) {
  if (!n || !n.type) return false;
  return n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" ||
         n.type === "FunctionDeclaration" || n.type === "ObjectMethod" ||
         n.type === "ClassMethod";
}

const orderProblems = [];

for (const file of walk(SRC)) {
  const source = fs.readFileSync(file, "utf8");
  const rel = path.relative(path.join(__dirname, ".."), file);

  let ast;
  try {
    ast = parser.parse(source, {
      sourceType: "module",
      plugins: ["jsx"],
      errorRecovery: true,
    });
  } catch (err) {
    console.error(`Could not parse ${rel}: ${err.message}`);
    process.exit(1);
  }

  const topLevel = ast.program.body;
  for (const node of topLevel) {
    if (node.type === "FunctionDeclaration") {
      checkFunctionBody(node, rel, orderProblems);
    } else if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
      const d = node.declaration;
      if (d && (d.type === "FunctionDeclaration" || d.type === "ArrowFunctionExpression" ||
                d.type === "FunctionExpression")) {
        checkFunctionBody(d, rel, orderProblems);
      }
    }
  }

  // Components are usually `export default function X() {}`, but a page can also
  // be `const X = () => {}`. Sweep every top-level arrow assigned to a name.
  for (const node of topLevel) {
    const d = node.type === "ExportDefaultDeclaration" ? node.declaration
            : node.type === "VariableDeclaration" ? node.declarations[0] && node.declarations[0].init
            : null;
    if (d && (d.type === "ArrowFunctionExpression" || d.type === "FunctionExpression")) {
      checkFunctionBody(d, rel, orderProblems);
    }
  }
}

if (orderProblems.length) {
  console.error("Hook(s) called after an early return - these blank the whole app:\n");
  for (const p of orderProblems) console.error(`  ${p.file}:${p.line}  ${p.hook}`);
  console.error("\nMove the hook above every early return in its function.");
  process.exit(1);
}
