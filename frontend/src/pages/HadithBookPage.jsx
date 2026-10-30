import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { hadiths } from '../services/api';
import Loader from '../components/Loader';

// One collection's reader: a row of section chips, then the hadiths of the
// selected section as Arabic + English blocks. The section and page live in
// the query string, so every state is a shareable URL, exactly like the
// surah reader's ?ayah= deep links.
export default function HadithBookPage() {
  const { collection: id } = useParams();
  const [params, setParams] = useSearchParams();
  const sectionId = params.get('section') || '1';
  const page = Math.max(1, parseInt(params.get('page'), 10) || 1);

  const [manifest, setManifest] = useState(null);
  const [section, setSection] = useState(null);
  const [error, setError] = useState('');

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

  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    setError('');
    hadiths.section(id, sectionId, { page })
      .then((data) => { if (!cancelled) setSection(data); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load this section.'); });
    return () => { cancelled = true; };
  }, [manifest, id, sectionId, page]);

  if (error && !manifest) return <><div className="page-header"><h1>Hadith</h1></div><div className="container1"><p className="post-empty">{error}</p></div></>;
  if (!manifest) return <Loader variant="page" label="Loading collection" />;

  const sections = manifest.sections || [];
  const current = sections.find((s) => String(s.id) === sectionId) || sections[0];
  const setQuery = (next) => {
    const merged = { section: sectionId, page: '1', ...next };
    setParams(merged);
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
      <header className="page-header">
        <p className="surah-page-kicker">Hadith collection</p>
        <h1>{manifest.name}</h1>
        <p>{manifest.translator} · {manifest.total} hadiths</p>
      </header>

      {sections.length > 1 && (
        <div className="hadith-sections" role="tablist" aria-label="Sections">
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
            <p className="hadith-section-title">{current.title}</p>
          )}

          {section.hadiths.map((h) => (
            <article key={h.number} className="ayah-block">
              <div className="ayah-head">
                <p className="ayah-number">Hadith № {h.number}</p>
              </div>

              {h.arabic && (
                <p className="ayah-arabic-text hadith-arabic-text" dir="rtl" lang="ar">{h.arabic}</p>
              )}

              <div className="ayah-translation">
                <p className="ayah-translation-text">{h.text}</p>
              </div>

              {h.grades && h.grades.length > 0 && (
                <p className="hadith-grades">{h.grades.map((g) => [g.name, g.grade].filter(Boolean).join(' — ')).join(' · ')}</p>
              )}
            </article>
          ))}

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
