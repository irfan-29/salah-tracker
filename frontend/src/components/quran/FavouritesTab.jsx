import { Link } from 'react-router-dom';

// This list intentionally uses the same ayah typography and bookmark treatment
// as the reader. It used to have its own smaller Arabic face, outlined heart
// and separately styled translation box, which made the two screens feel
// unrelated.
export default function FavouritesTab({ entries, isLoggedIn, onToggle, favoriteFont = 'QPC-Hafs' }) {
  if (!isLoggedIn) {
    return (
      <div className="quran-tab-panel" data-tab-panel="favourites">
        <div className="container1">
          <div className="gate-notice">
            <span className="material-symbols-rounded">lock</span>
            <div>
              <p className="gate-title">Sign in to save ayahs</p>
              <p className="gate-text">
                Bookmarks are tied to your account, so they follow you across devices.{' '}
                <a href="/login">Sign in</a> or <a href="/register">create an account</a> to start saving.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="quran-tab-panel" data-tab-panel="favourites">
      <div className="container1">
        <div className="card-header">
          <h3>Bookmarked Ayahs</h3>
          <span className="badge badge-primary">{entries.length}</span>
        </div>

        {entries.length === 0 ? (
          <p className="post-empty">No bookmarks yet. Tap the bookmark beside any ayah while reading.</p>
        ) : (
          entries.map((entry) => (
            <article className="favourite-card" key={`${entry.surahNo}:${entry.ayahNo}`}>
              <header className="favourite-head">
                <div className="favourite-heading">
                  <Link className="favourite-ref" to={`/surah/${entry.surahNo}?ayah=${entry.ayahNo}`}>
                    {entry.surahName}
                    {entry.surahNameArabic ? ` · ${entry.surahNameArabic}` : ''}
                  </Link>
                  <span className="favourite-num">Ayah {entry.ayahNo}</span>
                </div>
                {/* Same .fav-btn/is-active treatment as the reader, so the
                    bookmark is the same size and fills instead of staying
                    outlined. */}
                <button
                  type="button"
                  className="fav-btn bookmark-btn is-active"
                  onClick={() => onToggle(entry.surahNo, entry.ayahNo)}
                  title="Remove bookmark"
                  aria-label={`Remove ${entry.surahName} ayah ${entry.ayahNo} from bookmarks`}
                >
                  <span className="material-symbols-rounded">bookmark</span>
                </button>
              </header>

              {entry.unavailable ? (
                <p className="favourite-missing">This ayah could not be loaded just now.</p>
              ) : (
                <>
                  <p className="ayah-arabic-text" dir="rtl" lang="ar" style={{ fontFamily: `'${favoriteFont}', serif` }}>
                    {entry.arabicText}
                  </p>
                  {entry.translationText && (
                    <div className="ayah-translation">
                      <p className="ayah-translation-label">{entry.translationLabel || 'Translation'}</p>
                      <p className="ayah-translation-text">{entry.translationText}</p>
                    </div>
                  )}
                </>
              )}
            </article>
          ))
        )}
      </div>
    </div>
  );
}
