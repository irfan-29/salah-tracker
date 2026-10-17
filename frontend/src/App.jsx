import { useEffect, useState } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { AudioProvider } from './components/AudioProvider';
import Navbar from './components/Navbar';
import Player from './components/Player';
import { SessionProvider } from './hooks/useSession';
import useShareHandler from './hooks/useShareHandler';
import QuranPage from './pages/QuranPage';
import ChallengesPage from './pages/ChallengesPage';
import SalahPage from './pages/SalahPage';
import SettingsPage from './pages/SettingsPage';
import SalahTimingsPage from './pages/SalahTimingsPage';
import CalendarPage from './pages/CalendarPage';
import { LoginPage, RegisterPage, VerifyPage } from './pages/AuthPage';
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

  if (AUTH_PATHS.includes(pathname)) {
    return (
      <Routes>
        <Route path="/login" element={<div className="auth-body"><LoginPage /></div>} />
        <Route path="/register" element={<div className="auth-body"><RegisterPage /></div>} />
        <Route path="/verify-email" element={<div className="auth-body"><VerifyPage /></div>} />
      </Routes>
    );
  }

  // Share buttons in post cards and profiles. Mounted once at the shell so it
  // covers every route; without it the buttons render but do nothing.
  useShareHandler();

  // null means "not known yet" - distinct from false. Pages that gate on it
  // wait rather than briefly showing the signed-out UI.
  const [session, setSession] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/session', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setSession(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const resolved = session || { isLoggedIn: null, username: null };

  return (
    <SessionProvider value={resolved}>
      <Navbar session={resolved} />
      <div className="main-content">
        <Routes>
          <Route path="/" element={<QuranPage />} />
          <Route path="/quran" element={<QuranPage />} />
          <Route path="/surah/:surahNo" element={<SurahPage />} />
          <Route path="/challenges" element={<ChallengesPage />} />
          <Route path="/salah" element={<SalahPage />} />
          <Route path="/posts" element={<PostsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/salah-timings" element={<SalahTimingsPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/post/:id" element={<PostPage />} />
          <Route path="/u/:username" element={<ProfilePage />} />
          {/* Every page is ported, so the fallback is now a genuine 404 rather
              than a "not migrated yet" notice. */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
      <Player />
    </SessionProvider>
  );
}
