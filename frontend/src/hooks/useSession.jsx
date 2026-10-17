import React, { createContext, useContext } from 'react';

// Single source of session truth for the app.
//
// Navbar, Challenges and Salah all need to know whether the visitor is signed in,
// and each fetching it separately meant three requests and three chances to
// disagree. The App already fetches it, so it is lifted here and shared.
const SessionContext = createContext(null);

export function SessionProvider({ value, children }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  // Used before the provider mounts (e.g. Suspense-free first paint), so fall
  // back to "unknown" rather than assuming signed out - that would flash the
  // sign-in gate at a signed-in user on every load.
  return ctx || { isLoggedIn: null, username: null };
}
