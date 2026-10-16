import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

// Class names mirror views/quran-read.ejs exactly.
export default function ReadTab({ surahs, ayahOfTheDay, lastReadSurahs, favoriteFont }) {
  const [term, setTerm] = useState('');

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return surahs;
    return surahs.filter((s, i) => s.surahName.toLowerCase().includes(q) || String(i + 1).includes(q));
  }, [surahs, term]);

  return (
    <div className="quran-tab-panel" data-tab-panel="read">
      {ayahOfTheDay && (
        <div className="container1">
          <div className="featured-label">Ayah of the Day</div>
          <Link to={`/surah/${ayahOfTheDay.surahNo}?ayah=${ayahOfTheDay.ayahNo}`}>
            <div className="featured-surah">
              <div className="featured-ayah-ref">
                <p className="featured-ayah-cite">Surah {ayahOfTheDay.surahNo} · Ayah {ayahOfTheDay.ayahNo}</p>
                <p className="featured-ayah-surah">
                  {ayahOfTheDay.surahName}
                  {ayahOfTheDay.surahNameArabic ? ` · ${ayahOfTheDay.surahNameArabic}` : ''}
                </p>
              </div>
              {ayahOfTheDay.arabicText && (
                <p className="featured-ayah-arabic" style={{ fontFamily: `'${favoriteFont}', serif` }}>
                  {ayahOfTheDay.arabicText}
                </p>
              )}
              {ayahOfTheDay.translationText && (
                <>
                  {ayahOfTheDay.translationLabel && (
                    <p className="featured-ayah-edition">{ayahOfTheDay.translationLabel}</p>
                  )}
                  <p className="featured-ayah-translation">{ayahOfTheDay.translationText}</p>
                </>
              )}
            </div>
          </Link>
        </div>
      )}

      {lastReadSurahs && lastReadSurahs.length > 0 && (
        <div className="container1">
          <div className="card-header"><h3>Continue Reading</h3></div>
          <div className="scrollable-container">
            {lastReadSurahs.map((no) => (
              <Link key={no} to={`/surah/${no}`} className="surah-pill">
                {no}. {surahs[no - 1]?.surahName}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="container1">
        <div className="card-header">
          <h3>Find a Surah</h3>
        </div>
        <div className="surah-search-wrapper">
          <input
            type="text"
            className="surah-search-input"
            placeholder="Search by number or name"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </div>
      </div>

      <div className="container1">
        <div className="card-header">
          <h3>All Surahs</h3>
          <span className="badge badge-primary">114 Surahs</span>
        </div>
        <div className="surah-grid">
          {filtered.map((surah, i) => {
            const no = surahs.indexOf(surah) + 1;
            return (
              <Link key={no} to={`/surah/${no}`} className="surah-card">
                <span className="surah-card-number">{no}</span>
                <div className="surah-card-content">
                  <p className="surah-name">{surah.surahName}</p>
                  <p className="surah-arabic">{surah.surahNameArabic}</p>
                  <p className="surah-translation">{surah.surahNameTranslation}</p>
                  <p className="surah-meta">{surah.revelationPlace} · {surah.totalAyah} Ayahs</p>
                </div>
                <span className="material-symbols-rounded surah-card-arrow">chevron_right</span>
              </Link>
            );
          })}
        </div>
        {filtered.length === 0 && <p className="post-empty">No surah matches “{term}”.</p>}
      </div>
    </div>
  );
}
