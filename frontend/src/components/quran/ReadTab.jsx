import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

export default function ReadTab({ surahs, ayahOfTheDay, lastReadSurahs, favoriteFont }) {
  const [term, setTerm] = useState('');

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return surahs;
    return surahs.filter((s, i) =>
      s.surahName.toLowerCase().includes(q) || String(i + 1).includes(q));
  }, [surahs, term]);

  return (
    <>
      {ayahOfTheDay && (
        <section className="panel">
          <p className="panel-label">Ayah of the Day</p>
          <Link className="featured" to={`/surah/${ayahOfTheDay.surahNo}?ayah=${ayahOfTheDay.ayahNo}`}>
            <p className="featured-cite">Surah {ayahOfTheDay.surahNo} · Ayah {ayahOfTheDay.ayahNo}</p>
            <p className="featured-surah">{ayahOfTheDay.surahName} · {ayahOfTheDay.surahNameArabic}</p>
            {ayahOfTheDay.arabicText && (
              <p className="featured-arabic" style={{ fontFamily: `'${favoriteFont}', serif` }}>
                {ayahOfTheDay.arabicText}
              </p>
            )}
            {ayahOfTheDay.translationText && (
              <>
                {ayahOfTheDay.translationLabel && <p className="featured-edition">{ayahOfTheDay.translationLabel}</p>}
                <p className="featured-translation">{ayahOfTheDay.translationText}</p>
              </>
            )}
          </Link>
        </section>
      )}

      {lastReadSurahs && lastReadSurahs.length > 0 && (
        <section className="panel">
          <header className="panel-header"><h3>Continue Reading</h3></header>
          <div className="pill-row">
            {lastReadSurahs.map((no) => (
              <Link key={no} className="pill" to={`/surah/${no}`}>
                {no}. {surahs[no - 1]?.surahName}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <header className="panel-header">
          <h3>All Surahs</h3>
          <span className="badge">{surahs.length} Surahs</span>
        </header>
        <input
          className="search-input"
          type="search"
          placeholder="Search by number or name"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <div className="surah-grid">
          {filtered.map((surah) => {
            const no = surahs.indexOf(surah) + 1;
            return (
              <Link key={no} className="surah-card" to={`/surah/${no}`}>
                <span className="surah-card-number">{no}</span>
                <div className="surah-card-content">
                  <p className="surah-name">{surah.surahName}</p>
                  <p className="surah-arabic">{surah.surahNameArabic}</p>
                  <p className="surah-meta">{surah.revelationPlace} · {surah.totalAyah} Ayahs</p>
                </div>
                <span className="material-symbols-rounded">chevron_right</span>
              </Link>
            );
          })}
        </div>
        {filtered.length === 0 && <p className="empty-text">No surah matches “{term}”.</p>}
      </section>
    </>
  );
}
