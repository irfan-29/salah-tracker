export default function FavouritesTab({ entries, isLoggedIn, onToggle, onReload }) {
  if (!isLoggedIn) {
    return (
      <section className="panel">
        <p className="empty-text">
          Favourites are tied to your account.{' '}
          <a href="/login">Sign in</a> or <a href="/register">create an account</a> to start saving.
        </p>
      </section>
    );
  }

  if (!entries.length) {
    return (
      <section className="panel">
        <p className="empty-text">No saved ayahs yet. Tap the heart beside any ayah while reading.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h3>Saved Ayahs</h3>
        <span className="badge">{entries.length}</span>
      </header>
      {entries.map((entry) => (
        <article key={`${entry.surahNo}:${entry.ayahNo}`} className="favourite-card">
          <header className="favourite-head">
            <a className="favourite-ref" href={`/surah/${entry.surahNo}?ayah=${entry.ayahNo}`}>
              {entry.surahName}
              {entry.surahNameArabic ? ` · ${entry.surahNameArabic}` : ''}
            </a>
            <span className="favourite-num">Ayah {entry.ayahNo}</span>
            <button
              type="button"
              className="favourite-remove"
              onClick={() => onToggle(entry.surahNo, entry.ayahNo)}
              aria-label="Remove from favourites"
            >
              <span className="material-symbols-rounded">favorite</span>
            </button>
          </header>

          {entry.unavailable ? (
            <p className="empty-text">This ayah could not be loaded just now.</p>
          ) : (
            <>
              {entry.arabicText && <p className="favourite-arabic" dir="rtl" lang="ar">{entry.arabicText}</p>}
              {entry.translationText && (
                <>
                  {entry.translationLabel && <p className="favourite-edition">{entry.translationLabel}</p>}
                  <p className="favourite-translation">{entry.translationText}</p>
                </>
              )}
            </>
          )}
        </article>
      ))}
    </section>
  );
}
