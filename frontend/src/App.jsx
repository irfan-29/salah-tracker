import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AudioProvider } from './components/AudioProvider';
import Navbar from './components/Navbar';
import Player from './components/Player';
import { SessionProvider } from './hooks/useSession';
import QuranPage from './pages/QuranPage';
import ChallengesPage from './pages/ChallengesPage';
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
