import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
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
  const menuTogglerRef = useRef(null);

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

  // On phones the nav is a full-height drawer. A route change should leave it
  // closed; otherwise every tap on a page leaves the drawer covering the page
  // the visitor just asked for.
  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    sidebar.classList.remove('menu-active');
    const icon = sidebar.querySelector('.menu-toggler span');
    if (icon) icon.textContent = 'menu';
  }, [pathname]);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return undefined;

    const sidebarToggler = sidebar.querySelector('.sidebar-toggler');
    const menuToggler = sidebar.querySelector('.menu-toggler');

    const onCollapse = () => sidebar.classList.toggle('collapsed');
    const onMenu = () => {
      sidebar.classList.toggle('menu-active');
      const icon = menuToggler && menuToggler.querySelector('span');
      if (icon) icon.textContent = sidebar.classList.contains('menu-active') ? 'close' : 'menu';
    };
    const onResize = () => {
      if (window.innerWidth >= 1024) {
        sidebar.classList.remove('menu-active');
        const icon = menuToggler && menuToggler.querySelector('span');
        if (icon) icon.textContent = 'menu';
      }
    };

    if (sidebarToggler) sidebarToggler.addEventListener('click', onCollapse);
    if (menuToggler) menuToggler.addEventListener('click', onMenu);
    window.addEventListener('resize', onResize);

    return () => {
      if (sidebarToggler) sidebarToggler.removeEventListener('click', onCollapse);
      if (menuToggler) menuToggler.removeEventListener('click', onMenu);
      window.removeEventListener('resize', onResize);
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
        <button type="button" className="menu-toggler" ref={menuTogglerRef} aria-label="Toggle menu">
          <span className="material-symbols-rounded">menu</span>
        </button>
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