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

// Per-module filter: shows the module's current value ("Last 30 days") with a
// drop arrow; clicking reveals the options for just that module. Only the
// section it sits in reloads — the rest of the page keeps its report.
function ModuleFilter({ label, active, options, onChange, busy }) {
  const [open, setOpen] = useState(false);
  const current = options.find((opt) => opt.value === active) || options[0];

  return (
    <div className="stats-module-filter">
      <button
        type="button"
        className={`stats-module-filter-btn${busy ? ' is-busy' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{current ? current.label : label}</span>
        <span className="material-symbols-rounded" aria-hidden="true">expand_more</span>
      </button>
      {open && (
        <>
          <button type="button" className="stats-module-filter-backdrop" aria-label="Close filter menu"
                  onClick={() => setOpen(false)} />
          <div className="stats-module-filter-menu" role="menu" aria-label={label}>
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={opt.value === active}
                className={opt.value === active ? 'is-active' : ''}
                onClick={() => { setOpen(false); if (opt.value !== active) onChange(opt.value); }}
              >
                <span>{opt.label}</span>
                {opt.value === active && <span className="material-symbols-rounded" aria-hidden="true">check</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const SALAH_OPTIONS = [7, 30, 60, 90];
const CHALLENGE_OPTIONS = [7, 30, 60, 90];
const CHARITY_OPTIONS = [6, 12];
const GIVING_SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'highest', label: 'Highest first' },
];

export default function StatsPage() {
  const { isLoggedIn } = useSession();
  const [filters, setFilters] = useState({ salah: 7, challenges: 7, charityMonths: 6 });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // Which section is refreshing right now, so its card can dim while the
  // report rebuilds without the whole page losing its content.
  const [busySection, setBusySection] = useState(null);
  const [error, setError] = useState('');
  const [givingSort, setGivingSort] = useState('newest');

  const load = useCallback(async (nextFilters, section) => {
    setBusySection(section || null);
    setLoading((prevLoading) => section ? prevLoading : true);
    try {
      const payload = await api.get({
        days: nextFilters.salah,
        challengeDays: nextFilters.challenges,
        charityMonths: nextFilters.charityMonths,
      });
      setData(payload);
      setError('');
    } catch (err) {
      setError('Could not build the stats report.');
    } finally {
      setLoading(false);
      setBusySection(null);
    }
  }, []);

  const changeFilter = useCallback((module, value) => {
    setFilters((prev) => {
      const next = { ...prev, [module]: value };
      load(next, module);
      return next;
    });
  }, [load]);

  // isLoggedIn is not known until the shell's boot call resolves. Querying
  // before that can show the sign-in gate to a signed-in person for a moment,
  // or fire a 401 request for a guest.
  useEffect(() => {
    if (isLoggedIn) load(filters);
    // filters deliberately excluded: changes flow through changeFilter, which
    // already reloads with the new value and marks only that section busy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, load]);

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

  // Recent giving sorts client-side over the list the server already capped,
  // so changing the sort never hits the API.
  const recentRows = [...(charity?.recent || [])].sort((a, b) => {
    if (givingSort === 'highest') return (Number(b.amount) || 0) - (Number(a.amount) || 0);
    if (givingSort === 'oldest') return String(a.date).localeCompare(String(b.date));
    return String(b.date).localeCompare(String(a.date));
  });

  return (
    <>
      <div className="page-header stats-page-header">
        <div>
          <h1>Stats</h1>
          <p>A visual report across your Salah, challenge and charity record — each module with its own range.</p>
        </div>
      </div>

      {error && <div className="auth-alert"><span className="material-symbols-rounded">error</span>{error}</div>}

      {loading && !data ? (
        <Loader variant="page" label="Building report" />
      ) : (
        <>
          {/* --- Salah --- */}
          <section className={`container1 stats-section${busySection === 'salah' ? ' is-reloading' : ''}`}>
            <div className="stats-section-head">
              <h2>Salah</h2>
              <ModuleFilter
                label="Report range"
                active={filters.salah}
                options={SALAH_OPTIONS.map((days) => ({ value: days, label: `Last ${days} days` }))}
                onChange={(value) => changeFilter('salah', value)}
                busy={busySection === 'salah'}
              />
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
          <section className={`container1 stats-section${busySection === 'challenges' ? ' is-reloading' : ''}`}>
            <div className="stats-section-head">
              <h2>Challenges</h2>
              <ModuleFilter
                label="Report range"
                active={filters.challenges}
                options={CHALLENGE_OPTIONS.map((days) => ({ value: days, label: `Last ${days} days` }))}
                onChange={(value) => changeFilter('challenges', value)}
                busy={busySection === 'challenges'}
              />
            </div>
            <div className="stats-tile-grid">
              <StatTile label="Total" value={challenges?.summary?.total ?? 0} />
              <StatTile label="Active" value={challenges?.summary?.active ?? 0} />
              <StatTile label="Best streak" value={challenges?.summary?.bestStreak ?? 0} />
              <StatTile label={`Check-ins (${challenges?.days ?? filters.challenges}d)`} value={challenges?.summary?.recentCheckInTotal ?? 0} />
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
          <section className={`container1 stats-section${busySection === 'charityMonths' ? ' is-reloading' : ''}`}>
            <div className="stats-section-head">
              <h2>Charity</h2>
              <ModuleFilter
                label="Report range"
                active={filters.charityMonths}
                options={CHARITY_OPTIONS.map((months) => ({ value: months, label: `Last ${months} months` }))}
                onChange={(value) => changeFilter('charityMonths', value)}
                busy={busySection === 'charityMonths'}
              />
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
                {/* Sort is client-side over the capped list the server sent,
                    so it reorders instantly without a reload. */}
                <ModuleFilter
                  label="Sort"
                  active={givingSort}
                  options={GIVING_SORTS}
                  onChange={setGivingSort}
                />
              </div>
              <ul className="stats-donation-list">
                {recentRows.map((entry, i) => (
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
