import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { quran } from '../services/api';
import { useFavourites } from '../hooks/useFavourites';

export default function SurahPage() {
  const { surahNo } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const { favourites, isFavourite, toggleFavourite } = useFavourites();

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    quran.surah(surahNo)
      .then((payload) => { if (!cancelled) setData(payload); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load this surah.'); });
    return () => { cancelled = true; };
  }, [surahNo]);

  // Seeded from the surah payload so the hearts are correct on first paint,
  // then replaced by whatever the shared favourites hook has loaded.
  const favKeys = useMemo(() => {
    if (favourites.length) return new Set(favourites.map((f) => `${f.surahNo}:${f.ayahNo}`));
    return new Set((data?.favouriteKeys) || []);
  }, [favourites, data]);

  if (error) return <div className="page"><h1>Surah</h1><p className="error-text">{error}</p></div>;
  if (!data) return <div className="page"><p className="loading-text">Loading…</p></div>;

  const targetAyah = params.get('ayah');

  return (
    <div className="page">
      <header className="page-header">
        <h1>{data.surahName}</h1>
        <p>{data.surahNameArabic} · {data.surahNameTranslation}</p>
      </header>

      <section className="panel">
        <p className="empty-text">
          {data.revelationPlace} · {data.totalAyah} Ayahs
        </p>
      </section>

      {data.arabic.map((text, index) => {
        const ayahNo = index + 1;
        const on = isFavourite(data.surahNo, ayahNo) || favKeys.has(`${data.surahNo}:${ayahNo}`);
        return (
          <article key={ayahNo} className={`ayah-block${String(ayahNo) === targetAyah ? ' is-target' : ''}`}>
            <header className="ayah-head">
              <span className="ayah-number">Ayah {ayahNo}</span>
              <button
                type="button"
                className={`fav-btn${on ? ' is-active' : ''}`}
                aria-pressed={on}
                aria-label={on ? 'Remove from favourites' : 'Add to favourites'}
                onClick={() => toggleFavourite(data.surahNo, ayahNo)}
              >
                <span className="material-symbols-rounded">{on ? 'favorite' : 'favorite_border'}</span>
              </button>
            </header>

            <p className="arabic" dir="rtl" lang="ar" style={{ fontFamily: `'${data.favoriteFont}', serif` }}>
              {text}
            </p>

            {data.translations.map((t) => {
              const translated = t.texts[index];
              if (!translated) return null;
              const isPrimary = data.primaryTranslationId === t.id;
              return (
                <div key={t.id} className="translation">
                  <p className="translation-label">{t.label}{isPrimary ? ' · Primary' : ''}</p>
                  <p className="translation-text">{translated}</p>
                </div>
              );
            })}
          </article>
        );
      })}

      <p className="back-link"><Link to="/quran">← Back to Quran</Link></p>
    </div>
  );
}
