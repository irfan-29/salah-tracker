import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { quran } from '../services/api';
import { useFavourites } from '../hooks/useFavourites';
import Loader from '../components/Loader';

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

  if (error) return <><div className="page-header"><h1>Surah</h1></div><div className="container1"><p className="post-empty">{error}</p></div></>;
  if (!data) return <Loader variant="inline" label={`Loading ${surahNo}`} />;

  const targetAyah = params.get('ayah');

  return (
    <>
      <header className="page-header">
        <h1>{data.surahName}</h1>
        <p>{data.surahNameArabic} · {data.surahNameTranslation}</p>
      </header>

      {/* Mirrors the .container1 > .surah-item block in views/surah.ejs, down to
          the inline overrides, so the spacing matches exactly. */}
      <div className="container1" style={{ textAlign: 'left' }}>
        <div className="surah-item" style={{ borderBottom: 'none', paddingBottom: 0 }}>
          <p className="surah-meta">{data.revelationPlace} · {data.totalAyah} Ayahs</p>
        </div>
      </div>

      {data.arabic.map((text, index) => {
        const ayahNo = index + 1;
        const on = isFavourite(data.surahNo, ayahNo) || favKeys.has(`${data.surahNo}:${ayahNo}`);
        return (
          <article key={ayahNo} id={String(ayahNo)} className="ayah-block">
            <div className="ayah-head">
              <p className="ayah-number">Ayah {ayahNo}</p>
              <button
                type="button"
                className={`fav-btn${on ? ' is-active' : ''}`}
                aria-pressed={on}
                aria-label={on ? 'Remove from favourites' : 'Add to favourites'}
                onClick={() => toggleFavourite(data.surahNo, ayahNo)}
              >
                <span className="material-symbols-rounded">{on ? 'favorite' : 'favorite_border'}</span>
              </button>
            </div>

            <p className="quran-text-display" dir="rtl" lang="ar" style={{ fontFamily: `'${data.favoriteFont}', serif`, lineHeight: 2, fontSize: '28px', textAlign: 'right' }}>
              {text}
            </p>

            {data.translations.map((t) => {
              const translated = t.texts[index];
              if (!translated) return null;
              const isPrimary = data.primaryTranslationId === t.id;
              return (
                <div key={t.id} style={{ textAlign: 'left', marginTop: '1rem', marginBottom: '1.25rem', padding: '0.75rem 0 0.75rem 1rem', borderLeft: '3px solid var(--color-primary)', background: 'var(--color-primary-glow)', borderRadius: '0 var(--radius-sm) var(--radius-sm) 0' }}>
                  <p style={{ color: 'var(--color-primary)', fontSize: '0.6875rem', marginBottom: '0.375rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>
                    {t.label}{isPrimary ? ' · Primary' : ''}
                  </p>
                  <p style={{ fontFamily: "'Mukta Malar', sans-serif", fontSize: '1.0625rem', color: 'var(--color-text)', lineHeight: 1.6, margin: 0 }}>
                    {translated}
                  </p>
                </div>
              );
            })}
          </article>
        );
      })}

      <p className="post-back"><Link to="/quran">← Back to Quran</Link></p>
    </>
  );
}
