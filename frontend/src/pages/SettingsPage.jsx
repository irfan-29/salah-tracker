import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, settings as settingsApi } from '../services/api';
import { useSession } from '../hooks/useSession.jsx';
import Loader from '../components/Loader';

const TG_ERRORS = {
  'bot-not-configured': "Notifications are off: the app's Telegram bot isn't configured on the server yet.",
  'no-code': 'That code has expired. Get a new one and try again.',
  'no-messages': "The bot has not seen a message from you yet. Send it the code, then press Connect.",
  'unknown': 'Could not connect that chat. Try again.',
  'missing-chat': 'Connect your Telegram chat first.',
  'send-failed': 'Telegram did not accept that message.',
};

// Each section persists independently, so a failure names the section that
// failed instead of "settings could not be saved".
function useSection() {
  const [state, setState] = useState({ saving: false, error: '' });
  const save = useCallback(async (patch) => {
    setState({ saving: true, error: '' });
    try {
      await api.post('/settings', patch);
      setState({ saving: false, error: '' });
      return true;
    } catch (err) {
      setState({ saving: false, error: err.message || 'Could not save.' });
      return false;
    }
  }, []);
  return { ...state, save };
}

function SelectRow({ label, hint, value, options, onChange, renderLabel }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="custom-select-wrapper">
      {label && <div className="form-section-title">{label}</div>}
      {hint && <p className="form-section-hint">{hint}</p>}
      <div className="custom-selector form-control d-flex align-items-center justify-content-between"
           onClick={() => setOpen((o) => !o)} role="button" tabIndex={0}>
        <span>{renderLabel ? renderLabel(value) : (value || 'Choose…')}</span>
        <span className="material-symbols-rounded" style={{ opacity: 0.5 }}>expand_more</span>
      </div>
      {open && (
        <div className="custom-dropdown-menu show">
          <div className="options-list">
            {options.map((opt) => (
              <div key={opt.value} className="option-item-custom"
                   onClick={() => { onChange(opt.value); setOpen(false); }}>
                {opt.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { isLoggedIn } = useSession();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const theme = useSection();

  const [editions, setEditions] = useState([]);
  const [editionSearch, setEditionSearch] = useState('');
  const [primary, setPrimary] = useState('');
  const [tg, setTg] = useState(null);
  const [tgError, setTgError] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let cancelled = false;
    settingsApi.get()
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setEditions(payload.settings.favoriteEdition || []);
        setPrimary(payload.settings.primaryTranslation || '');
        setTg({
          enabled: payload.telegram.prefs.enabled,
          events: { ...payload.telegram.prefs.events },
          times: { ...payload.telegram.prefs.times },
        });
      })
      .catch((err) => { if (!cancelled) setLoadError('Could not load your settings.'); });
    return () => { cancelled = true; };
  }, []);

  // Apply the theme to the document immediately, since it is the one setting
  // that visibly changes something the moment it is picked.
  useEffect(() => {
    if (data && data.settings.theme) {
      document.documentElement.setAttribute('data-theme', data.settings.theme);
    }
  }, [data]);

  const filteredEditions = useMemo(() => {
    const q = editionSearch.trim().toLowerCase();
    if (!q || !data) return null;
    const out = {};
    for (const [lang, list] of Object.entries(data.editions || {})) {
      const hits = list.filter((e) =>
        `${e.author} ${lang}`.toLowerCase().includes(q));
      if (hits.length) out[lang] = hits;
    }
    return out;
  }, [editionSearch, data]);

  if (loadError) {
    return <><div className="page-header"><h1>Settings</h1></div>
      <div className="container1"><p className="post-empty">{loadError}</p></div></>;
  }
  if (!data) return <Loader variant="inline" label="Loading settings" />;

  const s = data.settings;
  const savingError = (section) => (
    section.error ? <div className="auth-alert" role="alert"><span className="material-symbols-rounded">error</span>{section.error}</div> : null
  );

  async function saveTg(patch) {
    setBusy('tg');
    setTgError('');
    try {
      await api.post('/telegram/prefs', patch);
      return true;
    } catch (err) {
      setTgError(TG_ERRORS[err.body?.error] || err.message || 'Could not save.');
      return false;
    } finally {
      setBusy('');
    }
  }

  function toggleEvent(key) {
    setTg((t) => ({ ...t, events: { ...t.events, [key]: !t.events[key] } }));
    saveTg({ events: { ...tg.events, [key]: !tg.events[key] }, times: tg.times });
  }

  function setTime(key, value) {
    setTg((t) => ({ ...t, times: { ...t.times, [key]: value } }));
    saveTg({ events: tg.events, times: { ...tg.times, [key]: value } });
  }

  async function getSetupCode() {
    setBusy('code');
    setTgError('');
    try {
      const result = await api.post('/telegram/setup-code', {
        tgEnabled: 'on', tgTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tgEventAyah: tg.events.ayahOfTheDay ? 'on' : '',
        tgAyahTime: tg.times.ayahOfTheDay
      });
      setSetupCode(result.code);
    } catch (err) {
      setTgError(TG_ERRORS[err.body?.error] || 'Could not send a code.');
    } finally {
      setBusy('');
    }
  }

  async function connectChat() {
    setBusy('connect');
    setTgError('');
    try {
      await api.post('/telegram/chat-id', {
        tgEnabled: 'on', tgTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
      const fresh = await settingsApi.get();
      setData(fresh);
      setTg({ enabled: fresh.telegram.prefs.enabled, events: { ...fresh.telegram.prefs.events }, times: { ...fresh.telegram.prefs.times } });
    } catch (err) {
      setTgError(TG_ERRORS[err.body?.error] || 'Could not connect.');
    } finally {
      setBusy('');
    }
  }

  async function sendTest(module) {
    setBusy(`test-${module}`);
    setTgError('');
    try {
      await api.post('/telegram/test', { module });
    } catch (err) {
      setTgError(TG_ERRORS[err.body?.error] || 'Could not send that message.');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Settings</h1>
        <p>Customise your experience</p>
      </div>

      {/* Appearance - .theme-picker markup copied from views/settings.ejs, so the
          existing styles apply. My first pass invented .theme-options and
          rendered raw radio buttons. */}
      <div className="form-section-title">Appearance</div>
      <div className="theme-picker">
        {[
          { value: 'light', icon: 'light_mode', label: 'Light' },
          { value: 'dark', icon: 'dark_mode', label: 'Dark' },
        ].map((opt) => (
          <label key={opt.value}
                 className={`theme-picker-option${s.theme === opt.value ? ' active' : ''}`}>
            <input type="radio" name="theme" value={opt.value}
                   checked={s.theme === opt.value}
                   onChange={async () => {
                     // Applied to the document as well as saved, so the change is
                     // visible immediately instead of on the next navigation.
                     document.documentElement.setAttribute('data-theme', opt.value);
                     await theme.save({ theme: opt.value });
                     setData({ ...data, settings: { ...s, theme: opt.value } });
                   }} />
            <span className="material-symbols-rounded">{opt.icon}</span>
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
      {savingError(theme)}

      {/* Home */}
      <SelectRow label="Default Home Page" value={s.defaultHome}
        options={Object.entries(data.homeOptions).map(([value, label]) => ({ value, label }))}
        onChange={async (value) => {
          if (await theme.save({ defaultHome: value })) setData({ ...data, settings: { ...s, defaultHome: value } });
        }} />

      {/* Font */}
      <SelectRow label="Quran Font" value={s.favoriteFont}
        options={Object.entries(data.fonts).map(([value, f]) => ({ value, label: `${f.label} · ${f.tag}` }))}
        onChange={async (value) => {
          if (await theme.save({ font: value })) setData({ ...data, settings: { ...s, favoriteFont: value } });
        }}
        renderLabel={(v) => (data.fonts[v] ? data.fonts[v].label : 'Choose Font')} />

      {/* Reciter */}
      <SelectRow label="Reciter" value={String(s.favoriteReciter)}
        options={(data.reciters || []).map((r) => ({ value: r.id, label: r.name }))}
        onChange={async (value) => {
          if (await theme.save({ reciter: value })) setData({ ...data, settings: { ...s, favoriteReciter: value } });
        }}
        renderLabel={(v) => (data.reciters || []).find((r) => r.id === v)?.name || 'Choose a reciter'} />

      {/* Editions */}
      <div className="form-section-title">Translation Editions</div>
      <div className="custom-select-wrapper">
        <div className="custom-selector form-control d-flex flex-wrap align-items-center gap-2"
             style={{ minHeight: 58, cursor: 'pointer' }}
             onClick={(e) => {
               if (e.target.closest('.pill')) return;
               const el = document.getElementById('dropdownContainer');
               if (el) el.style.display = el.style.display === 'block' ? 'none' : 'block';
             }}>
          {editions.length === 0
            ? <span className="text-muted">Select preferred Quran editions</span>
            : editions.map((e) => {
                const [id, lang, author] = String(e).split(':');
                return (
                  <span key={e} className="badge badge-primary pill">
                    {author || lang || id}
                  </span>
                );
              })}
        </div>
        <div id="dropdownContainer" className="custom-dropdown-menu" style={{ maxHeight: 350, overflowY: 'auto' }}>
          <input type="text" className="dropdown-search-custom" placeholder="Search language or author..."
                 value={editionSearch} onChange={(e) => setEditionSearch(e.target.value)} />
          <div id="editionOptions">
            {Object.entries(filteredEditions || data.editions || {}).map(([lang, list]) => (
              <div className="language-group" key={lang}>
                <div className="p-2 bg-light small text-muted language-label">{lang}</div>
                {list.map((e) => {
                  const id = e.name;
                  const value = `${id}:${lang}:${e.author}`;
                  const on = editions.includes(value);
                  return (
                    <div key={value} className={`option-item-custom option-item ${on ? 'selected' : ''}`}
                         onClick={() => {
                           const next = on ? editions.filter((x) => x !== value) : [...editions, value];
                           setEditions(next);
                           theme.save({ edition: next });
                         }}>
                      {e.author}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Primary translation */}
      <SelectRow label="Primary Translation"
        hint="Shown on Ayah of the Day and listed first on the surah page."
        value={primary}
        options={editions.map((e) => {
          const [id, lang, author] = String(e).split(':');
          return { value: e, label: `${author || lang} · ${lang}` };
        })}
        onChange={async (value) => {
          setPrimary(value);
          await theme.save({ primaryTranslation: value });
        }}
        renderLabel={(v) => {
          if (!v) return 'Select editions first';
          const [, lang, author] = String(v).split(':');
          return `${author || ''} · ${lang || ''}`;
        }} />

      {/* Location */}
      <SelectRow label="Location" value={s.location}
        options={(data.locationOptions || []).map((l) => ({ value: l, label: l }))}
        onChange={async (value) => {
          if (await theme.save({ location: value })) setData({ ...data, settings: { ...s, location: value } });
        }} />

      {/* ---- Telegram ---- */}
      <div className="form-section-title">Telegram Notifications</div>

      <div className="tg-row tg-row-head">
        <div>
          <div className="tg-title">Telegram notifications</div>
          <div className="tg-sub">Daily reminders and streak summaries</div>
        </div>
        {isLoggedIn ? (
          <label className="tg-switch">
            <input type="checkbox" checked={tg.enabled}
                   onChange={async (e) => {
                     const enabled = e.target.checked;
                     setTg({ ...tg, enabled });
                     await saveTg({ tgEnabled: enabled ? 'on' : '', events: tg.events, times: tg.times });
                   }} />
            <span className="tg-slider"></span>
          </label>
        ) : (
          /* Signed out: the switch is disabled but the label stays readable, so
             the feature stays discoverable rather than hidden. */
          <label className="tg-switch tg-switch-locked" aria-disabled="true" title="Sign in to enable">
            <input type="checkbox" disabled />
            <span className="tg-slider"></span>
            <span className="tg-lock-dot material-symbols-rounded" aria-hidden="true">lock</span>
          </label>
        )}
      </div>

      {!isLoggedIn ? (
        <div className="tg-locked-note">
          <span className="material-symbols-rounded">lock</span>
          <a href="/login">Sign in</a> to turn on Telegram notifications.
        </div>
      ) : (
        <>
          {!data.telegram.botConfigured && (
            <div className="wa-status wa-status-bad">
              <span className="material-symbols-rounded">error</span>
              Notifications are off: the app's Telegram bot isn't configured on the server yet.
            </div>
          )}

          {tgError && (
            <div className="auth-alert" role="alert">
              <span className="material-symbols-rounded">error</span>{tgError}
            </div>
          )}

          {data.telegram.chatId && (
            <div className="wa-status wa-status-good">
              <span className="material-symbols-rounded">check_circle</span>
              Connected to chat {data.telegram.chatId}.
            </div>
          )}

          {setupCode && (
            <div className="tg-code-box">
              <span className="material-symbols-rounded">key</span>
              <span>Send this code to the bot:</span>
              <strong>{setupCode}</strong>
            </div>
          )}

          {tg.enabled && (
            <>
              <TelegramModule
                label="Challenges" checked={tg.events.challenges}
                onToggle={() => toggleEvent('challenges')}
                onTest={() => sendTest('challenges')}
                busy={busy === 'test-challenges'} />

              <TelegramModule
                label="Salah Tracker" checked={tg.events.salahTracker}
                onToggle={() => toggleEvent('salahTracker')}
                onTest={() => sendTest('salahTracker')}
                busy={busy === 'test-salahTracker'} />

              <TelegramModule
                label="New post" checked={tg.events.newPost}
                onToggle={() => toggleEvent('newPost')}
                onTest={() => sendTest('newPost')}
                busy={busy === 'test-newPost'} />

              <TelegramModule
                label="Salah timings" checked={tg.events.salahTimings}
                onToggle={() => toggleEvent('salahTimings')}
                time={tg.times.salahTimings}
                onTime={(v) => setTime('salahTimings', v)}
                onTest={() => sendTest('salahTimings')}
                busy={busy === 'test-salahTimings'} />

              <TelegramModule
                label="Ayah of the day" checked={tg.events.ayahOfTheDay}
                onToggle={() => toggleEvent('ayahOfTheDay')}
                time={tg.times.ayahOfTheDay}
                onTime={(v) => setTime('ayahOfTheDay', v)}
                onTest={() => sendTest('ayahOfTheDay')}
                busy={busy === 'test-ayahOfTheDay'} />
            </>
          )}

          {tg.enabled && !data.telegram.chatId && (
            <div className="wa-test-form tg-panel">
              <button type="button" className="btn btn-primary" onClick={getSetupCode} disabled={busy === 'code'}>
                <span className="material-symbols-rounded">key</span>
                Get setup code
              </button>
              <button type="button" className="btn btn-outline" onClick={connectChat} disabled={busy === 'connect'}>
                <span className="material-symbols-rounded">link</span>
                Connect
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function TelegramModule({ label, checked, onToggle, onTest, time, onTime, busy }) {
  return (
    <div className="tg-module">
      <label className="tg-module-row">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span>{label}</span>
      </label>
      {time !== undefined && (
        <input className="form-control tg-time" type="time" value={time} onChange={(e) => onTime(e.target.value)} />
      )}
      <button type="button" className="tg-send-btn" onClick={onTest} disabled={busy}>
        <span className="material-symbols-rounded">send</span>
        {busy ? '…' : 'Send now'}
      </button>
    </div>
  );
}