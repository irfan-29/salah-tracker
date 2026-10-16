import { useMemo, useState } from 'react';

export default function AudioTab({ surahs, reciters, reciter, onReciterChange, onPlaySurah }) {
  const [term, setTerm] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(null);

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return surahs;
    return surahs.filter((s, i) =>
      s.surahName.toLowerCase().includes(q) || String(i + 1).includes(q));
  }, [surahs, term]);

  async function play(no) {
    setLoading(no);
    try {
      await onPlaySurah(no);
    } finally {
      setLoading(null);
    }
  }

  return (
    <>
      <section className="panel">
        <header className="panel-header"><h3>Reciter</h3></header>
        <div className="reciter-row">
          <select
            className="select"
            value={reciter}
            disabled={saving}
            onChange={async (e) => { setSaving(true); try { await onReciterChange(e.target.value); } finally { setSaving(false); } }}
          >
            {reciters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <span className="hint">{saving ? 'Saving…' : 'Applies to the whole app'}</span>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h3>Play</h3>
          <span className="badge">{surahs.length} Surahs</span>
        </header>
        <input
          className="search-input"
          type="search"
          placeholder="Search surah to play"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <ul className="audio-list">
          {filtered.map((surah) => {
            const no = surahs.indexOf(surah) + 1;
            return (
              <li key={no}>
                <button
                  type="button"
                  className="audio-option"
                  disabled={loading === no}
                  onClick={() => play(no)}
                >
                  <span>{no}. {surah.surahName}</span>
                  <span className="material-symbols-rounded">
                    {loading === no ? 'hourglass_top' : 'play_circle'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {filtered.length === 0 && <p className="empty-text">No surah matches “{term}”.</p>}
      </section>
    </>
  );
}
