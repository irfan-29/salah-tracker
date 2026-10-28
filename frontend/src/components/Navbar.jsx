import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { api } from '../services/api';

// Emits the same markup and class names as views/navbar.ejs, so the shared
// stylesheet applies unchanged. The first React version defined a parallel set
// of class names, which is why it looked like a different site.

const PRIMARY = [
  { to: '/quran', path: '/quran', icon: 'auto_stories', label: 'Quran' },
  { to: '/salah', path: '/salah', icon: 'checklist_rtl', label: 'Salah Tracker' },
  { to: '/salah-timings', path: '/salah-timings', icon: 'schedule', label: 'Salah Timings' },
  { to: '/calendar', path: '/calendar', icon: 'calendar_month', label: 'Islamic Calendar' },
  { to: '/challenges', path: '/challenges', icon: 'emoji_events', label: 'Challenges' },
  { to: '/charity', path: '/charity', icon: 'volunteer_activism', label: 'Charity' },
  { to: '/stats', path: '/stats', icon: 'insights', label: 'Stats' },
  { to: '/posts', path: '/posts', icon: 'favorite', label: 'Posts' },
];

const ACCOUNT = [
  { to: '/account', path: '/account', icon: 'account_circle', label: 'Account' },
  { to: '/settings', path: '/settings', icon: 'settings', label: 'Settings' },
];

// Same rule as the EJS script: exact match, plus the reader counting as part of
// Quran so the section stays highlighted while reading an ayah.
function isActive(pathname, linkPath) {
  return pathname === linkPath || (linkPath === '/quran' && pathname.startsWith('/surah'));
}

export default function Navbar({ session }) {
  const { pathname } = useLocation();
  const sidebarRef = useRef(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountBtnRef = useRef(null);

  const handle = session.username || '';

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout', {});
    } catch (err) {
      // A failed sign-out must not leave the user believing they are signed out,
      // so fall through to a reload anyway and let the server decide.
    }
    // Full reload, not a route change: signing out has to reset everything the
    // session owned (the audio player, in-flight page state), and the shell
    // re-reads /api/app/meta from scratch on load.
    window.location.href = '/';
  }, []);

  // A route change closes the phone account menu, the same contract the drawer
  // had: tap a destination and the chrome gets out of the way.
  useEffect(() => {
    setAccountOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!accountOpen) return undefined;
    const closeOnOutside = (event) => {
      if (!accountBtnRef.current?.contains(event.target)) setAccountOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setAccountOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [accountOpen]);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return undefined;

    const sidebarToggler = sidebar.querySelector('.sidebar-toggler');
    const onCollapse = () => sidebar.classList.toggle('collapsed');

    if (sidebarToggler) sidebarToggler.addEventListener('click', onCollapse);
    return () => {
      if (sidebarToggler) sidebarToggler.removeEventListener('click', onCollapse);
    };
  }, []);

  const link = (item) => (
    <li className="nav-item" key={item.to}>
      <Link to={item.to} className={`nav-link${isActive(pathname, item.path) ? ' active' : ''}`} data-path={item.path}>
        <span className="nav-icon material-symbols-rounded">{item.icon}</span>
        <span className="nav-label">{item.label}</span>
      </Link>
      <span className="nav-tooltip">{item.label}</span>
    </li>
  );

  return (
    <aside className="sidebar" ref={sidebarRef}>
      <header className="sidebar-header">
        {/* The brand goes to the app's home, not the marketing page: a guest who is
              already inside should stay inside. The landing page has its own
              brand link. */}
        <Link to={session.homePath || '/quran'} className="header-logo">
          <div className="logo-icon">
            <span className="material-symbols-rounded">mosque</span>
          </div>
          <div className="logo-text">
            <h5>Hasanath</h5>
            <span>Track · Pray · Grow</span>
          </div>
        </Link>
        <button type="button" className="sidebar-toggler" aria-label="Toggle sidebar">
          <span className="material-symbols-rounded">chevron_left</span>
        </button>

        {/* Phone chrome: settings and the account wear the top-right corner the
            hamburger used to hold. The drawer itself is gone - the fixed
            footer (TabBar) carries the modules now. */}
        <div className="header-actions">
          <Link to="/settings" className="header-action-btn" aria-label="Settings">
            <span className="material-symbols-rounded" aria-hidden="true">settings</span>
          </Link>

          {session.isLoggedIn ? (
            <div className="header-account" ref={accountBtnRef}>
              <button
                type="button"
                className="header-account-btn"
                aria-label={`Account menu for ${handle}`}
                aria-expanded={accountOpen}
                aria-haspopup="dialog"
                onClick={() => setAccountOpen((open) => !open)}
              >
                <span className="nav-avatar" aria-hidden="true">{(handle || '?').charAt(0).toUpperCase()}</span>
              </button>

              {accountOpen && createPortal(
                <div className="header-account-menu" role="dialog" aria-label="Account menu">
                  <div className="header-account-head">
                    <span className="header-account-emoji" aria-hidden="true">🌙</span>
                    <span className="header-account-title">{handle}</span>
                  </div>
                  <Link to="/account" className="header-account-item">
                    <span className="material-symbols-rounded" aria-hidden="true">account_circle</span>
                    Account
                  </Link>
                  <button type="button" className="header-account-item" onClick={signOut}>
                    <span className="material-symbols-rounded" aria-hidden="true">logout</span>
                    Sign out
                  </button>
                </div>,
                document.body,
              )}
            </div>
          ) : (
            <div className="header-guest">
              <a href="/login" className="header-guest-btn is-primary">Sign in</a>
              <a href="/register" className="header-guest-btn">Create account</a>
            </div>
          )}
        </div>
      </header>

      <nav className="sidebar-nav">
        <div className="nav-section-label">Main</div>
        <ul className="nav-list primary-nav">
          {PRIMARY.map(link)}
        </ul>

        <div className="nav-section-label">Account</div>
        <ul className="nav-list secondary-nav">
          {ACCOUNT.map(link)}

          {session.isLoggedIn ? (
            <>
              <li className="nav-item nav-user-chip">
                <div className="nav-user">
                  <span className="nav-avatar">{(handle || '?').charAt(0).toUpperCase()}</span>
                  <span className="nav-label nav-user-name">{handle}</span>
                </div>
              </li>
              {/* Posts to /api/auth/logout, not /logout. The frontend only
                  forwards /api/* to the backend, so a plain form action would
                  be answered by the SPA catch-all with index.html and Sign out
                  would appear to do nothing. */}
              <li className="nav-item">
                <button type="button" className="nav-link nav-logout" onClick={signOut}>
                  <span className="nav-icon material-symbols-rounded">logout</span>
                  <span className="nav-label">Sign out</span>
                </button>
                <span className="nav-tooltip">Sign out</span>
              </li>
            </>
          ) : (
            <>
              <li className="nav-item">
                <a href="/login" className="nav-link" data-path="/login">
                  <span className="nav-icon material-symbols-rounded">login</span>
                  <span className="nav-label">Sign in</span>
                </a>
                <span className="nav-tooltip">Sign in</span>
              </li>
              <li className="nav-item">
                <a href="/register" className="nav-link" data-path="/register">
                  <span className="nav-icon material-symbols-rounded">person_add</span>
                  <span className="nav-label">Create account</span>
                </a>
                <span className="nav-tooltip">Create account</span>
              </li>
            </>
          )}
        </ul>
      </nav>
    </aside>
  );
}
