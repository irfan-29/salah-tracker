import { useMemo, useState } from 'react';

// Class names mirror views/quran-audio.ejs.
export default function AudioTab({ surahs, reciters, reciter, onReciterChange, onPlaySurah }) {
  const [term, setTerm] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(null);
  const [status, setStatus] = useState('');

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return surahs;
    return surahs.filter((s, i) => s.surahName.toLowerCase().includes(q) || String(i + 1).includes(q));
  }, [surahs, term]);

  async function play(no) {
    setLoading(no);
    setStatus('');
    try {
      await onPlaySurah(no);
    } catch (err) {
      setStatus('Could not load that audio. Please try again.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="quran-tab-panel" data-tab-panel="audio">
      <div className="container1">
        <div className="card-header"><h3>Reciter</h3></div>
        <div className="reciter-row">
          <div className="form-floating">
            <select
              name="reciter"
              id="reciterSelect"
              className="form-control"
              value={reciter}
              disabled={saving}
              onChange={async (e) => {
                setSaving(true);
                try { await onReciterChange(e.target.value); setStatus('Saved.'); }
                catch (err) { setStatus('Could not save.'); }
                finally { setSaving(false); }
              }}
            >
              {reciters.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <label htmlFor="reciterSelect">Reciter</label>
          </div>
        </div>
        {status && <p className="tg-hint">{status}</p>}
      </div>

      <div className="container1">
        <div className="card-header">
          <h3>Play</h3>
          <span className="badge badge-primary">114 Surahs</span>
        </div>
        <div className="surah-search-wrapper">
          <input
            type="text"
            className="surah-search-input"
            placeholder="Search surah to play"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </div>
        <div className="surah-list">
          {filtered.map((surah) => {
            const no = surahs.indexOf(surah) + 1;
            return (
              <button
                key={no}
                type="button"
                className="surah-option audio-surah-option"
                disabled={loading === no}
                onClick={() => play(no)}
              >
                <span>{no}. {surah.surahName}</span>
                <span className="material-symbols-rounded audio-option-icon">
                  {loading === no ? 'hourglass_top' : 'play_circle'}
                </span>
              </button>
            );
          })}
        </div>
        {filtered.length === 0 && <p className="post-empty">No surah matches “{term}”.</p>}
      </div>
    </div>
  );
}
