import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import Loader from '../components/Loader';
import FormSelect from '../components/FormSelect';

// Markup mirrors views/salah-timings.ejs.
const LOCATIONS = ['Coimbatore', 'Hosur', 'Salem', 'Ramanathapuram', 'Bengaluru'];

export default function SalahTimingsPage() {
  const [state, setState] = useState({ loading: true, location: '', details: null });
  const [error, setError] = useState('');

  const load = useCallback(async (location) => {
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const target = location ? `/salah-timings?location=${encodeURIComponent(location)}` : '/salah-timings';
      const data = await api.get(target);
      setState({ loading: false, location: data.location, details: data.details, error: '' });
    } catch (err) {
      setState({ loading: false, location: '', details: null });
      setError('Could not load prayer times.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function changeLocation(value) {
    try {
      // Saved first so the setting and the displayed times cannot disagree on
      // the next visit; the widget is re-fetched for the new location.
      await api.post('/settings', { location: value });
      await load(value);
    } catch (err) {
      setError('Could not change location.');
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Salah Timings</h1>
        <p>Prayer times for {state.details ? state.details.location : 'your location'}</p>
      </div>

      {state.loading ? <Loader variant="inline" label="Loading prayer times" /> : state.details ? (
        <>
          <div className="prayer-meta">
            <h2>{state.details.date}</h2>
            <p>{state.details.hijriDate}</p>
          </div>

          <div className="prayer-grid">
            {state.details.prayerTimes.map((prayer, i) => (
              <div className="prayer-card" key={`${prayer.timeType}-${i}`}>
                <div className="prayer-name">{prayer.timeType}</div>
                <div className="prayer-time">{prayer.time}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="container1"><p className="post-empty">{error || 'No prayer times available.'}</p></div>
      )}

      <div className="container1">
        <div className="card-header"><h3>Change Location</h3></div>
        <div className="form-row">
          <FormSelect
            id="timings-location"
            label="Location"
            value={state.location || ''}
            disabled={state.loading}
            onChange={changeLocation}
            options={LOCATIONS.map((location) => ({ value: location, label: location }))}
          />
          <button type="button" className="btn btn-primary" disabled>Update</button>
        </div>
      </div>
    </>
  );
}
