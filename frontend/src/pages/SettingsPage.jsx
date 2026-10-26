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

// App Font choices: the current face kept as default plus five widely used
// Google faces whose stacks are defined once in styles.css keyed off
// html[data-app-font=...]. The ids here and in App.jsx must stay in step.
const APP_FONTS = [
  { value: 'default', label: 'Default · Plus Jakarta Sans (current)' },
  { value: 'inter', label: 'Inter' },
  { value: 'roboto', label: 'Roboto' },
  { value: 'poppins', label: 'Poppins' },
  { value: 'nunito', label: 'Nunito' },
  { value: 'lora', label: 'Lora' },
];

// Text-size picker built to match the reader's "Go to Ayah" navigator
// (`.ayah-jump`): one slider, a caption, the saved value and a Set button.
// Deliberately NOT live: dragging only moves the thumb; the label shows the
// saved value and nothing is applied until Set is pressed.
const SIZE_MIN = 80;
const SIZE_MAX = 150;
const SIZE_STEP = 5;

function SizeJump({ label, value, hint, saving, onCommit }) {
  // Two-phase on purpose (the reader asked for it exactly this way): dragging
  // updates ONLY the number shown in the row - the page itself keeps its
  // current size until Set saves the choice and reloads, which is what applies
  // the new size across the app.
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    // Keep the draft in step with the stored value after externally driven
    // changes (a failed save reverts here).
    setDraft(value);
  }, [value]);

  const commit = useCallback(async () => {
    if (saving || draft === value) return;
    const ok = await onCommit(draft);
    if (!ok) setDraft(value); // Save failed: the label rolls back to the saved size.
  }, [draft, value, saving, onCommit]);

  const id = `size-jump-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="ayah-jump ayah-jump--settings">
      <label className="ayah-jump-label" htmlFor={id}>{label}</label>
      {hint && <p className="form-section-hint">{hint}</p>}
      <input
        type="range" id={id} className="form-range"
        min={SIZE_MIN} max={SIZE_MAX} step={SIZE_STEP} value={draft}
        aria-label={label}
        onChange={(e) => setDraft(Number(e.target.value))}
      />
      <div className="ayah-jump-row">
        <span className="ayah-jump-caption">Size</span>
        <span className="ayah-jump-value">{draft}%</span>
        <button type="button" className="btn btn-primary btn-sm"
                disabled={saving || draft === value}
                onClick={commit}>
          Set
        </button>
      </div>
    </div>
  );
}

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
           onClick={() => setOpen((o) => !o)} role="button" tabIndex={0}
           aria-haspopup="listbox" aria-expanded={open}
           onKeyDown={(e) => {
             if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); }
             if (e.key === 'Escape') setOpen(false);
           }}>
        <span>{renderLabel ? renderLabel(value) : (value || 'Choose…')}</span>
        <span className="material-symbols-rounded" style={{ opacity: 0.5 }}>expand_more</span>
      </div>
      {/* Opened with an inline display, matching views/settings.ejs. The base
          .custom-dropdown-menu rule is display:none and there is no .show rule,
          so adding a class here would leave it permanently closed. */}
      {open && (
        <div className="custom-dropdown-menu" style={{ display: 'block' }} role="listbox">
          <div className="options-list">
            {options.map((opt) => {
              const selected = String(opt.value) === String(value);
              return (
                <div key={opt.value}
                     className={`option-item-custom${selected ? ' is-selected' : ''}`}
                     role="option" aria-selected={selected}
                     onClick={() => { onChange(opt.value); setOpen(false); }}>
                  <span>{opt.label}</span>
                  {selected && <span className="material-symbols-rounded" aria-hidden="true">check</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  // setTheme keeps the shell's boot metadata in step with the choice, and writes
  // the value the pre-paint script reads; refresh re-reads the rest of the meta
  // (default home) so a save does not need a page reload.
  const { isLoggedIn, setTheme, refresh } = useSession();
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

  // The shell applies the theme at boot from /api/app/meta, so this is a
  // fallback for the case where that request failed and this page is the only
  // place that knows the stored value. It goes through setTheme rather than
  // setting the attribute directly, so the pre-paint storage key stays in step.
  useEffect(() => {
    if (data && data.settings.theme) setTheme(data.settings.theme);
  }, [data, setTheme]);

  // Editions are no longer in the settings payload - they are fetched when the
  // dropdown opens, and searched on the server. The whole catalogue is 98
  // languages and ~32KB, which was most of the settings response.
  const [editionOpen, setEditionOpen] = useState(false);
  const [editionRows, setEditionRows] = useState([]);

  const loadEditions = useCallback(async (params) => {
    try {
      const query = params ? `?${params}` : '';
      const result = await api.get(`/editions${query}`);
      setEditionRows(result.editions || []);
    } catch (err) {
      setEditionRows([]);
    }
  }, []);

  // Open: show one language, not 98 collapsed groups. The first language
  // alphabetically is "Achinese" with a single edition, so the default is the
  // language the user already has selected, falling back to English.
  const defaultEditionLanguage = useMemo(() => {
    const fromSelection = editions
      .map((e) => String(e).split(':')[1])
      .find(Boolean);
    if (fromSelection) return fromSelection;
    if (primary) { const p = String(primary).split(':')[1]; if (p) return p; }
    return 'English';
  }, [editions, primary]);

  useEffect(() => {
    if (!editionOpen) return;
    loadEditions(`lang=${encodeURIComponent(defaultEditionLanguage)}`);
  }, [editionOpen, defaultEditionLanguage, loadEditions]);

  // Search: debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const q = editionSearch.trim();
    if (!editionOpen || !q) return undefined;
    const timer = setTimeout(() => loadEditions(`q=${encodeURIComponent(q)}`), 250);
    return () => clearTimeout(timer);
  }, [editionSearch, editionOpen, loadEditions]);

  if (loadError) {
    return <><div className="page-header"><h1>Settings</h1></div>
      <div className="container1"><p className="post-empty">{loadError}</p></div></>;
  }
  if (!data) return <Loader variant="page" label="Loading settings" />;

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

  function toggleEdition(value, on) {
    const next = on ? editions.filter((x) => x !== value) : [...editions, value];
    setEditions(next);
    theme.save({ edition: next });
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

      <div className="settings-panel">
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
                     // Paint immediately through the shared setter, so the
                     // change is visible before the round-trip and the value is
                     // already in storage for the next first paint.
                     setTheme(opt.value);
                     if (await theme.save({ theme: opt.value })) {
                       setData({ ...data, settings: { ...s, theme: opt.value } });
                       // Keep the shell's meta copy in step; no reload needed.
                       refresh();
                     } else {
                       // The save failed. Undo the optimistic paint so what is
                       // on screen matches what is actually stored.
                       setTheme(s.theme);
                     }
                   }} />
            <span className="material-symbols-rounded">{opt.icon}</span>
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
      {savingError(theme)}

      {/* Typography - applies via the shell when the refreshed meta arrives:
          App.jsx writes data-app-font plus the two scale custom properties and
          mirrors them into localStorage for the pre-paint script. */}
      <SelectRow label="App Font" value={s.appFont || 'default'}
        options={APP_FONTS}
        onChange={async (value) => {
          if (await theme.save({ appFont: value })) {
            setData({ ...data, settings: { ...s, appFont: value } });
            refresh();
          }
        }}
        hint="Typeface used across the whole app - menus, pages and cards."
        renderLabel={(v) => (APP_FONTS.find((f) => f.value === v) || APP_FONTS[0]).label} />

      <SizeJump label="App Text Size" value={Number(s.appFontSize) || 100}
        saving={theme.saving}
        /* Set = the only API hit, followed by a reload so the shell, the
           pre-paint localStorage replay and the page all apply the new size. */
        onCommit={async (value) => {
          const ok = await theme.save({ appFontSize: value });
          if (ok) window.location.reload();
          return ok;
        }}
        hint="Scales the whole interface, not the Arabic text. Default is 100%." />

      <SizeJump label="Quran Text Size" value={Number(s.quranFontSize) || 100}
        saving={theme.saving}
        onCommit={async (value) => {
          const ok = await theme.save({ quranFontSize: value });
          if (ok) window.location.reload();
          return ok;
        }}
        hint="Sizes only the Arabic ayah text. Default is 100%." />

      {/* Home */}
      <SelectRow label="Default Home Page" value={s.defaultHome}
        options={Object.entries(data.homeOptions).map(([value, label]) => ({ value, label }))}
        onChange={async (value) => {
          if (await theme.save({ defaultHome: value })) {
            setData({ ...data, settings: { ...s, defaultHome: value } });
            // "/" reads homePath from the shell's meta, so it has to be told.
            refresh();
          }
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

      {/* Editions - fetched on demand. See loadEditions above. */}
      <div className="form-section-title">Translation Editions</div>
      <div className="custom-select-wrapper">
        <div className="custom-selector form-control d-flex flex-wrap align-items-center gap-2"
             style={{ minHeight: 58, cursor: 'pointer' }}
             onClick={() => setEditionOpen((o) => !o)}>
          {editions.length === 0
            ? <span className="text-muted">Select preferred Quran editions</span>
            : editions.map((e) => {
                const [, , author] = String(e).split(':');
                // views/settings.ejs builds these with .edition-pill plus a
                // nested .remove-pill x, not a Bootstrap badge. The version here
                // used `badge badge-primary pill` - "pill" is not a class
                // anywhere in this project, so it rendered as an unstyled badge.
                return (
                  <span key={e} className="edition-pill">
                    {author || e}
                    <span className="remove-pill" role="button" tabIndex={0}
                          title={`Remove ${author || e}`}
                          onClick={(ev) => { ev.stopPropagation(); toggleEdition(e, true); }}
                          onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') toggleEdition(e, true); }}
                    >&times;</span>
                  </span>
                );
              })}
        </div>
        {editionOpen && (
          <div className="custom-dropdown-menu" style={{ display: 'block', maxHeight: 350, overflowY: 'auto' }}>
            <input type="text" className="dropdown-search-custom" placeholder="Search language or author..."
                   value={editionSearch} onChange={(e) => setEditionSearch(e.target.value)} />
            <div id="editionOptions">
              {editionSearch.trim() ? (
                <div className="language-group">
                  <div className="p-2 bg-light small text-muted language-label">
                    {editionRows.length} match{editionRows.length === 1 ? '' : 'es'}
                  </div>
                  {editionRows.map((e) => (
                    <EditionRow key={`${e.language}-${e.name}`} e={e} language={e.language}
                                selected={editions} onToggle={toggleEdition} />
                  ))}
                </div>
              ) : (
                <div className="language-group">
                  <div className="p-2 bg-light small text-muted language-label">
                    {defaultEditionLanguage}
                  </div>
                  {editionRows.map((e) => (
                    <EditionRow key={e.name} e={e} language={defaultEditionLanguage}
                                selected={editions} onToggle={toggleEdition} />
                  ))}
                  <div className="p-2 small text-muted" style={{ borderTop: '1px solid var(--color-border-light)' }}>
                    {editionRows.length === 0
                      ? 'No editions listed for this language - search above for another.'
                      : `${editionRows.length} in this language. Search above to reach the other ${Math.max(0, (data.editionLanguages?.length || 1) - 1)}.`}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
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
            <div className="wa-status wa-status-ok">
              <span className="material-symbols-rounded">check_circle</span>
              Connected to chat {data.telegram.chatId}.
            </div>
          )}

          {setupCode && (
            <div className="wa-status wa-status-ok">
              <span className="material-symbols-rounded">key</span>
              Send this code to the bot, then press Connect:{' '}
              <strong className="tg-code">{setupCode}</strong>
            </div>
          )}

          {tg.enabled && (
            <>
              <div className="tg-modules">
                <div className="tg-title tg-title-sm">What to send</div>
              <TelegramModule
                label="Challenges" hint="Sent when you update your streaks" checked={tg.events.challenges}
                onToggle={() => toggleEvent('challenges')}
                onTest={() => sendTest('challenges')}
                busy={busy === 'test-challenges'} />

              <TelegramModule
                label="Salah Tracker" hint="Sent when you log a prayer" checked={tg.events.salahTracker}
                onToggle={() => toggleEvent('salahTracker')}
                onTest={() => sendTest('salahTracker')}
                busy={busy === 'test-salahTracker'} />

              <TelegramModule
                label="New post" hint="When a post or video is added" checked={tg.events.newPost}
                onToggle={() => toggleEvent('newPost')}
                onTest={() => sendTest('newPost')}
                busy={busy === 'test-newPost'} />

              <TelegramModule
                label="Salah timings" hint="Sent once a day" checked={tg.events.salahTimings}
                onToggle={() => toggleEvent('salahTimings')}
                time={tg.times.salahTimings} timeId="tgSalahTime"
                onTime={(v) => setTime('salahTimings', v)}
                onTest={() => sendTest('salahTimings')}
                busy={busy === 'test-salahTimings'} />

              <TelegramModule
                label="Ayah of the day" hint="Sent once a day" checked={tg.events.ayahOfTheDay}
                onToggle={() => toggleEvent('ayahOfTheDay')}
                time={tg.times.ayahOfTheDay} timeId="tgAyahTime"
                onTime={(v) => setTime('ayahOfTheDay', v)}
                onTest={() => sendTest('ayahOfTheDay')}
                busy={busy === 'test-ayahOfTheDay'} />
              </div>
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
      </div>
    </>
  );
}

function EditionRow({ e, language, selected, onToggle }) {
  // Same combined "id:language:author" shape the rest of the app stores, so
  // getFavoriteEditions and the reader keep working unchanged.
  const value = `${e.name}:${language}:${e.author}`;
  const on = selected.includes(value);
  return (
    <div className={`option-item-custom option-item${on ? ' selected' : ''}`}
         onClick={() => onToggle(value, on)}>
      {e.author}
    </div>
  );
}

// Markup mirrors views/settings.ejs exactly - same class names, same nesting.
// An earlier version used `tg-module-row` and a bare checkbox, neither of which
// exists in the stylesheet, so the whole block rendered unstyled: no row
// layout, no custom checkbox, no description text.
function TelegramModule({ label, hint, checked, onToggle, onTest, time, onTime, busy, timeId }) {
  return (
    <div className="tg-module">
      <label className="tg-row tg-row-module">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="tg-check material-symbols-rounded" aria-hidden="true"></span>
        <span><strong>{label}</strong><em>{hint}</em></span>
      </label>
      <button type="button" className="tg-send-btn" onClick={onTest} disabled={busy}
              title={`Send a ${label} notification now`}>
        <span className="material-symbols-rounded">send</span>
        {busy ? '…' : 'Send now'}
      </button>
      {time !== undefined && (
        <div className="form-floating tg-time">
          <input className="form-control" type="time" id={timeId} value={time}
                 onChange={(e) => onTime(e.target.value)} />
          <label htmlFor={timeId}>Send at</label>
        </div>
      )}
    </div>
  );
}