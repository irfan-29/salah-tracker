import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { quran } from '../services/api';
import { useFavourites } from '../hooks/useFavourites';
import Loader from '../components/Loader';

// navigator.clipboard needs a secure context. The fallback matters on a plain
// http:// dev host, where the share button would otherwise do nothing.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'absolute';
  field.style.left = '-9999px';
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(field);
  if (!copied) throw new Error('copy-failed');
}

export default function SurahPage() {
  const { surahNo } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selectedAyah, setSelectedAyah] = useState(1);
  const [shareNotice, setShareNotice] = useState({ ayah: 0, status: '' });
  const shareTimer = useRef(null);
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

  useEffect(() => () => window.clearTimeout(shareTimer.current), []);

  // Shares the same translations the reader is looking at, all in one message.
  // The URL ends the text deliberately: native share sheets keep text order,
  // while a separate `url` field is often appended somewhere unpredictable.
  async function shareAyah(ayahNo) {
    if (!data) return;
    const index = ayahNo - 1;
    const translationText = data.translations
      .map((t) => {
        const translated = t.texts[index];
        return translated ? `${t.label}\n${translated}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
    const appUrl = `${window.location.origin}/surah/${data.surahNo}?ayah=${ayahNo}`;
    const text = [
      'Hasanath — Qur’an',
      `${data.surahName} ${data.surahNo}:${ayahNo}`,
      data.arabic[index] || '',
      translationText,
      appUrl,
    ].filter(Boolean).join('\n\n');

    const note = (status) => {
      setShareNotice({ ayah: ayahNo, status });
      window.clearTimeout(shareTimer.current);
      shareTimer.current = window.setTimeout(() => {
        setShareNotice({ ayah: 0, status: '' });
      }, 1800);
    };

    if (navigator.share) {
      try {
        await navigator.share({
          title: `${data.surahName} ${data.surahNo}:${ayahNo}`,
          text,
        });
        note('shared');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        // A share sheet can fail for reasons the clipboard can still handle.
      }
    }

    try {
      await copyText(text);
      note('copied');
    } catch (err) {
      note('failed');
    }
  }

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
        <p className="surah-page-kicker">Surah {data.surahNo} of 114</p>
        <h1>{data.surahName}</h1>
        <p>{data.surahNameArabic} · {data.surahNameTranslation}</p>
        <div className="surah-meta-row">
          <span className="surah-meta-pill">
            <span className="material-symbols-rounded" aria-hidden="true">place</span>
            {data.revelationPlace}
          </span>
          <span className="surah-meta-pill">
            <span className="material-symbols-rounded" aria-hidden="true">menu_book</span>
            {data.totalAyah} Ayahs
          </span>
        </div>
      </header>

      {/* Ayah navigator. views/surah.ejs had this between the surah meta and the
          ayah list; the port dropped it, so there was no way to jump to an ayah
          in a long surah. Same markup and same inline styling as the original. */}
      <div className="ayah-jump">
        <label htmlFor="ayahRange" className="ayah-jump-label">Go to Ayah</label>
        <input
          type="range" id="ayahRange" className="form-range"
          min="1" max={data.arabic.length} value={selectedAyah}
          onChange={(e) => setSelectedAyah(Number(e.target.value))}
        />
        <div className="ayah-jump-row">
          <span className="ayah-jump-caption">Ayah</span>
          <span className="ayah-jump-value">{selectedAyah}</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => goToAyah(selectedAyah)}>Go</button>
        </div>
      </div>

      {data.arabic.map((text, index) => {
        const ayahNo = index + 1;
        const on = isFavourite(data.surahNo, ayahNo) || favKeys.has(`${data.surahNo}:${ayahNo}`);
        const shared = shareNotice.ayah === ayahNo ? shareNotice.status : '';
        const shareLabel = shared === 'copied'
          ? 'Ayah text copied'
          : shared === 'shared'
            ? 'Ayah shared'
            : shared === 'failed'
              ? 'Could not share ayah'
              : `Share ${data.surahName} ${data.surahNo}:${ayahNo}`;
        return (
          <article key={ayahNo} id={String(ayahNo)} className="ayah-block" style={{ marginBottom: '2.5rem' }}>
            <div className="ayah-head">
              <p className="ayah-number">Ayah {ayahNo}</p>
              <div className="ayah-actions">
                <button
                  type="button"
                  className={`fav-btn ayah-share-btn${shared ? ` is-${shared}` : ''}`}
                  aria-label={shareLabel}
                  title={shared === 'copied' ? 'Copied' : 'Share ayah'}
                  onClick={() => shareAyah(ayahNo)}
                >
                  <span className="material-symbols-rounded">
                    {shared === 'copied' || shared === 'shared' ? 'check' : shared === 'failed' ? 'error' : 'share'}
                  </span>
                </button>
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
            </div>

            <p className="ayah-arabic-text" dir="rtl" lang="ar" style={{ fontFamily: `'${data.favoriteFont}', serif` }}>
              {text}
            </p>

            {data.translations.map((t) => {
              const translated = t.texts[index];
              if (!translated) return null;
              const isPrimary = data.primaryTranslationId === t.id;
              return (
                <div className="ayah-translation" key={t.id}>
                  <p className="ayah-translation-label">
                    {t.label}{isPrimary ? ' · Primary' : ''}
                  </p>
                  <p className="ayah-translation-text">{translated}</p>
                </div>
              );
            })}
          </article>
        );
      })}

      <nav className="surah-pager" aria-label="Surah navigation">
        {data.previousSurah ? (
          <Link
            className="surah-pager-link"
            to={`/surah/${data.previousSurah.surahNo}`}
            aria-label={`Previous surah: ${data.previousSurah.surahNo}. ${data.previousSurah.surahName}`}
          >
            <span className="surah-pager-direction">
              <span className="material-symbols-rounded" aria-hidden="true">arrow_back</span>
              <span className="surah-pager-label">Previous surah</span>
            </span>
            <strong className="surah-pager-name">
              <span className="surah-pager-no">{data.previousSurah.surahNo}</span>
              <span className="surah-pager-title">{data.previousSurah.surahName}</span>
            </strong>
          </Link>
        ) : (
          <span className="surah-pager-link is-disabled" aria-disabled="true">
            <span className="surah-pager-direction">
              <span className="material-symbols-rounded" aria-hidden="true">arrow_back</span>
              <span className="surah-pager-label">Previous surah</span>
            </span>
            <strong className="surah-pager-name">
              <span className="surah-pager-title">Start of the Qur’an</span>
            </strong>
          </span>
        )}

        {data.nextSurah ? (
          <Link
            className="surah-pager-link is-next"
            to={`/surah/${data.nextSurah.surahNo}`}
            aria-label={`Next surah: ${data.nextSurah.surahNo}. ${data.nextSurah.surahName}`}
          >
            <span className="surah-pager-direction">
              <span className="surah-pager-label">Next surah</span>
              <span className="material-symbols-rounded" aria-hidden="true">arrow_forward</span>
            </span>
            <strong className="surah-pager-name">
              <span className="surah-pager-no">{data.nextSurah.surahNo}</span>
              <span className="surah-pager-title">{data.nextSurah.surahName}</span>
            </strong>
          </Link>
        ) : (
          <span className="surah-pager-link is-next is-disabled" aria-disabled="true">
            <span className="surah-pager-direction">
              <span className="surah-pager-label">Next surah</span>
              <span className="material-symbols-rounded" aria-hidden="true">arrow_forward</span>
            </span>
            <strong className="surah-pager-name">
              <span className="surah-pager-title">End of the Qur’an</span>
            </strong>
          </span>
        )}
      </nav>
    </>
  );
}
