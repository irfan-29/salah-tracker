import { useCallback, useEffect, useState } from 'react';
import { salah as api } from '../services/api';
import { useSession } from '../hooks/useSession.jsx';
import Loader from '../components/Loader';

const PRAYERS = ['Fajr', 'Zuhur', 'Asar', 'Magrib', 'Isha', 'others'];
const STATUSES = ['In Jamath', 'On Time', 'Late', 'Not Prayed', 'others'];

const today = () => new Date().toISOString().slice(0, 10);

function StatusBadge({ value }) {
  // Same three states as the EJS table: kept, late, missed.
  if (value === 'In Jamath' || value === 'On Time') return <span className="badge badge-primary">{value}</span>;
  if (value === 'Late') return <span className="badge badge-accent">{value}</span>;
  return <span className="badge" style={{ background: 'rgba(239,68,68,0.1)', color: '#dc2626' }}>{value}</span>;
}

// Markup mirrors views/salah.ejs.
export default function SalahPage() {
  const { isLoggedIn } = useSession();

  const [date, setDate] = useState(today);
  const [findDate, setFindDate] = useState(today);
  const [name, setName] = useState('Fajr');
  const [value, setValue] = useState('On Time');

  const [history, setHistory] = useState({ loading: true, label: '', entries: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (forDate) => {
    setHistory((h) => ({ ...h, loading: true }));
    try {
      const data = await api.list(forDate);
      setHistory({ loading: false, label: data.date, entries: data.entries || [] });
    } catch (err) {
      setHistory({ loading: false, label: '', entries: [] });
      setError('Could not load your salah history.');
    }
  }, []);

  useEffect(() => { load(findDate); }, [findDate, load]);

  async function save() {
    setSaving(true);
    setError('');
    try {
      // The server derives the date label itself from `date`, so the client's
      // clock cannot be used to write into a different day.
      await api.record({ date, name, value });
      // Move the history to the day just written and reload it. When the day is
      // already the one on screen, setFindDate is a no-op and the effect will
      // not fire, so the refresh is requested explicitly - and only in that
      // case, so this never doubles up with the effect.
      if (findDate === date) await load(date);
      else setFindDate(date);
    } catch (err) {
      setError('Could not save that entry.');
    } finally {
      setSaving(false);
    }
  }

  if (isLoggedIn === null) {
    return <Loader variant="page" label="Loading Salah Tracker" />;
  }

  return (
    <>
      <div className="page-header">
        <h1>Salah Tracker</h1>
        <p>Log and review your daily prayers</p>
      </div>

      <div className="container1">
        <div className="card-header"><h3>Log Salah</h3></div>

        {!isLoggedIn ? (
          <div className="gate-notice">
            <span className="gate-icon material-symbols-rounded" aria-hidden="true">lock</span>
            <div className="gate-body">
              <h2 className="gate-title">Sign in to log your prayers</h2>
              <p className="gate-text">
                Recording which prayers you kept is personal, so it needs an account
                to keep your history safe. Everything else stays open.
              </p>
              <div className="gate-actions">
                <a href="/login" className="btn btn-primary">Sign in to continue</a>
                <a href="/register" className="btn btn-outline">Create account</a>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="form-floating">
              <input className="form-control" type="date" required id="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <label htmlFor="date">Date</label>
            </div>

            <div className="form-floating">
              <select value={name} onChange={(e) => setName(e.target.value)} className="form-control" id="salah">
                {PRAYERS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <label htmlFor="salah">Salah</label>
            </div>

            <div className="form-floating">
              <select value={value} onChange={(e) => setValue(e.target.value)} className="form-control" id="value">
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <label htmlFor="value">Status</label>
            </div>

            {error && <div className="auth-alert" role="alert"><span className="material-symbols-rounded">error</span>{error}</div>}

            <div className="new-task">
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save Entry'}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="container1">
        <div className="card-header"><h3>View Salah History</h3></div>

        {/* No Find button. Choosing a date reloads the history immediately
            (see the effect above), so a second control only gave the user a way
            to ask for something that had already happened. */}
        <div className="form-floating">
          <input className="form-control" type="date" id="findDate" value={findDate}
                 onChange={(e) => setFindDate(e.target.value)} />
          <label htmlFor="findDate">Select Date</label>
        </div>

        <hr />

        <h4 style={{ fontWeight: 700, marginBottom: '1rem' }}>{history.label}</h4>

        {history.loading ? (
          <Loader variant="inline" label="Loading history" />
        ) : history.entries.length > 0 ? (
          <table className="table table-striped">
            <thead>
              <tr><th>Prayer</th><th>Status</th></tr>
            </thead>
            <tbody>
              {history.entries.map((entry, i) => (
                <tr key={`${entry.name}-${i}`}>
                  <td><strong>{entry.name}</strong></td>
                  <td><StatusBadge value={entry.value} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <span className="material-symbols-rounded">event_busy</span>
            <p>No salah records found for this date</p>
          </div>
        )}
      </div>
    </>
  );
}