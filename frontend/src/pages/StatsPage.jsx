import { useCallback, useEffect, useState } from 'react';
import { stats as api } from '../services/api';
import { useSession } from '../hooks/useSession.jsx';
import Loader from '../components/Loader';

const money = (value) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(Number(value) || 0);

// Bars are pure CSS, not a chart library. Keeping it on the stylesheet means
// the same dark/light tokens and the same typography as every other report.
function StatTile({ label, value, meta }) {
  return (
    <div className="stats-tile">
      <span className="stats-tile-label">{label}</span>
      <strong className="stats-tile-value">{value}</strong>
      {meta && <span className="stats-tile-meta">{meta}</span>}
    </div>
  );
}

// Segmented bar showing the proportion of each status inside one prayer's
// history. Widths are percentages of the prayer's own total, so "2 good out of
// 4 entries" and "20 out of 40" both fill the same bar correctly.
function PrayerBar({ prayer }) {
  const total = prayer.entries || 0;
  const safe = Math.max(total, 1);
  const cells = [
    { key: 'good', value: prayer.good, label: 'On time / Jamah' },
    { key: 'late', value: prayer.late, label: 'Late' },
    { key: 'missed', value: prayer.missed, label: 'Not prayed' },
    { key: 'other', value: prayer.other, label: 'Other' }
  ].filter((cell) => cell.value > 0);

  return (
    <div className="stats-prayer-row">
      <span className="stats-prayer-name">{prayer.prayer}</span>
      <div className="stats-bar" role="figure" aria-label={`${prayer.prayer} status breakdown`}>
        {cells.map((cell) => (
          <span key={cell.key} className={`stats-bar-cell stats-bar-${cell.key}`}
                style={{ width: `${(cell.value / safe) * 100}%` }}
                title={`${cell.value} ${cell.label}`} />
        ))}
        {cells.length === 0 && <span className="stats-bar-cell stats-bar-empty" title="No entries logged" />}
      </div>
      <span className="stats-prayer-amount">
        <strong>{prayer.good}</strong>/ {total}
        <em>{prayer.rate}% on time</em>
      </span>
    </div>
  );
}

// Charity month chart: horizontal bars are more readable on a phone than a
// vertical axis and don't need a separate charting dependency.
function CharityChart({ monthly }) {
  const labels = monthly?.labels || [];
  const amounts = monthly?.amounts || [];
  const max = Math.max(...amounts, 1);

  return (
    <div className="stats-month-chart">
      {labels.map((label, i) => (
        <div className="stats-month-row" key={label}>
          <span className="stats-month-label">{label}</span>
          <div className="stats-bar">
            <span className="stats-bar-cell stats-bar-charity" style={{ width: `${Math.max(amounts[i] / max, 0)}%` }} />
          </div>
          <span className="stats-month-amount">{money(amounts[i])}</span>
        </div>
      ))}
    </div>
  );
}

function ChallengeCard({ challenge }) {
  const current = Number(challenge.currentStreak) || 0;
  const best = Number(challenge.storedBest) || 0;
  const safe = Math.max(best, 1);
  const percent = Math.min((current / safe) * 100, 100);

  return (
    <article className="stats-challenge-card">
      <strong className="stats-challenge-name">{challenge.name}</strong>
      <div className="stats-challenge-numbers">
        <span><strong>{current}</strong> current</span>
        <span><strong>{best}</strong> best</span>
        <span><strong>{challenge.historyCount}</strong> total check-ins</span>
      </div>
      <div className="stats-bar" aria-hidden="true">
        <span className="stats-bar-cell stats-bar-challenge" style={{ width: `${percent}%` }} />
      </div>
      {challenge.lastUpdated && <span className="stats-challenge-date">Last updated {challenge.lastUpdated}</span>}
    </article>
  );
}

