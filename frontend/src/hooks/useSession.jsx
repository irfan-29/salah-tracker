import React, { createContext, useContext } from 'react';

// Single source of session truth for the app, and now also for the two settings
// that must be known before the first meaningful paint: the theme and the
// default home route.
//
// Those used to arrive only when SettingsPage loaded, so a fresh tab painted in
// the wrong theme and "/" ignored the Default Home Page setting entirely. They
// now come from /api/app/meta (see App.jsx), which is fetched once at boot.
//
// Navbar, Challenges and Salah all need to know whether the visitor is signed
// in, and each fetching it separately meant three requests and three chances to
// disagree. The App already fetches it, so it is lifted here and shared.

// Key used by the pre-paint inline script in index.html. It is duplicated rather
// than imported because that script has to run before any bundle is downloaded.
// Changing it in one place requires changing it in the other.
export const THEME_STORAGE_KEY = 'salah-theme';

const SessionContext = createContext(null);

const FALLBACK = {
  isLoggedIn: null,
  username: null,
  homePath: null,
  // No-ops so a component used outside the provider (or on an auth route, which
  // renders before the provider) cannot crash by calling these.
  setTheme: () => {},
  refresh: () => Promise.resolve(null),
};

export function SessionProvider({ value, children }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  // Used before the provider mounts (e.g. Suspense-free first paint), so fall
  // back to "unknown" rather than assuming signed out - that would flash the
  // sign-in gate at a signed-in user on every load.
  return ctx || FALLBACK;
}
