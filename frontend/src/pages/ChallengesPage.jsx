import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { challenges as api } from '../services/api';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { useSession } from '../hooks/useSession.jsx';
import Loader from '../components/Loader';
import DateField from '../components/DateField';

// Markup mirrors views/challenges.ejs so the shared stylesheet applies.
export default function ChallengesPage() {
  const { isLoggedIn } = useSession();
  const ask = useConfirm();
  const toast = useToast();
  const [list, setList] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [completed, setCompleted] = useState([]);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.list();
      setList(data.challenges || []);
      setCanManage(Boolean(data.canManage));
    } catch (err) {
      setError('Could not load your challenges.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // isLoggedIn is null until /api/session resolves. Rendering the list during
  // that window showed signed-out visitors "No challenges yet" instead of the
  // sign-in gate - the empty state silently answered a question the page had
  // not been told yet. Wait rather than guess.
  if (isLoggedIn === null) {
    return (
      <>
        <div className="page-header">
          <h1>Challenges</h1>
          <p>Build habits and track your streaks</p>
        </div>
        <Loader variant="inline" label="Loading challenges" />
      </>
    );
  }

  // Guests see the gate; the checkbox controls are not rendered at all rather
  // than rendered disabled, so there is nothing to accidentally submit.
  if (isLoggedIn === false) {
    return (
      <>
        <div className="page-header">
          <h1>Challenges</h1>
          <p>Build habits and track your streaks</p>
        </div>
        <div className="gate-notice">
          <span className="gate-icon material-symbols-rounded" aria-hidden="true">lock</span>
          <div className="gate-body">
            <h2 className="gate-title">Sign in to manage challenges</h2>
            <p className="gate-text">
              Adding, editing and deleting challenges needs an account so your streaks
              are saved to you and not lost. You can still browse everything else.
            </p>
            <div className="gate-actions">
              <a href="/login" className="btn btn-primary">Sign in to continue</a>
              <a href="/register" className="btn btn-outline">Create account</a>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <div className="page-header">
          <h1>Challenges</h1>
          <p>Build habits and track your streaks</p>
        </div>
        <Loader variant="inline" label="Loading challenges" />
      </>
    );
  }

  async function submitStreaks() {
    setSaving(true);
    setError('');
    try {
      // completedIds + date, matching POST /api/challenges/streaks, which
      // validates the date server-side before writing anything.
      await api.saveStreaks({ completed, date });
      // Reload instead of trusting the short save response: it omits the
      // challenge name and last-updated label, which blanked the cards.
      await load();
    } catch (err) {
      setError(err.status === 400 ? 'That date could not be read.' : 'Could not update streaks.');
    } finally {
      setSaving(false);
    }
  }

  async function create() {
    const name = draft.trim();
    if (!name) return;
    setSaving(true);
    try {
      await api.create(name);
      setDraft('');
      setEditing(null);
      await load();
      toast('Challenge added');
    } catch (err) {
      setError('Could not add that challenge.');
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit() {
    const name = draft.trim();
    if (!name || !editing) return;
    setSaving(true);
    try {
      await api.rename(editing, name);
      setEditing(null);
      setDraft('');
      await load();
      toast('Challenge renamed');
    } catch (err) {
      setError('Could not rename that challenge.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    // Same confirmation the EJS form used, so the destructive action is never
    // one stray click away - now as an in-app dialog instead of a browser
    // alert, which the installed app cannot show.
    const ok = await ask({
      title: 'Delete this challenge?',
      message: 'Its check-in history goes with it.',
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    try {
      await api.remove(id);
      await load();
      toast('Challenge deleted', { kind: 'delete' });
    } catch (err) {
      setError('Could not delete that challenge.');
    }
  }

  const bestCurrent = list.reduce((best, item) => Math.max(best, Number(item.currentStreak) || 0), 0);
  const bestEver = list.reduce((best, item) => Math.max(best, Number(item.maxStreak ?? item.currentStreak) || 0), 0);
  const activeCount = list.filter((item) => (Number(item.currentStreak) || 0) > 0).length;

  return (
    <>
      <div className="page-header page-header-with-action">
        <div>
          <h1>Challenges</h1>
          <p>Build habits and track your streaks</p>
        </div>
        <Link className="btn btn-outline" to="/stats">View detailed stats</Link>
      </div>

      {list.length > 0 && (
        <div className="challenge-consistency">
          <div className="challenge-consistency-head">
            <span className="challenge-consistency-eyebrow">Consistency</span>
            <span className="challenge-consistency-pill">
              {bestEver} {bestEver === 1 ? 'day' : 'days'} best
            </span>
          </div>
          <div className="challenge-consistency-body">
            <span className="challenge-consistency-flame material-symbols-rounded" aria-hidden="true">
              local_fire_department
            </span>
            <div className="challenge-consistency-copy">
              <strong>{bestCurrent}</strong>
              <span>day streak</span>
            </div>
            <div className="challenge-consistency-meta">
              <span>{list.length} {list.length === 1 ? 'challenge' : 'challenges'}</span>
              <span>{activeCount} active</span>
            </div>
          </div>
          <p className="challenge-consistency-hint">Small and steady beats big and brief.</p>
        </div>
      )}

      {canManage && (
        <div className="post-actions challenge-add-row">
          <button type="button" className="btn btn-primary" onClick={() => { setEditing('__new__'); setDraft(''); }}>
            Add new challenge
          </button>
        </div>
      )}

      {editing && (
        <div className="container1 challenge-panel">
          <div className="form-floating">
            <input
              className="form-control"
              type="text"
              value={draft}
              autoFocus
              placeholder="Read for 20 minutes"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') editing === '__new__' ? create() : saveEdit(); }}
            />
            <label>Challenge</label>
          </div>
          <div className="new-task" style={{ marginTop: '0.75rem' }}>
            <button type="button" className="btn btn-success" disabled={saving}
              onClick={() => editing === '__new__' ? create() : saveEdit()}>
              {editing === '__new__' ? 'Add' : 'Save'}
            </button>
            <button type="button" className="btn btn-outline" style={{ marginLeft: '0.5rem' }}
              onClick={() => { setEditing(null); setDraft(''); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div className="auth-alert" role="alert"><span className="material-symbols-rounded">error</span>{error}</div>}

      <div className="container1 challenge-panel">
        {canManage && (
          <DateField
            id="challenge-date"
            label="Date"
            value={date}
            onChange={(nextDate) => { setDate(nextDate); setCompleted([]); }}
          />
        )}

        <div className="challenge-list" style={{ marginTop: '1.25rem' }}>
          {list.length === 0 && (
            <div className="challenge-empty-state">
              <span className="challenge-empty-icon material-symbols-rounded" aria-hidden="true">local_fire_department</span>
              <strong>Start with one small habit.</strong>
              <p>{canManage
                ? 'Add a challenge above, then check in each day to build your streak.'
                : 'No challenges have been added yet.'}</p>
            </div>
          )}

          {list.map((challenge, i) => {
            const isDone = completed.includes(String(challenge._id));
            const streak = Number(challenge.currentStreak) || 0;
            const best = Number(challenge.maxStreak) || 0;
            return (
              <article
                className={`challenge-card${isDone ? ' is-done' : ''}`}
                data-challenge-id={challenge._id}
                key={challenge._id}
              >
                {canManage && (
                  <label className="challenge-check">
                    <input
                      type="checkbox"
                      checked={isDone}
                      aria-label={`Mark ${challenge.challenge} complete for this date`}
                      onChange={(e) => setCompleted((current) => e.target.checked
                        ? [...current, String(challenge._id)]
                        : current.filter((id) => id !== String(challenge._id)))}
                      id={`challenge_${i}`}
                    />
                    <span className="challenge-check-box" aria-hidden="true">
                      <span className="material-symbols-rounded">check</span>
                    </span>
                  </label>
                )}
                <div className="challenge-info">
                  <div className="challenge-header-row">
                    <div className="challenge-title-block">
                      <span className="challenge-card-eyebrow">Challenge</span>
                      <strong className="challenge-card-title">{challenge.challenge}</strong>
                    </div>
                    {canManage && (
                      <div className="challenge-actions">
                        <button
                          type="button"
                          className="challenge-icon-btn challenge-icon-btn-edit"
                          aria-label="Edit challenge"
                          title="Edit"
                          onClick={() => { setEditing(String(challenge._id)); setDraft(challenge.challenge); }}
                        >
                          <span className="material-symbols-rounded" aria-hidden="true">edit</span>
                        </button>
                        <button
                          type="button"
                          className="challenge-icon-btn challenge-icon-btn-danger"
                          aria-label="Delete challenge"
                          title="Delete"
                          onClick={() => remove(challenge._id)}
                        >
                          <span className="material-symbols-rounded" aria-hidden="true">delete</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="challenge-card-stats">
                    <span className="streak-badge">
                      <span className="material-symbols-rounded" aria-hidden="true">local_fire_department</span>
                      {streak} day streak
                    </span>
                    <span className="challenge-best-badge">Best {best}</span>
                    <span className="challenge-meta">Last updated: {challenge.lastUpdated || '—'}</span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        {canManage && list.length > 0 && (
          <div className="new-task" style={{ marginTop: '1.5rem' }}>
            <button type="button" className="btn btn-success" onClick={submitStreaks} disabled={saving}>
              {saving ? 'Saving…' : 'Update Streaks'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}