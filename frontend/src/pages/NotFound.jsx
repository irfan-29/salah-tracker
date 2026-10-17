// 404 within the React app. Distinct from NotMigrated, which explains that a
// page exists but has not been ported yet - this one means there is nothing at
// this address at all.
export default function NotFound() {
  return (
    <>
      <div className="page-header">
        <h1>Page not found</h1>
        <p>There is nothing at this address.</p>
      </div>
      <div className="container1">
        <div className="empty-state">
          <span className="material-symbols-rounded">search_off</span>
          <p>The page you asked for does not exist.</p>
        </div>
        <div className="new-task">
          <a className="btn btn-primary" href="/quran">Go to Quran</a>
        </div>
      </div>
    </>
  );
}