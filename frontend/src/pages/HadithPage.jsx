import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hadiths } from '../services/api';
import { useHadithBookmarks } from '../hooks/useHadithBookmarks';
import Loader from '../components/Loader';

// The Hadith module's front door: a Collections tab with every book on one
// grid, plus a Bookmarks tab listing what was saved while reading. Class names
// reuse the Quran module's tabs and the surah grid so the screens never drift
// apart visually.
const TABS = [
  { id: 'collections', label: 'Collections', icon: 'library_books' },
  { id: 'bookmarks', label: 'Bookmarks', icon: 'bookmark' },
];

export default function HadithPage() {
  const [tab, setTab] = useState('collections');
  const [collections, setCollections] = useState(null);
  const [error, setError] = useState('');
  const { bookmarks, signedOut, toggleBookmark } = useHadithBookmarks();

  useEffect(() => {
    let cancelled = false;
    hadiths.collections()
      .then((data) => { if (!cancelled) setCollections(data.collections || []); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the collections.'); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <><div className="page-header"><h1>Hadith</h1></div><div className="container1"><p className="post-empty">{error}</p></div></>;
  if (!collections) return <Loader variant="page" label="Loading collections" />;

  return (
    <>
      <div className="page-header">
        <h1>Hadith</h1>
        <p>The sayings of the Prophet Muhammad ﷺ from the major collections</p>
      </div>

      <div className="quran-tabs" role="tablist" aria-label="Hadith sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`quran-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="material-symbols-rounded">{t.icon}</span>
            {t.label}
            {t.id === 'bookmarks' && bookmarks.length > 0 && (
              <span className="quran-tab-count">{bookmarks.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'collections' && (
        <div className="container1">
          <div className="card-header">
            <h3>Collections</h3>
            <span className="badge badge-primary">{collections.length} Books</span>
          </div>
          <div className="surah-grid">
            {collections.map((c, i) => (
              <Link key={c.id} to={`/hadith/${c.id}`} className="surah-card">
                <span className="surah-card-number">{i + 1}</span>
                <div className="surah-card-content">
                  <p className="surah-name">{c.name}</p>
                  <p className="surah-translation">{c.translator}</p>
                  <p className="surah-meta">{c.languages.map((l) => l.label).join(' · ')}</p>
                </div>
                <span className="material-symbols-rounded surah-card-arrow">chevron_right</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {tab === 'bookmarks' && (
        <div className="container1">
          {signedOut ? (
            <div className="gate-notice">
              <span className="material-symbols-rounded">lock</span>
              <div>
                <p className="gate-title">Sign in to save hadiths</p>
                <p className="gate-text">
                  Bookmarks are tied to your account, so they follow you across devices.{' '}
                  <a href="/login">Sign in</a> or <a href="/register">create an account</a> to start saving.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="card-header">
                <h3>Bookmarked Hadiths</h3>
                <span className="badge badge-primary">{bookmarks.length}</span>
              </div>

              {bookmarks.length === 0 ? (
                <p className="post-empty">No bookmarks yet. Tap the bookmark beside any hadith while reading.</p>
              ) : (
                bookmarks.map((entry) => (
                  <article className="favourite-card" key={`${entry.collection}:${entry.number}`}>
                    <header className="favourite-head">
                      <div className="favourite-heading">
                        <Link
                          className="favourite-ref"
                          to={`/hadith/${entry.collection}${entry.sectionId ? `?section=${entry.sectionId}` : ''}`}
                        >
                          {entry.collectionName}
                          {entry.sectionTitle ? ` · ${entry.sectionTitle}` : ''}
                        </Link>
                        <span className="favourite-num">Hadith № {entry.number}</span>
                      </div>
                      {/* Same .fav-btn/is-active treatment as the reader, so
                          the bookmark is the same size and fills when active. */}
                      <button
                        type="button"
                        className="fav-btn bookmark-btn is-active"
                        onClick={() => toggleBookmark(entry.collection, entry.number)}
                        title="Remove bookmark"
                        aria-label={`Remove hadith ${entry.number} of ${entry.collectionName} from bookmarks`}
                      >
                        <span className="material-symbols-rounded">bookmark</span>
                      </button>
                    </header>

                    {entry.arabic && (
                      <p className="ayah-arabic-text hadith-arabic-text" dir="rtl" lang="ar">{entry.arabic}</p>
                    )}
                    {entry.text && (
                      <div className="ayah-translation">
                        <p className="ayah-translation-text">{entry.text}</p>
                      </div>
                    )}
                  </article>
                ))
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
