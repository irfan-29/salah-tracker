// Class names mirror views/quran-favourites.ejs.
export default function FavouritesTab({ entries, isLoggedIn, onToggle }) {
  if (!isLoggedIn) {
    return (
      <div className="quran-tab-panel" data-tab-panel="favourites">
        <div className="container1">
          <div className="gate-notice">
            <span className="material-symbols-rounded">lock</span>
            <div>
              <p className="gate-title">Sign in to save ayahs</p>
              <p className="gate-text">
                Favourites are tied to your account, so they follow you across devices.{' '}
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
          <h3>Saved Ayahs</h3>
          <span className="badge badge-primary">{entries.length}</span>
        </div>

        {entries.length === 0 ? (
          <p className="post-empty">No saved ayahs yet. Tap the heart beside any ayah while reading.</p>
        ) : (
          entries.map((entry) => (
            <article className="favourite-card" key={`${entry.surahNo}:${entry.ayahNo}`}>
              <header className="favourite-head">
                <a className="favourite-ref" href={`/surah/${entry.surahNo}?ayah=${entry.ayahNo}`}>
                  {entry.surahName}
                  {entry.surahNameArabic ? ` · ${entry.surahNameArabic}` : ''}
                </a>
                <span className="favourite-num">Ayah {entry.ayahNo}</span>
                {/* A filled heart in the same red the reader uses
                    (.favourite-remove is already #e11d48). This rendered
                    `heart_broken`, which reads as broken rather than full. */}
                <button
                  type="button"
                  className="favourite-remove is-active"
                  onClick={() => onToggle(entry.surahNo, entry.ayahNo)}
                  title="Remove from favourites"
                  aria-label={`Remove ${entry.surahName} ayah ${entry.ayahNo} from favourites`}
                >
                  <span className="material-symbols-rounded">favorite</span>
                </button>
              </header>

              {entry.unavailable ? (
                <p className="favourite-missing">This ayah could not be loaded just now.</p>
              ) : (
                <>
                  <p className="favourite-arabic" dir="rtl" lang="ar">{entry.arabicText}</p>
                  {entry.translationText && (
                    <>
                      {entry.translationLabel && <p className="favourite-edition">{entry.translationLabel}</p>}
                      <p className="favourite-translation">{entry.translationText}</p>
                    </>
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
