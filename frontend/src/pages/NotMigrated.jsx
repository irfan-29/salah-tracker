import { useLocation } from 'react-router-dom';

// Placeholder for pages that are still server-rendered. It navigates with a full
// page load on purpose, which sends the browser to the backend and lets the
// existing EJS routes serve it. The audio bar is lost for that one hop, which
// is the honest current state - until the page is ported, nothing better is
// available.
export default function NotMigrated() {
  const { pathname } = useLocation();

  return (
    <>
      <header className="page-header">
        <h1>Not migrated yet</h1>
        <p>{pathname}</p>
      </header>
      <div className="container1">
        <p className="post-empty">
          This page is still rendered by the backend. Opening it does a full page
          load, so audio will stop. The Quran module is the first to be ported.
        </p>
        <p>
          <a className="btn btn-primary" href={pathname}>Open the server-rendered page</a>
        </p>
      </div>
    </>
  );
}
