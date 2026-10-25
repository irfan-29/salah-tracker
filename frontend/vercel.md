# Frontend deploy notes

Sits beside `vercel.json`, which cannot hold the explanation itself: Vercel
validates that file against a strict schema and rejects any unrecognised
property. A `"//"` comment key failed the deploy with
`should NOT have additional property '/'`. Keep notes here instead.

## Why these two rewrites, in this order

Every page is a React route, so the backend only needs to serve `/api`.

1. `/api/:path*` → `https://hasanath-api.vercel.app/api/:path*`
2. `/:path*` → `/index.html`

**Order is load-bearing.** Vercel applies rewrites top-down and the *first*
match wins. If the SPA catch-all came first, every API call would be answered
with `index.html` and the client would fail parsing JSON — which looks
identical to a backend that is down, and sends you debugging the wrong project.

## The destination must be the API host that answers directly

The API rewrite has to point at the canonical API deployment, not at an old
domain that redirects to it. If the destination returns a 307/308, Vercel
relays that redirect to the browser. The browser then makes a second request
to the redirected API host from the frontend origin, which is now cross-origin:
without CORS the request fails, and the session/guest cookies are no longer
first-party. The frontend looks alive while every data fetch fails with
`net::ERR_FAILED`.

Keep `https://hasanath-api.vercel.app/api/:path*` here even if the old API
domain redirects to the same place. The redirect is only for old clients; the
live frontend must reach the new API directly through this same-origin proxy.

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
