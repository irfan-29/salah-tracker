import { Link, useLocation } from 'react-router-dom';

const MAIN_LINKS = [
  { to: '/quran', label: 'Quran', icon: 'menu_book' },
  { to: '/salah', label: 'Salah Tracker', icon: 'checklist' },
  { to: '/salah-timings', label: 'Salah Timings', icon: 'schedule' },
  { to: '/calendar', label: 'Islamic Calendar', icon: 'calendar_month' },
  { to: '/challenges', label: 'Challenges', icon: 'emoji_events' },
  { to: '/posts', label: 'Posts', icon: 'favorite' },
];

const ACCOUNT_LINKS = [
  { to: '/account', label: 'Account', icon: 'account_circle' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export default function Navbar({ session }) {
  const { pathname } = useLocation();
  const handle = session.username || '';

  return (
    <nav className="app-nav">
      <div className="nav-brand">
        <span className="material-symbols-rounded">mosque</span>
        <div>
          <strong>Salah Tracker</strong>
          <small>Track · Pray · Grow</small>
        </div>
      </div>

      <div className="nav-group">
        <p className="nav-section-label">Main</p>
        <ul>
          {MAIN_LINKS.map((link) => (
            <li key={link.to}>
              <Link to={link.to} className={pathname === link.to ? 'active' : ''}>
                <span className="material-symbols-rounded">{link.icon}</span>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <div className="nav-group">
        <p className="nav-section-label">Account</p>
        <ul>
          {ACCOUNT_LINKS.map((link) => (
            <li key={link.to}>
              <Link to={link.to} className={pathname === link.to ? 'active' : ''}>
                <span className="material-symbols-rounded">{link.icon}</span>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <ul>
          {session.isLoggedIn ? (
            <>
              {handle && (
                <li className="nav-user">
                  <Link to="/account">
                    <span className="nav-avatar">{handle.charAt(0).toUpperCase()}</span>
                    <span className="nav-user-name">{handle}</span>
                  </Link>
                </li>
              )}
              <li>
                <form action="/logout" method="POST">
                  <button type="submit" className="nav-link">
                    <span className="material-symbols-rounded">logout</span>
                    Sign out
                  </button>
                </form>
              </li>
            </>
          ) : (
            <>
              <li>
                <a href="/login"><span className="material-symbols-rounded">login</span>Sign in</a>
              </li>
              <li>
                <a href="/register"><span className="material-symbols-rounded">person_add</span>Create account</a>
              </li>
            </>
          )}
        </ul>
      </div>
    </nav>
  );
}