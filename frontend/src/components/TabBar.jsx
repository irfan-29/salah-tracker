import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { createPortal } from 'react-dom';

// The phone navigation: a fixed five-slot footer like the native apps this
// shell replaces the drawer with. Four slots go straight to the busiest
// modules and the fifth ("More") opens a sheet with everything else, so no
// screen is more than one tap away and nothing depends on a hamburger.

const TABS = [
  { to: '/challenges', path: '/challenges', icon: 'emoji_events', label: 'Challenges' },
  { to: '/salah', path: '/salah', icon: 'checklist_rtl', label: 'Salah' },
  { to: '/quran', path: '/quran', icon: 'auto_stories', label: 'Quran', center: true },
  { to: '/posts', path: '/posts', icon: 'favorite', label: 'Posts' },
];

// Everything that did not earn a footer slot lives in the More sheet - one
// single-line row of three. Timings is not here because it wears the clock
// icon in the top bar beside the account.
const MORE = [
  { to: '/calendar', path: '/calendar', icon: 'calendar_month', label: 'Islamic Calendar' },
  { to: '/charity', path: '/charity', icon: 'volunteer_activism', label: 'Charity' },
  { to: '/stats', path: '/stats', icon: 'insights', label: 'Stats' },
];

// Same rule as the sidebar: exact match, and reading a surah keeps Quran lit.
function isActive(pathname, linkPath) {
  return pathname === linkPath || (linkPath === '/quran' && pathname.startsWith('/surah'));
}

export default function TabBar() {
  const { pathname } = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetRef = useRef(null);
  const moreBtnRef = useRef(null);

  // A route change closes the sheet, the same contract the drawer had.
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!sheetOpen) return undefined;
    const closeOnOutside = (event) => {
      // The sheet is portaled to <body>; the More button must count as inside,
      // or the pointerdown that closes the sheet is followed by the button's
      // own click and immediately re-opens it.
      if (!sheetRef.current?.contains(event.target) && !moreBtnRef.current?.contains(event.target)) {
        setSheetOpen(false);
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setSheetOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [sheetOpen]);

  const item = useCallback((tab) => (
    <Link
      key={tab.to}
      to={tab.to}
      className={`tabbar-item${isActive(pathname, tab.path) ? ' is-active' : ''}`}
      aria-current={isActive(pathname, tab.path) ? 'page' : undefined}
    >
      <span className="tabbar-icon material-symbols-rounded" aria-hidden="true">{tab.icon}</span>
      <span className="tabbar-label">{tab.label}</span>
    </Link>
  ), [pathname]);

  return (
    <>
      <nav className="tabbar" aria-label="App navigation">
        {TABS.map((tab) => (
          tab.center ? (
            <div className="tabbar-center" key={tab.to}>
              <Link
                to={tab.to}
                className={`tabbar-center-btn${isActive(pathname, tab.path) ? ' is-active' : ''}`}
                aria-label="Quran"
                aria-current={isActive(pathname, tab.path) ? 'page' : undefined}
              >
                <span className="material-symbols-rounded" aria-hidden="true">auto_stories</span>
              </Link>
              <span className={`tabbar-label${isActive(pathname, tab.path) ? ' is-active' : ''}`}>Quran</span>
            </div>
          ) : item(tab)
        ))}
        <button
          type="button"
          ref={moreBtnRef}
          className={`tabbar-item${sheetOpen ? ' is-open' : ''}`}
          aria-expanded={sheetOpen}
          aria-haspopup="dialog"
          onClick={() => setSheetOpen((open) => !open)}
        >
          <span className="tabbar-icon material-symbols-rounded" aria-hidden="true">more_horiz</span>
          <span className="tabbar-label">More</span>
        </button>
      </nav>

      {sheetOpen && createPortal(
        <>
          <div className="tabbar-sheet-scrim" aria-hidden="true" onPointerDown={() => setSheetOpen(false)} />
          <div
            ref={sheetRef}
            className="tabbar-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More modules"
          >
            <div className="tabbar-sheet-grip" aria-hidden="true" />
            <div className="tabbar-sheet-title">More modules</div>
            <div className="tabbar-sheet-grid">
              {MORE.map((tab) => (
                <Link
                  key={tab.to}
                  to={tab.to}
                  className={`tabbar-sheet-item${isActive(pathname, tab.path) ? ' is-active' : ''}`}
                >
                  <span className="tabbar-sheet-tile">
                    <span className="material-symbols-rounded" aria-hidden="true">{tab.icon}</span>
                  </span>
                  <span className="tabbar-sheet-label">{tab.label}</span>
                </Link>
              ))}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
