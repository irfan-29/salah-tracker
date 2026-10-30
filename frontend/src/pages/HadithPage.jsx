import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hadiths } from '../services/api';
import Loader from '../components/Loader';

// The Hadith module's front door: every collection on one grid. Class names
// reuse the surah grid so the two lists can never drift apart visually.
export default function HadithPage() {
  const [collections, setCollections] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    hadiths.collections()
      .then((data) => { if (!cancelled) setCollections(data.collections || []); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the collections.'); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <><div className="page-header"><h1>Hadith</h1></div><div className="container1"><p className="post-empty">{error}</p></div></>;
  if (!collections) return <Loader variant="page" label="Loading collections" />;

  return (
    <>
      <div className="page-header">
        <h1>Hadith</h1>
        <p>The sayings of the Prophet Muhammad ﷺ from the major collections</p>
      </div>

      <div className="container1">
        <div className="card-header">
          <h3>Collections</h3>
          <span className="badge badge-primary">{collections.length} Books</span>
        </div>
        <div className="surah-grid">
          {collections.map((c, i) => (
            <Link key={c.id} to={`/hadith/${c.id}`} className="surah-card">
              <span className="surah-card-number">{i + 1}</span>
              <div className="surah-card-content">
                <p className="surah-name">{c.name}</p>
                <p className="surah-translation">{c.translator}</p>
                <p className="surah-meta">Arabic · English</p>
              </div>
              <span className="material-symbols-rounded surah-card-arrow">chevron_right</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
