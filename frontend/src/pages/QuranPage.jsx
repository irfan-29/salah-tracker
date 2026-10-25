import { useEffect, useMemo, useState } from 'react';
import { quran } from '../services/api';
import { useAudio } from '../components/AudioProvider';
import { useFavourites } from '../hooks/useFavourites';
import Loader from '../components/Loader';
import ReadTab from '../components/quran/ReadTab';
import AudioTab from '../components/quran/AudioTab';
import FavouritesTab from '../components/quran/FavouritesTab';

const TABS = [
  { id: 'read', label: 'Read', icon: 'menu_book' },
  { id: 'audio', label: 'Audio', icon: 'headphones' },
  { id: 'favourites', label: 'Favourites', icon: 'favorite' },
];

export default function QuranPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(() => {
    const hash = (window.location.hash || '').replace('#', '');
    return TABS.some((t) => t.id === hash) ? hash : 'read';
  });
  const [reciter, setReciter] = useState('1');
  const { favourites, toggleFavourite, isFavourite, reload } = useFavourites();
  const audio = useAudio();

  useEffect(() => {
    let cancelled = false;
    quran.index()
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setReciter(payload.activeReciter || '1');
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the Quran index.'); });
    return () => { cancelled = true; };
  }, []);

  const counts = useMemo(() => ({ favourites: favourites.length }), [favourites]);

  if (error) {
    return (
      <>
        <div className="page-header"><h1>Quran</h1></div>
        <div className="container1"><p className="post-empty">{error}</p></div>
      </>
    );
  }

  if (!data) {
    return <Loader variant="page" label="Loading Quran" />;
  }

  async function handleReciterChange(next) {
    setReciter(next);
    try {
      await quran.saveReciter(next);
    } catch (err) {
      // Non-fatal: the selection still applies to this session, it just will
      // not be remembered next time.
    }
  }

  async function handlePlaySurah(surahNo) {
    try {
      const track = await quran.audio(surahNo, reciter);
      audio.play({
        url: track.url,
        surahNo: track.surahNo,
        surahName: track.surahName,
        reciterName: track.reciter,
        // Carried so the player's skip buttons keep the same reciter instead of
        // falling back to the server's saved preference.
        reciterId: track.reciterId,
        startAt: 0,
      });
    } catch (err) {
      // Nothing to show the user here beyond the bar simply not appearing.
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Quran</h1>
        <p>Read, listen, and reflect on the Holy Quran</p>
      </div>

      <div className="quran-tabs" role="tablist" aria-label="Quran sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`quran-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => {
              setTab(t.id);
              // replaceState rather than assigning location.hash, which would
              // make the browser try to scroll to a matching id.
              window.history.replaceState(null, '', `#${t.id}`);
            }}
          >
            <span className="material-symbols-rounded">{t.icon}</span>
            {t.label}
            {t.id === 'favourites' && counts.favourites > 0 && (
              <span className="quran-tab-count">{counts.favourites}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'read' && (
        <ReadTab
          surahs={data.surahs}
          ayahOfTheDay={data.ayahOfTheDay}
          lastReadSurahs={data.lastReadSurahs}
          favoriteFont={data.favoriteFont}
        />
      )}

      {tab === 'audio' && (
        <AudioTab
          surahs={data.surahs}
          reciters={data.reciters}
          reciter={reciter}
          onReciterChange={handleReciterChange}
          onPlaySurah={handlePlaySurah}
        />
      )}

      {tab === 'favourites' && (
        <FavouritesTab
          entries={favourites}
          isLoggedIn={data.isLoggedIn}
          onToggle={toggleFavourite}
          onReload={reload}
          favoriteFont={data.favoriteFont}
        />
      )}
    </>
  );
}