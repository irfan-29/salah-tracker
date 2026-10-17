import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { quran } from '../services/api';
import { useFavourites } from '../hooks/useFavourites';
import Loader from '../components/Loader';

export default function SurahPage() {
  const { surahNo } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selectedAyah, setSelectedAyah] = useState(1);
  const { favourites, isFavourite, toggleFavourite } = useFavourites();

  const totalAyahs = data?.arabic?.length || 0;

  // Scrolls the ayah into view and puts the keyboard focus on it, so a jump is
  // navigable rather than just visible.
  const goToAyah = useCallback((n) => {
    const ayah = Number(n) || 1;
    setSelectedAyah(ayah);
    const el = document.getElementById(String(ayah));
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
  }, []);

  // Keeps the slider honest: a surah with fewer ayahs than the slider was left
  // on would show an out-of-range value.
  useEffect(() => {
    setSelectedAyah((current) => (totalAyahs && current > totalAyahs ? totalAyahs : current));
  }, [totalAyahs]);

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

  const targetAyah = params.get('ayah');

  // Deep link support: /surah/2?ayah=255 opens scrolled to that ayah. Runs on
  // surah change and whenever the query changes, since the DOM only exists once
  // `data` has loaded.
  //
  // This has to sit ABOVE the early returns below. React compares the hook list
  // between renders, so an effect placed after `if (!data) return` only exists on
  // the loaded render - the first render calls fewer hooks than the second, and
  // React throws "Rendered more hooks than during the previous render", which
  // blanks the whole app.
  useEffect(() => {
    if (!data || !targetAyah) return;
    goToAyah(targetAyah);
  }, [data, targetAyah, goToAyah]);

  if (error) return <><div className="page-header"><h1>Surah</h1></div><div className="container1"><p className="post-empty">{error}</p></div></>;
  if (!data) return <Loader variant="page" label={`Loading ${surahNo}`} />;

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

      {/* Ayah navigator. views/surah.ejs had this between the surah meta and the
          ayah list; the port dropped it, so there was no way to jump to an ayah
          in a long surah. Same markup and same inline styling as the original. */}
      <div style={{ textAlign: 'center', margin: '1.5rem 0' }}>
        <label htmlFor="ayahRange" style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-text-secondary)', display: 'block', marginBottom: '0.75rem' }}>
          Go to Ayah
        </label>
        <input
          type="range" id="ayahRange" className="form-range"
          min="1" max={data.arabic.length} value={selectedAyah}
          onChange={(e) => setSelectedAyah(Number(e.target.value))}
          style={{ maxWidth: 320, accentColor: 'var(--color-primary)' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', marginTop: '0.75rem' }}>
          <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>Ayah</span>
          <span style={{ fontWeight: 700, fontSize: '1.125rem', color: 'var(--color-primary)' }}>{selectedAyah}</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => goToAyah(selectedAyah)}>Go</button>
        </div>
      </div>

      {data.arabic.map((text, index) => {
        const ayahNo = index + 1;
        const on = isFavourite(data.surahNo, ayahNo) || favKeys.has(`${data.surahNo}:${ayahNo}`);
        return (
          <article key={ayahNo} id={String(ayahNo)} className="ayah-block" style={{ marginBottom: '2.5rem' }}>
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
