import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { hadiths } from '../services/api';
import { useHadithBookmarks } from '../hooks/useHadithBookmarks';
import Loader from '../components/Loader';

// navigator.clipboard needs a secure context. The fallback matters on a plain
// http:// dev host, where the share button would otherwise do nothing.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  document.body.removeChild(area);
}

// One collection's reader: a row of section chips, then the hadiths of the
// selected section as Arabic + translation blocks. The section, page and
// translation language live in the query string/localStorage, so every state
// is a shareable URL, exactly like the surah reader's ?ayah= deep links.
const LANG_KEY = 'salah-hadith-lang';

export default function HadithBookPage() {
  const { collection: id } = useParams();
  const [params, setParams] = useSearchParams();
  const sectionId = params.get('section') || '1';
  const page = Math.max(1, parseInt(params.get('page'), 10) || 1);

  const [manifest, setManifest] = useState(null);
  const [section, setSection] = useState(null);
  const [error, setError] = useState('');
  const { isBookmarked, toggleBookmark } = useHadithBookmarks();
  // Share feedback per block, mirroring the surah reader's pattern.
  const [shareNotice, setShareNotice] = useState({ number: 0, status: '' });
  const shareTimer = useRef(null);
  // The chosen translation starts from localStorage but is validated against
  // what the collection actually seeds once the manifest arrives.
  const [lang, setLang] = useState(() => localStorage.getItem(LANG_KEY) || 'eng');

  // The manifest (sections + total) loads once per collection; switching
  // sections only refetches the section page.
  useEffect(() => {
    let cancelled = false;
    setManifest(null);
    setSection(null);
    setError('');
    hadiths.collection(id)
      .then((data) => { if (!cancelled) setManifest(data); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load this collection.'); });
    return () => { cancelled = true; };
  }, [id]);

  const languages = manifest?.languages || [];
  useEffect(() => {
    if (manifest && !languages.some((l) => l.code === lang)) setLang('eng');
  }, [manifest, languages, lang]);

  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    setError('');
    hadiths.section(id, sectionId, { page, lang })
      .then((data) => { if (!cancelled) setSection(data); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load this section.'); });
    return () => { cancelled = true; };
  }, [manifest, id, sectionId, page, lang]);

  function chooseLanguage(code) {
    setLang(code);
    try { localStorage.setItem(LANG_KEY, code); } catch { /* private mode */ }
  }

  useEffect(() => () => window.clearTimeout(shareTimer.current), []);

  // Shares Arabic + the translation the reader is currently showing, in one
  // message. The URL is the hadith itself (?no=), not the page, so whoever
  // opens it lands on this exact hadith with it highlighted. The URL ends the
  // text deliberately: native share sheets keep text order, while a separate
  // `url` field is often appended somewhere unpredictable.
  async function shareHadith(h) {
    const appUrl = `${window.location.origin}/hadith/${id}?no=${h.number}`;
    const text = [
      'Hasanath — Hadith',
      `${manifest.name} · Hadith № ${h.number}`,
      h.arabic || '',
      h.text || '',
      appUrl,
    ].filter(Boolean).join('\n\n');

    const note = (status) => {
      setShareNotice({ number: h.number, status });
      window.clearTimeout(shareTimer.current);
      shareTimer.current = window.setTimeout(() => {
        setShareNotice({ number: 0, status: '' });
      }, 1800);
    };

    if (navigator.share) {
      try {
        await navigator.share({ title: `${manifest.name} · Hadith № ${h.number}`, text });
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
    } catch {
      note('failed');
    }
  }

  // Jump-to-number: the server resolves the section + page that hold the
  // hadith, the reader navigates there and highlights the block.
  const [jumpNo, setJumpNo] = useState('');
  const [jumpNotice, setJumpNotice] = useState('');
  const [target, setTarget] = useState(null);

  async function jumpToNumber(e) {
    e.preventDefault();
    const wanted = jumpNo.trim();
    if (!wanted) return;
    try {
      const hit = await hadiths.find(id, wanted);
      setJumpNotice('');
      setTarget(hit.number);
      // Direct setParams - setQuery would clear the target this jump just set.
      setParams({ section: hit.sectionId, page: String(hit.page) });
    } catch {
      setTarget(null);
      setJumpNotice(`Hadith № ${wanted} is not in ${manifest.name}.`);
    }
  }

  // Scrolls the jumped-to hadith into view once its section page has rendered.
  useEffect(() => {
    if (!section || !target) return;
    const el = document.getElementById(`hadith-${target}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [section, target]);

  // A shared link arrives as ?no=<hadith number>. Resolve it to its section
  // and page exactly like the jump form does, then drop `no` from the URL -
  // the highlight stays until the reader navigates somewhere else.
  const sharedNo = params.get('no');
  useEffect(() => {
    if (!manifest || !sharedNo) return;
    let cancelled = false;
    hadiths.find(id, sharedNo)
      .then((hit) => {
        if (cancelled) return;
        setTarget(hit.number);
        setParams({ section: hit.sectionId, page: String(hit.page) });
      })
      .catch(() => { /* unknown number - the reader stays where it is */ });
    return () => { cancelled = true; };
  }, [manifest, sharedNo, id, setParams]);

  if (error && !manifest) return <><div className="page-header"><h1>Hadith</h1></div><div className="container1"><p className="post-empty">{error}</p></div></>;
  if (!manifest) return <Loader variant="page" label="Loading collection" />;

  const sections = manifest.sections || [];
  const current = sections.find((s) => String(s.id) === sectionId) || sections[0];
  const setQuery = (next) => {
    const merged = { section: sectionId, page: '1', ...next };
    setParams(merged);
    // Manual navigation is no longer a jump - drop the highlight and notice.
    setTarget(null);
    setJumpNotice('');
  };

  const pagerLink = (targetPage) => (
    <Link
      className={`surah-pager-link${targetPage ? '' : ' is-disabled'}`}
      to={targetPage ? `?section=${sectionId}&page=${targetPage}` : '#'}
      onClick={(e) => { if (!targetPage) e.preventDefault(); }}
      aria-label={`Page ${targetPage || 'none'}`}
      aria-disabled={targetPage ? undefined : true}
    >
      <span className="surah-pager-direction">
        <span className="material-symbols-rounded" aria-hidden="true">arrow_back</span>
        <span className="surah-pager-label">Previous page</span>
      </span>
      <strong className="surah-pager-name">
        <span className="surah-pager-no">{targetPage ? String(targetPage) : '—'}</span>
        <span className="surah-pager-title">of {section ? section.pages : 1}</span>
      </strong>
    </Link>
  );

  const pagerLinkNext = (targetPage) => (
    <Link
      className={`surah-pager-link is-next${targetPage ? '' : ' is-disabled'}`}
      to={targetPage ? `?section=${sectionId}&page=${targetPage}` : '#'}
      onClick={(e) => { if (!targetPage) e.preventDefault(); }}
      aria-label={`Page ${targetPage || 'none'}`}
      aria-disabled={targetPage ? undefined : true}
    >
      <span className="surah-pager-direction">
        <span className="surah-pager-label">Next page</span>
        <span className="material-symbols-rounded" aria-hidden="true">arrow_forward</span>
      </span>
      <strong className="surah-pager-name">
        <span className="surah-pager-no">{targetPage ? String(targetPage) : '—'}</span>
        <span className="surah-pager-title">of {section ? section.pages : 1}</span>
      </strong>
    </Link>
  );

  return (
    <>
      <Link to="/hadith" className="reader-back">
        <span className="material-symbols-rounded" aria-hidden="true">arrow_back</span>
        Hadith
      </Link>

      <header className="page-header">
        <p className="surah-page-kicker">Hadith collection</p>
        <h1>{manifest.name}</h1>
        <p>{manifest.translator} · {manifest.total} hadiths</p>
      </header>

      <form className="hadith-jump" onSubmit={jumpToNumber}>
        <label htmlFor="hadithJumpNo" className="hadith-jump-label">Go to Hadith №</label>
        <div className="hadith-jump-row">
          <input
            id="hadithJumpNo"
            type="number"
            min="1"
            inputMode="numeric"
            className="hadith-jump-input"
            placeholder="e.g. 3"
            value={jumpNo}
            onChange={(e) => setJumpNo(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm">Go</button>
        </div>
        {jumpNotice && <p className="hadith-jump-notice">{jumpNotice}</p>}
      </form>

      {languages.length > 1 && (
        <div className="hadith-langs" role="group" aria-label="Translation language">
          <span className="hadith-langs-label">Translation</span>
          {languages.map((l) => (
            <button
              key={l.code}
              type="button"
              className={`hadith-chip hadith-lang-chip${l.code === lang ? ' is-active' : ''}`}
              aria-pressed={l.code === lang}
              onClick={() => chooseLanguage(l.code)}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}

      {sections.length > 1 && (
        <div className="hadith-sections" role="tablist" aria-label="Categories">
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              className={`hadith-chip${String(s.id) === String(current?.id) ? ' is-active' : ''}`}
              aria-selected={String(s.id) === String(current?.id)}
              onClick={() => setQuery({ section: s.id, page: '1' })}
            >
              {s.title}
            </button>
          ))}
        </div>
      )}

      {error && <div className="container1"><p className="post-empty">{error}</p></div>}

      {!error && !section && <Loader variant="page" label="Loading hadiths" />}

      {section && (
        <>
          {current && sections.length > 1 && (
            <p className="hadith-section-title">
              <span className="hadith-section-kicker">Category</span>
              {current.title}
            </p>
          )}

          {section.hadiths.map((h) => {
            const on = isBookmarked(id, h.number);
            const shared = shareNotice.number === h.number ? shareNotice.status : '';
            const shareLabel = shared === 'copied'
              ? 'Hadith text copied'
              : shared === 'shared'
                ? 'Hadith shared'
                : shared === 'failed'
                  ? 'Could not share hadith'
                  : `Share ${manifest.name} hadith ${h.number}`;
            return (
              <article
                key={h.number}
                id={`hadith-${h.number}`}
                className={`ayah-block${target != null && String(target) === String(h.number) ? ' hadith-target' : ''}`}
              >
                <div className="ayah-head">
                  <p className="ayah-number">Hadith № {h.number}</p>
                  <div className="ayah-actions">
                    <button
                      type="button"
                      className={`fav-btn ayah-share-btn${shared ? ` is-${shared}` : ''}`}
                      aria-label={shareLabel}
                      title={shared === 'copied' ? 'Copied' : 'Share hadith'}
                      onClick={() => shareHadith(h)}
                    >
                      <span className="material-symbols-rounded">
                        {shared === 'copied' || shared === 'shared' ? 'check' : shared === 'failed' ? 'error' : 'share'}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`fav-btn bookmark-btn${on ? ' is-active' : ''}`}
                      aria-pressed={on}
                      aria-label={on ? 'Remove bookmark' : 'Bookmark this hadith'}
                      onClick={() => toggleBookmark(id, h.number)}
                    >
                      <span className="material-symbols-rounded">{on ? 'bookmark' : 'bookmark_border'}</span>
                    </button>
                  </div>
                </div>

                {h.arabic && (
                  <p className="ayah-arabic-text hadith-arabic-text" dir="rtl" lang="ar">{h.arabic}</p>
                )}

                <div className="ayah-translation">
                  {/* Urdu reads right-to-left; the paragraph itself carries the
                      direction so punctuation sits on the correct side. */}
                  <p className="ayah-translation-text" dir={section.language.dir}>{h.text}</p>
                </div>

                {h.grades && h.grades.length > 0 && (
                  <p className="hadith-grades">{h.grades.map((g) => [g.name, g.grade].filter(Boolean).join(' — ')).join(' · ')}</p>
                )}
              </article>
            );
          })}

          {section.hadiths.length === 0 && (
            <div className="container1"><p className="post-empty">No hadiths in this section.</p></div>
          )}

          {section.pages > 1 && (
            <nav className="surah-pager" aria-label="Section pages">
              {page > 1 ? pagerLink(page - 1) : pagerLink(null)}
              {page < section.pages ? pagerLinkNext(page + 1) : pagerLinkNext(null)}
            </nav>
          )}
        </>
      )}
    </>
  );
}