export default function StatsPage() {
  const { isLoggedIn } = useSession();
  const [range, setRange] = useState(30);
  const [charityMonths, setCharityMonths] = useState(6);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (selectedDays, selectedMonths) => {
    setLoading(true);
    try {
      const payload = await api.get({ days: selectedDays, charityMonths: selectedMonths });
      setData(payload);
      setError('');
    } catch (err) {
      setError('Could not build the stats report.');
    } finally {
      setLoading(false);
    }
  }, []);

  //isLoggedIn is not known until the shell's boot call resolves. Querying
  // before that can show the sign-in gate to a signed-in person for a moment,
  // or fire a 401 request for a guest.
  useEffect(() => {
    if (isLoggedIn) load(range, charityMonths);
  }, [isLoggedIn, range, charityMonths, load]);

  if (isLoggedIn === null) {
    return (
      <>
        <div className="page-header"><h1>Stats</h1><p>See where your practice is heading</p></div>
        <Loader variant="page" label="Building report" />
      </>
    );
  }

  if (!isLoggedIn) {
    return (
      <>
        <div className="page-header"><h1>Stats</h1><p>See where your practice is heading</p></div>
        <div className="container1">
          <div className="gate-notice">
            <span className="gate-icon material-symbols-rounded" aria-hidden="true">lock</span>
            <div className="gate-body">
              <h2 className="gate-title">Sign in to see your stats</h2>
              <p className="gate-text">
                Salah, challenge and charity reports are built from your own history.
                Sign in to view them.
              </p>
              <div className="gate-actions">
                <a href="/login" className="btn btn-primary">Sign in to continue</a>
                <a href="/register" className="btn btn-outline">Create account</a>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  const salah = data?.salah;
  const challenges = data?.challenges;
  const charity = data?.charity;

  return (
    <>
      <div className="page-header stats-page-header">
        <div>
          <h1>Stats</h1>
          <p>A visual report across your Salah, challenge and charity record</p>
        </div>
        <div className="stats-range-chips" role="tablist" aria-label="Report range">
          {[30, 60, 90].map((days) => (
            <button
              key={days}
              type="button"
              className={`stats-range-chip${range === days ? ' is-active' : ''}`}
              onClick={() => setRange(days)}
            >
              Last {days} days
            </button>
          ))}
          <button
            type="button"
            className={`stats-range-chip${charityMonths === 12 ? ' is-active' : ''}`}
            onClick={() => setCharityMonths(charityMonths === 12 ? 6 : 12)}
          >
            12-month charity
          </button>
        </div>
      </div>

      {error && <div className="auth-alert"><span className="material-symbols-rounded">error</span>{error}</div>}

      {loading && !data ? (
        <Loader variant="page" label="Building report" />
      ) : (
        <>
          {/* --- Salah --- */}
          <section className="container1 stats-section">
            <div className="stats-section-head">
              <h2>Salah</h2>
              <span className="stats-section-meta">Last {salah?.days || range} days</span>
            </div>
            <div className="stats-tile-grid">
              <StatTile label="On-time rate" value={`${salah?.summary?.onTimeRate ?? 0}%`} />
              <StatTile label="Active days" value={salah?.summary?.activeDays ?? 0} />
              <StatTile label="Perfect days" value={salah?.summary?.perfectDays ?? 0} />
              <StatTile label="Current streak" value={salah?.summary?.streaks?.current ?? 0} />
              <StatTile label="Best streak" value={salah?.summary?.streaks?.best ?? 0} />
            </div>

            <div className="stats-chart-title">Per-prayer breakdown</div>
            <div className="stats-prayer-grid">
              {(salah?.prayers || []).map((prayer) => <PrayerBar key={prayer.prayer} prayer={prayer} />)}
            </div>
          </section>

          {/* --- Challenges --- */}
          <section className="container1 stats-section">
            <div className="stats-section-head">
              <h2>Challenges</h2>
              <span className="stats-section-meta">Streaks &amp; recent check-ins</span>
            </div>
            <div className="stats-tile-grid">
              <StatTile label="Total" value={challenges?.summary?.total ?? 0} />
              <StatTile label="Active" value={challenges?.summary?.active ?? 0} />
              <StatTile label="Best streak" value={challenges?.summary?.bestStreak ?? 0} />
              <StatTile label="Recent check-ins" value={challenges?.summary?.recentCheckInTotal ?? 0} />
            </div>

            {challenges?.challenges?.length ? (
              <div className="stats-challenge-grid">
                {challenges.challenges.map((challenge) => <ChallengeCard key={challenge.id} challenge={challenge} />)}
              </div>
            ) : (
              <div className="stats-empty-note">No challenges yet. Add one from the Challenges module.</div>
            )}
          </section>

          {/* --- Charity --- */}
          <section className="container1 stats-section">
            <div className="stats-section-head">
              <h2>Charity</h2>
              <span className="stats-section-meta">Last {charity?.months || charityMonths} months</span>
            </div>
            <div className="stats-tile-grid">
              <StatTile label="Total given" value={money(charity?.summary?.amount)} />
              <StatTile label="Goals" value={charity?.summary?.goals ?? 0} />
              <StatTile label="Donations" value={charity?.summary?.donations ?? 0} />
              <StatTile label="Average per goal" value={money(charity?.summary?.avgPerGoal)} />
            </div>

            <div className="stats-chart-title">Monthly giving</div>
            <CharityChart monthly={charity?.monthly} />
          </section>

          {/* --- Recent charity transactions --- */}
          {charity?.recent?.length > 0 && (
            <section className="container1 stats-section">
              <div className="stats-section-head">
                <h2>Recent giving</h2>
                <span className="stats-section-meta">Newest first</span>
              </div>
              <ul className="stats-donation-list">
                {charity.recent.map((entry, i) => (
                  <li key={`${entry.date}-${i}`} className="stats-donation-row">
                    <span className="stats-donation-charity">{entry.charity}</span>
                    <span className="stats-donation-amount">{money(entry.amount)}</span>
                    <span className="stats-donation-date">{entry.date}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
