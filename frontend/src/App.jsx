import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AudioProvider } from './components/AudioProvider';
import Navbar from './components/Navbar';
import Player from './components/Player';
import { SessionProvider } from './hooks/useSession';
import useShareHandler from './hooks/useShareHandler';
import QuranPage from './pages/QuranPage';
import ChallengesPage from './pages/ChallengesPage';
import SalahPage from './pages/SalahPage';
import SettingsPage from './pages/SettingsPage';
import { PostsPage, PostPage, ProfilePage } from './pages/PostsPage';
import SurahPage from './pages/SurahPage';
import NotMigrated from './pages/NotMigrated';

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

function Shell() {
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
          <Route path="/post/:id" element={<PostPage />} />
          <Route path="/u/:username" element={<ProfilePage />} />
          {/* Everything else is still server-rendered EJS. Those pages keep
              working through the Vercel rewrite to the backend; navigating here
              is a full page load by design until they are ported. */}
          <Route path="*" element={<NotMigrated />} />
        </Routes>
      </div>
      <Player />
    </SessionProvider>
  );
}
