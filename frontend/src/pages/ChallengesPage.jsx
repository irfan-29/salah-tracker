import { useCallback, useEffect, useState } from 'react';
import { challenges as api } from '../services/api';
import { useSession } from '../hooks/useSession.jsx';

// Markup mirrors views/challenges.ejs so the shared stylesheet applies.
export default function ChallengesPage() {
  const { isLoggedIn } = useSession();
  const [list, setList] = useState([]);
  const [canManage, setCanManage] = useState(false);
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
        <div className="container1"><p className="challenge-empty">Loading…</p></div>
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

  async function submitStreaks() {
    setSaving(true);
    setError('');
    try {
      // completedIds + date, matching POST /api/challenges/streaks, which
      // validates the date server-side before writing anything.
      const result = await api.saveStreaks({ completed, date });
      setList((result.challenges || []).map((c) => ({ ...c, _id: c.id })));
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
      const result = await api.create(name);
      setList((current) => [...current, result.challenge]);
      setDraft('');
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
      const result = await api.rename(editing, name);
      setList((current) => current.map((c) => (c._id === editing ? result.challenge : c)));
      setEditing(null);
      setDraft('');
    } catch (err) {
      setError('Could not rename that challenge.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    // Same confirmation the EJS form used, so the destructive action is never
    // one stray click away.
    if (!window.confirm('Delete this challenge?')) return;
    try {
      const result = await api.remove(id);
      setList(result.challenges || []);
    } catch (err) {
      setError('Could not delete that challenge.');
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Challenges</h1>
        <p>Build habits and track your streaks</p>
      </div>

      {canManage && (
        <div className="post-actions">
          <button type="button" className="btn btn-primary" onClick={() => { setEditing('__new__'); setDraft(''); }}>
            Add new challenge
          </button>
        </div>
      )}

      {editing && (
        <div className="container1">
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

      <div className="container1">
        {canManage && (
          <div className="form-floating">
            <input className="form-control" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            <label htmlFor="challenge-date">Date</label>
          </div>
        )}

        <div className="challenge-list" style={{ marginTop: '1.25rem' }}>
          {list.length === 0 && (
            <p className="challenge-empty">{canManage ? 'No challenges yet. Add one to start a streak.' : 'No challenges yet.'}</p>
          )}

          {list.map((challenge, i) => (
            <div className="challenge-card" data-challenge-id={challenge._id} key={challenge._id}>
              {canManage && (
                <input
                  type="checkbox"
                  checked={completed.includes(String(challenge._id))}
                  onChange={(e) => setCompleted((current) => e.target.checked
                    ? [...current, String(challenge._id)]
                    : current.filter((id) => id !== String(challenge._id)))}
                  id={`challenge_${i}`}
                />
              )}
              <div className="challenge-info">
                <div className="challenge-header-row">
                  <label htmlFor={`challenge_${i}`} className="challenge-title-label">
                    <strong>{challenge.challenge}</strong>
                  </label>
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
                <div style={{ marginTop: '0.5rem' }}>
                  <span className="streak-badge">🔥 {challenge.currentStreak || 0} day streak</span>
                  <span className="badge badge-accent">Best: {challenge.maxStreak || 0}</span>
                </div>
                <p className="challenge-meta">Last updated: {challenge.lastUpdated || '—'}</p>
              </div>
            </div>
          ))}
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