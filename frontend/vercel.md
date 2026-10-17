# Frontend deploy notes

Sits beside `vercel.json`, which cannot hold the explanation itself: Vercel
validates that file against a strict schema and rejects any unrecognised
property. A `"//"` comment key failed the deploy with
`should NOT have additional property '/'`. Keep notes here instead.

## Why these two rewrites, in this order

Every page is a React route, so the backend only needs to serve `/api`.

1. `/api/:path*` → `https://salah-tracker-api.vercel.app/api/:path*`
2. `/:path*` → `/index.html`

**Order is load-bearing.** Vercel applies rewrites top-down and the *first*
match wins. If the SPA catch-all came first, every API call would be answered
with `index.html` and the client would fail parsing JSON — which looks
identical to a backend that is down, and sends you debugging the wrong project.

## Why proxy instead of calling the backend directly

The reference app (`nafahperfumes`) calls its backend cross-origin with
`withCredentials: false` and Bearer tokens. That only works because it has no
cookies.

This app has two: the passport `connect.sid` session cookie and the signed
`salah_guest` cookie that backs guest favourites. Cross-origin delivery would
force `SameSite=None`, which requires `Secure` and breaks the guest store on
HTTP. Same-origin through the rewrite keeps both cookies first-party with no
CORS at all.

The rewrite proxies **response** headers as well as requests, which is what
makes the `Set-Cookie` on login and signup survive the hop.

## Build command

`node ../scripts/sync-frontend-css.js && vite build`

The script path reaches outside the Root Directory into the repo. That is fine
— Vercel clones the whole repository, it only sets the build's working
directory. The sync is in the frontend's own build script rather than the repo
root's so it still runs when Vercel builds this project alone.

Without it `src/styles/base.css` would silently ship stale relative to
`public/css/styles.css`.