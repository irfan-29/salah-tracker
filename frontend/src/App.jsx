import { useCallback, useEffect, useMemo, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AudioProvider } from './components/AudioProvider';
import Loader from './components/Loader';
import Navbar from './components/Navbar';
import Player from './components/Player';
import TabBar from './components/TabBar';
import { SessionProvider, THEME_STORAGE_KEY } from './hooks/useSession';
import useShareHandler from './hooks/useShareHandler';
import { api } from './services/api';
import * as typography from './services/typography';
import QuranPage from './pages/QuranPage';
import HadithPage from './pages/HadithPage';
import HadithBookPage from './pages/HadithBookPage';
import ChallengesPage from './pages/ChallengesPage';
import CharityPage from './pages/CharityPage';
import StatsPage from './pages/StatsPage';
import SalahPage from './pages/SalahPage';
import SettingsPage from './pages/SettingsPage';
import SalahTimingsPage from './pages/SalahTimingsPage';
import QiblaPage from './pages/QiblaPage';
import CalendarPage from './pages/CalendarPage';
import { LoginPage, RegisterPage, VerifyPage } from './pages/AuthPage';
import LandingPage from './pages/LandingPage';
import AccountPage from './pages/AccountPage';
import { PostsPage, PostPage, ProfilePage } from './pages/PostsPage';
import SurahPage from './pages/SurahPage';
import NotFound from './pages/NotFound';

// AudioProvider sits ABOVE <Routes> deliberately. It owns the single <audio>
// element for the lifetime of the app, so navigating between pages cannot tear
// it down. Moving it inside a route would reintroduce the exact bug this
// rewrite exists to fix.
export default function App() {
  return (
    <AudioProvider>
      <Shell />
    </AudioProvider>
  );
}

// Auth routes are standalone cards, not part of the app shell - exactly as the
// EJS pages were. Routing them through <Routes> inside the shell meant the
// sidebar and the .main-content offset rendered around the sign-in card.
const AUTH_PATHS = ['/login', '/register', '/verify-email'];

