import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../services/api';
import { useSession } from '../hooks/useSession.jsx';
import Loader from '../components/Loader';

// Map the username route's error codes to plain sentences - the raw codes
// ("taken", "invalid-username") are for programs, not for people.
const USERNAME_ERRORS = {
  taken: 'That username is already in use. Try another.',
  'invalid-username': 'Usernames are 3-30 letters, numbers, dots or underscores.',
  reserved: 'That username is reserved. Try another.'
};

// Markup mirrors views/account.ejs (.account-card, .account-avatar,
// .account-handle, .username-input, .tg-hint).
export default function AccountPage() {
  const [state, setState] = useState({ loading: true, data: null });
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  // Deleting runs in its own small modal (password first), not the shared
  // confirm dialog: it needs an input, and a mis-tap here costs everything.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const { refresh } = useSession();
  const navigate = useNavigate();

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
      setError(USERNAME_ERRORS[err.body?.error] || 'Could not update your username.');
    } finally {
      setSaving(false);
    }
  }

  const closeDelete = () => {
    setDeleteOpen(false);
    setPassword('');
    setDeleteError('');
  };

  async function deleteAccount(event) {
    event.preventDefault();
    if (deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await api.delete('/account', { password });
      // The session record is destroyed server-side; drop the cached copy and
      // land on the public landing page.
      await refresh();
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === 'wrong-password') {
        setDeleteError('That password is not correct.');
      } else if (err instanceof ApiError && err.body?.error === 'password-required') {
        setDeleteError('Enter your password to continue.');
      } else {
        setDeleteError('Could not delete the account. Try again.');
      }
      setDeleting(false);
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
        <p>Your identity in Hasanath</p>
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

      <section className="account-danger">
        <h3><span className="material-symbols-rounded">delete_forever</span> Delete account</h3>
        <p>
          This erases everything - your salah record, challenges, charity goals and
          donations, posts, and this very account. It cannot be undone and it cannot
          be recovered.
        </p>
        <button type="button" className="btn btn-danger-outline" onClick={() => setDeleteOpen(true)}>
          Delete my account
        </button>
      </section>

      {deleteOpen && (
        <div className="confirm-overlay" role="presentation">
          <form className="confirm-card" role="alertdialog" aria-modal="true" aria-label="Delete account"
                onSubmit={deleteAccount} onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-title">Delete your account?</h3>
            <p className="confirm-message">
              Everything goes - salah history, challenges, charity, posts. Confirm your
              password to prove it is you.
            </p>
            <input
              className="form-control"
              type="password"
              name="password"
              value={password}
              autoComplete="current-password"
              placeholder="Your password"
              autoFocus
              onChange={(e) => { setPassword(e.target.value); setDeleteError(''); }}
              style={{ marginTop: '0.9rem' }}
            />
            {deleteError && (
              <p className="confirm-message" role="alert" style={{ color: 'var(--color-danger)' }}>
                {deleteError}
              </p>
            )}
            <div className="confirm-actions">
              <button type="button" className="btn btn-outline" onClick={closeDelete}>Cancel</button>
              <button type="submit" className="btn btn-danger" disabled={deleting || !password}>
                {deleting ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
