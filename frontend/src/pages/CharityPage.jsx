import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { charity as api, ApiError } from '../services/api';
import { useConfirm } from '../components/ConfirmProvider';
import { useSession } from '../hooks/useSession.jsx';
import Loader from '../components/Loader';
import DateField from '../components/DateField';
import FormSelect from '../components/FormSelect';

const today = () => new Date().toISOString().slice(0, 10);

// Amounts are currency-neutral on purpose: a user tells us "what a target
// means", not which bank it clears in. 1 decimal is enough for reports without
// floating point noise.
const money = (value) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(Number(value) || 0);

function CharityProgress({ value }) {
  const percent = Math.min(Number(value.progress?.percent) || 0, 100);
  const reached = percent >= 100;

  return (
    <div className="charity-progress" aria-hidden="true">
      <div className="charity-progress-track">
        <div
          className={`charity-progress-fill${reached ? ' is-complete' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="charity-progress-value">{Math.round(percent)}%</span>
    </div>
  );
}

function CharityCard({ charity, onDonate, onEdit, onDelete, donationOpen, donation, date, onDonationChange, onDonationSave, saving, canDelete, donationIndex, onDonationEdit, onDonationDelete, onDonationClose }) {
  const reached = charity.progress.percent >= 100;
  return (
    <article className={`container1 charity-card${reached ? ' is-complete' : ''}`} aria-labelledby={`charity_${charity.id}`}>
      <div className="charity-card-head">
        <div className="charity-card-title-block">
          <span className="charity-card-eyebrow">
            {charity.progress.reference || charity.period} target · {money(charity.targetAmount)}
          </span>
          <h3 id={`charity_${charity.id}`} className="charity-card-title">{charity.name}</h3>
        </div>
        <div className="charity-card-actions">
          {reached && <span className="charity-target-badge">Target hit</span>}
          <button type="button" className="btn btn-outline" onClick={() => onDonate(charity.id)}>Add donation</button>
          <button type="button" className="btn btn-outline" onClick={() => onEdit(charity.id)}>Edit</button>
          {canDelete && (
            <button type="button" className="btn btn-danger-outline" onClick={() => onDelete(charity.id)}>Delete</button>
          )}
        </div>
      </div>

      <div className="charity-card-body">
        <div className="charity-stats-row">
          <div className="charity-stat">
            <span>Given</span>
            <strong>{money(charity.progress.donated)}</strong>
          </div>
          <div className="charity-stat">
            <span>Remaining</span>
            <strong>{money(charity.progress.remaining)}</strong>
          </div>
          <div className="charity-stat">
            <span>Lifetime</span>
            <strong>{money(charity.lifeTime.given)}</strong>
          </div>
        </div>
        <CharityProgress value={charity} />
      </div>

      {donationOpen === charity.id && (
        <div className="charity-donation-panel">
          <div className="salah-form-grid">
            <div className="form-floating">
              <input
                className="form-control"
                type="number"
                min="0.01"
                step="0.01"
                value={donation.amount}
                placeholder="100"
                onChange={(e) => onDonationChange({ amount: e.target.value })}
              />
              <label>Amount</label>
            </div>
            <DateField id={`donate-date_${charity.id}`} label="Date" value={donation.date} onChange={(next) => onDonationChange({ date: next })} />
            <div className="form-floating">
              <input
                className="form-control"
                value={donation.note}
                placeholder="After Jumu'ah"
                onChange={(e) => onDonationChange({ note: e.target.value })}
              />
              <label>Note (optional)</label>
            </div>
          </div>
          <div className="new-task">
            <button type="button" className="btn btn-primary" onClick={() => onDonationSave(charity.id)} disabled={saving}>
              {donationIndex != null ? (saving ? 'Saving…' : 'Save changes') : (saving ? 'Saving…' : 'Save donation')}
            </button>
            <button type="button" className="btn btn-outline" style={{ marginLeft: '0.5rem' }} onClick={onDonationClose}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {charity.donations.length > 0 && (
        <div className="charity-donations">
          <div className="charity-donations-head">
            <span className="charity-donations-title">Recent donations</span>
            <span className="charity-donations-total">Lifetime {money(charity.lifeTime.given)}</span>
          </div>
          <ul className="charity-donation-list">
            {/* Each row keeps its position in the stored list (entry.idx) - the
                edit / delete calls target that index. */}
            {charity.donations.map((entry, idx) => ({ ...entry, idx })).slice(-5).reverse().map((entry) => (
              <li key={`${entry.date}-${entry.idx}`}>
                <span className="charity-donation-date">{entry.date}</span>
                <span className="charity-donation-amount">{money(entry.amount)}</span>
                {entry.note && <span className="charity-donation-note">{entry.note}</span>}
                <span className="charity-donation-actions">
                  <button
                    type="button"
                    className="fav-btn"
                    aria-label={`Edit donation of ${money(entry.amount)} on ${entry.date}`}
                    title="Edit donation"
                    onClick={() => onDonationEdit(charity.id, entry.idx, entry)}
                  >
                    <span className="material-symbols-rounded">edit</span>
                  </button>
                  <button
                    type="button"
                    className="fav-btn is-danger"
                    aria-label={`Delete donation of ${money(entry.amount)} on ${entry.date}`}
                    title="Delete donation"
                    onClick={() => onDonationDelete(charity.id, entry.idx)}
                  >
                    <span className="material-symbols-rounded">delete</span>
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

export default function CharityPage() {
  const { isLoggedIn } = useSession();
  const ask = useConfirm();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // "__new__" or a charity id.
  const [draft, setDraft] = useState({ name: '', targetAmount: '', period: 'monthly' });
  const [donationOpen, setDonationOpen] = useState(null);
  const [donation, setDonation] = useState({ amount: '', date: today(), note: '' });
  // When set, the open donation panel edits that row (its index in the
  // charity's stored list) instead of adding a new one.
  const [donationIndex, setDonationIndex] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await api.list();
      setData(payload);
      setError('');
    } catch (err) {
      setError('Could not load your charity targets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isLoggedIn) load(); }, [isLoggedIn, load]);

  const openEditor = (charity) => {
    setDraft({
      name: charity?.name || '',
      targetAmount: charity?.targetAmount ? String(charity.targetAmount) : '',
      period: charity?.period || 'monthly'
    });
    setEditing(charity ? String(charity.id) : '__new__');
  };

  const closeEditor = () => {
    setEditing(null);
    setDraft({ name: '', targetAmount: '', period: 'monthly' });
  };

  async function submitEditor() {
    if (!draft.name.trim() || !Number(draft.targetAmount)) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: draft.name.trim(),
        targetAmount: Number(draft.targetAmount),
        period: draft.period
      };
      if (editing === '__new__') await api.create(payload);
      else await api.update(editing, payload);
      closeEditor();
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === 'duplicate') {
        setError('You already have a charity with that name.');
      } else {
        setError('Could not save that charity target.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveDonation(charityId) {
    if (!Number(donation.amount)) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        amount: Number(donation.amount),
        date: donation.date,
        note: donation.note || ''
      };
      if (donationIndex != null) await api.updateDonation(charityId, donationIndex, payload);
      else await api.donate(charityId, payload);
      closeDonation();
      await load();
    } catch (err) {
      setError('Could not save that donation.');
    } finally {
      setSaving(false);
    }
  }

  const closeDonation = () => {
    setDonationOpen(null);
    setDonationIndex(null);
    setDonation({ amount: '', date: today(), note: '' });
  };

  // Pencil on a donation row: open the same panel, prefilled with the row.
  function editDonationRow(charityId, index, entry) {
    setDonationOpen(charityId);
    setDonationIndex(index);
    setDonation({ amount: String(entry.amount), date: entry.date, note: entry.note || '' });
  }

  async function deleteDonationRow(charityId, index) {
    const ok = await ask({
      title: 'Delete this donation?',
      message: 'It is removed from the charity totals.',
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    try {
      await api.removeDonation(charityId, index);
      if (donationOpen === charityId && donationIndex === index) closeDonation();
      await load();
    } catch (err) {
      setError('Could not delete that donation.');
    }
  }

  async function deleteCharity(charityId) {
    const ok = await ask({
      title: 'Delete this charity?',
      message: 'Its donation history goes with it. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    try {
      await api.remove(charityId);
      await load();
    } catch (err) {
      setError('Could not delete that charity.');
    }
  }

  if (isLoggedIn === null) {
    return (
      <>
        <div className="page-header"><h1>Charity</h1><p>Set goals and track your giving</p></div>
        <Loader variant="page" label="Loading charity" />
      </>
    );
  }

  if (!isLoggedIn) {
    return (
      <>
        <div className="page-header"><h1>Charity</h1><p>Set goals and track your giving</p></div>
        <div className="container1">
          <div className="gate-notice">
            <span className="gate-icon material-symbols-rounded" aria-hidden="true">lock</span>
            <div className="gate-body">
              <h2 className="gate-title">Sign in to track charity</h2>
              <p className="gate-text">
                Charity targets and giving history are private, so they need an account.
                Everything else stays open.
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

  const charities = data?.charities || [];
  const periods = data?.periods || [
    { id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' },
    { id: 'monthly', label: 'Monthly' }, { id: 'yearly', label: 'Yearly' }
  ];

  return (
    <>
      <div className="page-header charity-page-header page-header-with-action">
        <div>
          <h1>Charity</h1>
          <p>Set recurring targets and record every donation</p>
        </div>
        <div className="charity-header-actions">
          <Link className="btn btn-outline" to="/stats">View stats</Link>
          <button type="button" className="btn btn-primary" onClick={() => openEditor(null)}>
            Add charity
          </button>
        </div>
      </div>

      {editing && (
        <div className="container1 charity-editor">
          <div className="card-header">
            <h3>{editing === '__new__' ? 'New charity' : 'Edit charity target'}</h3>
          </div>
          <div className="salah-form-grid">
            <div className="form-floating">
              <input
                className="form-control"
                value={draft.name}
                placeholder="Zakat al-Fitr"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <label>Charity name</label>
            </div>
            <div className="form-floating">
              <input
                className="form-control"
                type="number"
                min="0.01"
                step="0.01"
                value={draft.targetAmount}
                placeholder="500"
                onChange={(e) => setDraft({ ...draft, targetAmount: e.target.value })}
              />
              <label>Target amount</label>
            </div>
            <FormSelect
              id="charity-period"
              label="Target period"
              value={draft.period}
              onChange={(value) => setDraft({ ...draft, period: value })}
              options={periods.map((p) => ({ value: p.id, label: p.label }))}
            />
          </div>
          <div className="new-task charity-editor-actions">
            <button type="button" className="btn btn-primary" onClick={submitEditor} disabled={saving}>
              {editing === '__new__' ? 'Add charity' : 'Save target'}
            </button>
            <button type="button" className="btn btn-outline" onClick={closeEditor}>Cancel</button>
          </div>
        </div>
      )}

      {error && <div className="auth-alert"><span className="material-symbols-rounded">error</span>{error}</div>}

      {loading ? (
        <Loader variant="inline" label="Loading charity" />
      ) : charities.length === 0 ? (
        <div className="container1 charity-empty">
          <span className="material-symbols-rounded" aria-hidden="true">volunteer_activism</span>
          <h2>No charity targets yet</h2>
          <p>Create one above. You can choose whether its target resets daily, weekly, monthly or yearly, then keep a running total.</p>
        </div>
      ) : (
        <div className="charity-list">
          {charities.map((charity) => (
            <CharityCard
              key={charity.id}
              charity={charity}
              canDelete
              donationOpen={donationOpen}
              donation={donation}
              saving={saving}
              onDonate={(id) => {
                if (id === donationOpen && donationIndex == null) closeDonation();
                else {
                  setDonationOpen(id);
                  setDonationIndex(null);
                  setDonation({ amount: '', date: today(), note: '' });
                }
              }}
              onEdit={() => openEditor(charities.find((item) => item.id === charity.id))}
              onDelete={deleteCharity}
              donationIndex={donationIndex}
              onDonationEdit={editDonationRow}
              onDonationDelete={deleteDonationRow}
              onDonationClose={closeDonation}
              onDonationChange={(patch) => setDonation((next) => ({ ...next, ...patch }))}
              onDonationSave={saveDonation}
            />
          ))}
        </div>
      )}
    </>
  );
}