function Shell() {
  const { pathname } = useLocation();

  // The app bar is fixed on narrow screens. Without this, navigating from a
  // scrolled page can leave the next page's title underneath it. Reset before
  // the route paints; SurahPage still scrolls to a requested ayah afterwards.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  // EVERY hook runs on every render, including auth routes. The branch below is
  // only a choice of JSX.
  //
  // This used to `return` the auth routes before useShareHandler, useState and
  // useEffect. React compares a component's hook list between renders, so moving
  // between an auth route and any other route changed the hook count and threw
  // "Rendered more hooks than during the previous render" - which unmounts the
  // ENTIRE app and leaves a blank page. AuthPage.done() calls navigate() before
  // its reload, so signing in could trip it.
  //
  // scripts/check-react-imports.js now fails the build on this pattern.

  // Share buttons in post cards and profiles. Mounted once at the shell so it
  // covers every route; without it the buttons render but do nothing.
  useShareHandler();

  // Boot metadata: who is signed in, which theme to paint, and where "/" goes.
  // null means "not known yet" - distinct from a signed-out payload. The shell
  // waits for it rather than painting a guess, because a wrong guess here is
  // visible: the signed-out navbar flashes, then the theme flips.
  const [meta, setMeta] = useState(null);
  const [booted, setBooted] = useState(false);

  // Re-read the same payload in place after something it carries changes, so a
  // settings save does not need a full page reload. Returns the fresh payload so
  // callers can act on it, or null if it could not be read.
  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/app/meta');
      setMeta(data);
      return data;
    } catch (err) {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.get('/app/meta')
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
        setBooted(true);
      })
      .catch(() => {
        // A failed boot request must still show the app. The guest defaults are
        // what a signed-out visitor gets anyway, and every page re-checks its
        // own data.
        if (!cancelled) setBooted(true);
      });
    return () => { cancelled = true; };
  }, []);

  // Apply a theme and remember it for the next first paint. The inline script in
  // index.html reads the same key before any bundle downloads, so a dark-mode
  // reader does not get a white flash while React boots.
  const setTheme = useCallback((value) => {
    const next = value === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (err) {
      // Storage disabled or private mode: the theme still applies to this page.
    }
    setMeta((current) => {
      // Same value: keep the object identity, or the effect below would loop.
      if (!current || current.theme === next) return current;
      return { ...current, theme: next };
    });
  }, []);

  const metaTheme = meta ? meta.theme : null;
  useEffect(() => {
    if (metaTheme) setTheme(metaTheme);
  }, [metaTheme, setTheme]);

  // Apply the three reader-typography settings and mirror them into storage
  // for the pre-paint script, the same contract setTheme has. The applier
  // lives in services/typography.js so the Settings page can reuse it for
  // drag previews without persisting.
  const applyTypography = useCallback((t) => {
    typography.applyTypography(t, { persist: true });
  }, []);

  // Keyed on the three values rather than the meta object, so an unrelated
  // meta refresh does not re-write storage for nothing.
  const metaFont = meta ? meta.appFont : null;
  const metaAppSize = meta ? meta.appFontSize : null;
  const metaQuranSize = meta ? meta.quranFontSize : null;
  useEffect(() => {
    if (metaFont === null) return;
    applyTypography({ appFont: metaFont, appFontSize: metaAppSize, quranFontSize: metaQuranSize });
  }, [metaFont, metaAppSize, metaQuranSize, applyTypography]);

  const resolved = useMemo(() => ({
    isLoggedIn: meta && meta.session ? meta.session.isLoggedIn : null,
    username: meta && meta.session ? meta.session.username : null,
    // Where a signed-in reader lands from "/", and where the landing page's
    // guest CTA enters the app. Null only if the boot request failed.
    homePath: meta ? meta.homePath : null,
    theme: meta ? meta.theme : null,
    setTheme,
    refresh,
  }), [meta, setTheme, refresh]);

  // Auth routes render their own standalone cards and do not need the shell's
  // metadata (or its navbar). They do still get the theme, because setTheme
  // above writes straight to <html>.
  if (AUTH_PATHS.includes(pathname)) {
    return (
      <Routes>
        <Route path="/login" element={<div className="auth-body"><LoginPage /></div>} />
        <Route path="/register" element={<div className="auth-body"><RegisterPage /></div>} />
        <Route path="/verify-email" element={<div className="auth-body"><VerifyPage /></div>} />
      </Routes>
    );
  }

  // Hold the shell back until the first meta response (or its failure) so the
  // navbar never paints a signed-out flash and the page never paints the wrong
  // theme. The boot loader was removed after the first React paint, so this is
  // the same branded loader continuing, not a second one appearing.
  if (!booted) return <Loader variant="fullPage" label="Loading" />;

  // "/" is the public landing page. Signed-in readers have already chosen this
  // app, so they skip the marketing and continue to their configured home; a
  // first-time visitor gets the story and the two ways in (account or guest).
  // This is deliberately before the shell: the sidebar has nothing to do on a
  // marketing page.
  if (pathname === '/') {
    if (resolved.isLoggedIn) {
      const target = resolved.homePath && resolved.homePath !== '/' ? resolved.homePath : '/quran';
      return <Navigate to={target} replace />;
    }
    return (
      <SessionProvider value={resolved}>
        <LandingPage />
      </SessionProvider>
    );
  }

  return (
    <SessionProvider value={resolved}>
      <Navbar session={resolved} />
      <div className="main-content">
        <Routes>
          <Route path="/quran" element={<QuranPage />} />
          <Route path="/hadith" element={<HadithPage />} />
          <Route path="/hadith/:collection" element={<HadithBookPage />} />
          <Route path="/surah/:surahNo" element={<SurahPage />} />
          <Route path="/challenges" element={<ChallengesPage />} />
          <Route path="/charity" element={<CharityPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/salah" element={<SalahPage />} />
          <Route path="/posts" element={<PostsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/salah-timings" element={<SalahTimingsPage />} />
          <Route path="/qibla" element={<QiblaPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/post/:id" element={<PostPage />} />
          <Route path="/u/:username" element={<ProfilePage />} />
          {/* Every page is ported, so the fallback is now a genuine 404 rather
              than a "not migrated yet" notice. */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
      <Player />
      {/* The phone footer: fixed five-slot navigation. Lives beside the player
          so the dock can stack on top of it, exactly like a native app. */}
      <TabBar />
    </SessionProvider>
  );
}
