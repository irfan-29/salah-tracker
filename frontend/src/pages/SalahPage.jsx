import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { salah as api } from '../services/api';
import { useSession } from '../hooks/useSession.jsx';
import Loader from '../components/Loader';
import DateField from '../components/DateField';
import FormSelect from '../components/FormSelect';

const PRAYERS = ['Fajr', 'Zuhur', 'Asar', 'Magrib', 'Isha', 'others'];
const STATUSES = ['In Jamath', 'On Time', 'Late', 'Not Prayed', 'others'];
const CORE_PRAYERS = ['Fajr', 'Zuhur', 'Asar', 'Magrib', 'Isha'];

// The stored values predate the landing page's transliterations. Keep the
// stored API names and show the familiar English spellings.
const PRAYER_LABELS = {
  Fajr: 'Fajr',
  Zuhur: 'Dhuhr',
  Asar: 'Asr',
  Magrib: 'Maghrib',
  Isha: 'Isha',
};

// Only drives the row's icon and color - the displayed text is always the
// exact value the reader logged ("In Jamath" stays "In Jamath"), never a
// paraphrase.
const STATUS_META = {
  'In Jamath': { key: 'jamah', icon: 'groups' },
  'On Time': { key: 'ontime', icon: 'check_circle' },
  Late: { key: 'late', icon: 'schedule' },
  'Not Prayed': { key: 'missed', icon: 'cancel' },
};

const EMPTY_STATUS = { key: 'empty', icon: 'radio_button_unchecked' };

const today = () => new Date().toISOString().slice(0, 10);

function SalahRing({ completed, total }) {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const safeTotal = Math.max(Number(total) || 0, 1);
  const progress = Math.min(Math.max(Number(completed) || 0, 0), safeTotal) / safeTotal;

  return (
    <div className="salah-ring" role="img" aria-label={`${completed} of ${total} prayers logged`}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <defs>
          <linearGradient id="salah-ring-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#12a99b" />
            <stop offset="1" stopColor="#e6bd74" />
          </linearGradient>
        </defs>
        <circle className="salah-ring-track" cx="60" cy="60" r={radius} />
        <circle
          className="salah-ring-fill" cx="60" cy="60" r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
        />
      </svg>
      <div className="salah-ring-label">
        <strong>{completed}</strong>
        <span>/ {total}</span>
        <em>prayers</em>
      </div>
    </div>
  );
}

// Salah is account-only. Its overview shows the selected day's report, and
// saving an entry reloads that report without a second request.
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

  const statusByName = new Map(history.entries.map((entry) => [entry.name, entry.value]));
  const loggedCount = CORE_PRAYERS.filter((prayer) => {
    const status = statusByName.get(prayer);
    return status && status !== 'Not Prayed';
  }).length;

  return (
    <>
      <div className="page-header page-header-with-action">
        <div>
          <h1>Salah Tracker</h1>
          <p>Log and review your daily prayers</p>
        </div>
        {isLoggedIn && <Link className="btn btn-outline" to="/stats">View detailed stats</Link>}
      </div>

      {isLoggedIn && (
        <div className="container1 salah-overview">
          <div className="salah-overview-head">
            <div className="salah-overview-day">
              <span className="salah-overview-kicker">Selected day</span>
              <h2>{history.loading ? 'Loading…' : (history.label || 'Choose a date')}</h2>
            </div>
            {/*
              The drop arrow beside the date opens the app's own calendar and
              loads whichever day is picked - the same selection the old
              history card offered, without the duplicate card.
            */}
            <DateField
              id="selected-day"
              className="salah-day-picker"
              iconOnly
              triggerIcon="expand_more"
              value={findDate}
              onChange={setFindDate}
            />
            <span className="salah-overview-badge">{loggedCount} of 5 logged</span>
          </div>

          <div className="salah-overview-body">
            <SalahRing completed={loggedCount} total={CORE_PRAYERS.length} />
            <div className="salah-prayer-statuses">
              {CORE_PRAYERS.map((prayer) => {
                const status = statusByName.get(prayer);
                const meta = STATUS_META[status] || EMPTY_STATUS;
                return (
                  <div className={`salah-status is-${meta.key}`} key={prayer}>
                    <span className="salah-status-icon material-symbols-rounded" aria-hidden="true">{meta.icon}</span>
                    <span className="salah-status-name">{PRAYER_LABELS[prayer]}</span>
                    {/* The value as logged - never a paraphrase of it. */}
                    <span className="salah-status-value">{status || 'Not logged'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

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
            <div className="salah-form-grid">
              <DateField id="date" label="Date" value={date} onChange={setDate} />
              <FormSelect
                id="salah"
                label="Salah"
                value={name}
                onChange={setName}
                options={PRAYERS.map((p) => ({ value: p, label: p }))}
              />
              <FormSelect
                id="value"
                label="Status"
                value={value}
                onChange={setValue}
                options={STATUSES.map((s) => ({ value: s, label: s }))}
              />
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
    </>
  );
}