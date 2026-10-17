import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import Loader from '../components/Loader';

// Markup mirrors views/account.ejs (.account-card, .account-avatar,
// .account-handle, .username-input, .tg-hint).
export default function AccountPage() {
  const [state, setState] = useState({ loading: true, data: null });
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get('/account');
      setState({ loading: false, data });
      setUsername(data.username || '');
    } catch (err) {
      setState({ loading: false, data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true); setError(''); setSaved(false);
    try {
      await api.post('/settings/username', { username });
      await load();
      setSaved(true);
    } catch (err) {
      // The server returns the message in the redirect's ?un= parameter for the
      // EJS form; the JSON route answers with { error } instead.
      setError(err.body?.error || 'Could not update your username.');
    } finally {
      setSaving(false);
    }
  }

  if (state.loading) return <Loader variant="page" label="Loading account" />;
  if (!state.data) {
    return <><div className="page-header"><h1>Account</h1></div>
      <div className="container1"><p className="post-empty">Sign in to view your account.</p></div></>;
  }

  const d = state.data;

  return (
    <>
      <div className="page-header">
        <h1>Account</h1>
        <p>Your identity in Salah Tracker</p>
      </div>

      {(error || saved) && (
        <div className={`auth-alert${saved && !error ? ' auth-alert-ok' : ''}`} role={error ? 'alert' : 'status'}>
          <span className="material-symbols-rounded">{error ? 'error' : 'check_circle'}</span>
          {error || 'Username updated.'}
        </div>
      )}

      <section className="account-card">
        <div className="account-avatar" aria-hidden="true">{d.displayName.charAt(0).toUpperCase()}</div>
        <div className="account-body">
          <div className="account-handle">{d.displayName}</div>
          <div className="account-sub">
            {d.username ? (
              <a href={`/u/${d.username}`} target="_blank" rel="noreferrer">/u/{d.username}</a>
            ) : (
              'No username yet - set one below to get a shareable profile link.'
            )}
          </div>
        </div>
      </section>

      <section className="account-card">
        <div className="account-field">
          <label className="account-label" htmlFor="inputUsername">Username</label>
          <p className="account-hint">
            This is your public handle. It appears on your posts and is how people
            find you at <code>/u/&lt;username&gt;</code>. Changing it breaks links
            people have already shared.
          </p>
          <div className="username-input">
            <input className="form-control" type="text" name="username" id="inputUsername"
                   value={username} placeholder="your-name"
                   pattern="[a-zA-Z0-9._]{3,30}" maxLength={30}
                   autoComplete="off" autoCapitalize="none" spellCheck="false"
                   onChange={(e) => { setUsername(e.target.value); setSaved(false); setError(''); }} />
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
              <span className="material-symbols-rounded">check</span>
              {saving ? 'Saving…' : 'Update'}
            </button>
          </div>
        </div>
      </section>

      <section className="account-card">
        <div className="account-field">
          <label className="account-label">Email address</label>
          <p className="account-hint">
            {d.verified ? (
              <span className="account-verified">
                <span className="material-symbols-rounded">verified</span> Verified
              </span>
            ) : (
              <span className="account-unverified">
                <span className="material-symbols-rounded">info</span> Not verified
              </span>
            )}
            {d.verified ? '' : ' — this address predates email verification.'}
          </p>
          <div className="account-value">{d.email}</div>
          <p className="account-hint">
            Your email is only used to sign in and to receive verification codes. It is
            never shown on your posts or your public profile.
          </p>
        </div>
      </section>
    </>
  );
}
