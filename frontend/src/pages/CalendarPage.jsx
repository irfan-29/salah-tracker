import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import Loader from '../components/Loader';
import FormSelect from '../components/FormSelect';

// Markup mirrors views/calendar.ejs.
export default function CalendarPage() {
  const [state, setState] = useState({ loading: true, data: null });
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');

  const load = useCallback(async (m, y) => {
    setState((s) => ({ ...s, loading: true }));
    const query = (m && y) ? `?month=${m}&year=${y}` : '';
    try {
      const data = await api.get('/calendar' + query);
      setState({ loading: false, data });
      // The dropdowns reflect what was actually loaded, not what was asked for -
      // an omitted month resolves to the current one server-side.
      setMonth(String(data.hijriMonthNumber));
      setYear(String(data.hijriYear));
    } catch (err) {
      setState({ loading: false, data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const d = state.data;

  return (
    <>
      <div className="page-header">
        <h1>Islamic Calendar</h1>
        <p>Hijri &amp; Gregorian dates with special Islamic days</p>
      </div>

      {state.loading && !d ? <Loader variant="inline" label="Loading calendar" /> : d ? (
        <>
          <div className="container1 calendar-wrapper">
            <div className="calendar-header">
              <div className="gregorian-title">{d.gregorianMonth} {d.gregorianYear}</div>
              <div className="hijri-title">{d.hijriMonth} {d.hijriYear} AH</div>
            </div>

            <div className="calendar-controls">
              <button type="button" className="btn-ghost btn-icon" aria-label="Previous month"
                      onClick={() => load(Number(month) === 1 ? 12 : Number(month) - 1, Number(month) === 1 ? Number(year) - 1 : year)}>
                <span className="material-symbols-rounded">chevron_left</span>
              </button>
              <FormSelect
                compact
                ariaLabel="Month"
                value={month}
                onChange={setMonth}
                options={Array.from({ length: 12 }, (_, i) => ({
                  value: String(i + 1),
                  label: String(i + 1),
                }))}
              />
              <input type="number" value={year} onChange={(e) => setYear(e.target.value)} />
              <button type="button" className="btn btn-primary btn-sm" onClick={() => load(Number(month), Number(year))}>Go</button>
              <button type="button" className="btn-ghost btn-icon" aria-label="Next month"
                      onClick={() => load(Number(month) === 12 ? 1 : Number(month) + 1, Number(month) === 12 ? Number(year) + 1 : year)}>
                <span className="material-symbols-rounded">chevron_right</span>
              </button>
            </div>

            <table className="calendar-table">
              <thead>
                <tr>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((dow) => <th key={dow}>{dow}</th>)}</tr>
              </thead>
              <tbody>
                {d.weeks.map((week, wi) => (
                  <tr key={wi}>
                    {week.map((day, di) => (
                      <td key={di}>
                        {day ? (
                          <div className="date-box">
                            <div className="greg">{day.gregorian}</div>
                            <div className="hijri">{day.hijri}</div>
                          </div>
                        ) : (
                          <span style={{ display: 'block', height: '100%' }} />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Table markup copied from views/calendar.ejs so the existing
              .badge-info / table styles apply. My first pass invented
              .special-day classes the stylesheet has never heard of. */}
          <div className="container1">
            <table className="table table-striped">
              <thead>
                <tr><th>Date</th><th>Event</th><th>Hijri Date</th></tr>
              </thead>
              <tbody>
                {d.specialDays.map((day, i) => (
                  <tr key={`${day.date}-${i}`}>
                    <td>{day.date}<br /><span className="badge badge-info">{day.weekday}</span></td>
                    <td><strong>{day.event}</strong></td>
                    <td><em>{day.hijriDate}<br />{day.hijriYear}</em></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="container1"><p className="post-empty">Could not load the calendar.</p></div>
      )}
    </>
  );
}
