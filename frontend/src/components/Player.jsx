import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAudio } from './AudioProvider';
import { quran } from '../services/api';

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Countdown shown inside the sleep-timer button while a timer runs. Hours flip
// the label to h:mm:ss so even a 5h setting fits one line.
function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SLEEP_OPTIONS = [
  { id: 'off', label: 'Timer off', ms: 0 },
  { id: '15m', label: '15 minutes', ms: 15 * 60 * 1000 },
  { id: '30m', label: '30 minutes', ms: 30 * 60 * 1000 },
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '2h', label: '2 hours', ms: 2 * 60 * 60 * 1000 },
  { id: '3h', label: '3 hours', ms: 3 * 60 * 60 * 1000 },
  { id: '5h', label: '5 hours', ms: 5 * 60 * 60 * 1000 },
];
const SLEEP_MENU_WIDTH = 200;
// Seven rows at the app dropdown's row height, used for the flip-above check.
const SLEEP_MENU_HEIGHT = 332;

// Same class names and structure as the old audio bar, so the stylesheet
// renders it identically. The difference is where it lives: here it is mounted
// above the router, which is why playback survives navigation.
export default function Player() {
  const { track, playing, position, duration, toggle, pause, seek, close, load, hasTrack,
          skip, canSkipBack, canSkipForward } = useAudio();
  const [restored, setRestored] = useState(false);
  const [scrubPct, setScrubPct] = useState(null);
  const trackRef = useRef(null);
  const rangeRef = useRef(null);
  const dragging = useRef(false);

  // --- Sleep timer ---------------------------------------------------------
  // One absolute deadline rather than a paused "time left" counter, so the
  // countdown keeps running whether playback pauses or moves to another surah.
  // When it fires the audio pauses; the track stays loaded, so pressing play
  // resumes and the timer simply reads "off" until it is set again. The
  // countdown lives only in this component - close() clears it so the next
  // session starts fresh.
  const [sleepOpen, setSleepOpen] = useState(false);
  const [sleepActiveMs, setSleepActiveMs] = useState(0);
  const [sleepMenuPos, setSleepMenuPos] = useState(null);
  const sleepEndsAt = useRef(0);
  const sleepBtnRef = useRef(null);
  const sleepMenuRef = useRef(null);

  useEffect(() => {
    if (!sleepActiveMs) return undefined;
    const id = window.setInterval(() => {
      const remaining = sleepEndsAt.current - Date.now();
      if (remaining <= 0) {
        sleepEndsAt.current = 0;
        setSleepActiveMs(0);
        pause();
        return;
      }
      setSleepActiveMs(remaining);
    }, 500);
    return () => window.clearInterval(id);
  }, [sleepActiveMs, pause]);

  const chooseSleep = (option) => {
    if (!option.ms) {
      sleepEndsAt.current = 0;
      setSleepActiveMs(0);
    } else {
      sleepEndsAt.current = Date.now() + option.ms;
      setSleepActiveMs(option.ms);
    }
    setSleepOpen(false);
    sleepBtnRef.current?.focus();
  };

  // Outside pointer (or Escape) closes the sleep menu: the same contract the
  // app-wide FormSelect listbox follows.
  useEffect(() => {
    if (!sleepOpen) return undefined;
    const closeOnOutside = (event) => {
      if (!sleepBtnRef.current?.contains(event.target) && !sleepMenuRef.current?.contains(event.target)) {
        setSleepOpen(false);
      }
    };
    const closeOnKey = (event) => {
      if (event.key === 'Escape') setSleepOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnKey);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnKey);
    };
  }, [sleepOpen]);

  // Positioned from the button's rect, right-aligned to it (the button sits at
  // the right end of the bar) and flipped above the bar when there is not
  // enough room underneath - the dock sits low, so the usual case is up.
  useEffect(() => {
    if (!sleepOpen) return undefined;
    const place = () => {
      const rect = sleepBtnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 8;
      const width = Math.min(SLEEP_MENU_WIDTH, window.innerWidth - 16);
      const right = Math.min(rect.right, window.innerWidth - 8);
      const left = Math.max(8, right - width);
      const below = window.innerHeight - rect.bottom - gap;
      const openUp = below < SLEEP_MENU_HEIGHT && rect.top > SLEEP_MENU_HEIGHT;
      setSleepMenuPos({
        top: openUp ? Math.max(8, rect.top - SLEEP_MENU_HEIGHT - gap) : rect.bottom + gap,
        left,
        width,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [sleepOpen]);

  useEffect(() => {
    let cancelled = false;
    quran.progress()
      .then((data) => {
        if (cancelled || !data || !data.track) return;
        load(data.track);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setRestored(true); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!restored || !hasTrack) return null;

  const sleepLabel = sleepActiveMs
    ? `Sleep timer: about ${Math.ceil(sleepActiveMs / 60000)} minutes remaining`
    : 'Sleep timer';
  const isActiveSleepOption = (option) => (
    option.ms === 0
      ? sleepActiveMs === 0
      : sleepActiveMs > 0 && Math.round(sleepActiveMs / 60000) === Math.round(option.ms / 60000)
  );

  const pct = duration > 0
    ? (scrubPct !== null ? scrubPct : Math.min(100, Math.max(0, (position / duration) * 100)))
    : 0;

  // The native range stays for keyboard access, but pointer input is handled by
  // the track itself. The old input was clipped to the 4px rail, which made the
  // thumb almost impossible to grab. We also preview the selected position
  // locally while dragging instead of waiting for timeupdate to catch up.
  const fractionAt = (clientX) => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const preview = (clientX) => {
    const fraction = fractionAt(clientX);
    setScrubPct(fraction * 100);
    return fraction;
  };

  const beginScrub = (event) => {
    if (!duration || duration <= 0) return;
    event.preventDefault();
    dragging.current = true;
    try {
      trackRef.current?.setPointerCapture?.(event.pointerId);
    } catch (err) {
      // Pointer capture is a convenience; dragging still works without it.
    }
    preview(event.clientX);
    rangeRef.current?.focus({ preventScroll: true });
  };

  const moveScrub = (event) => {
    if (!dragging.current) return;
    preview(event.clientX);
  };

  const endScrub = (event) => {
    if (!dragging.current) return;
    dragging.current = false;
    const fraction = preview(event.clientX);
    try {
      trackRef.current?.releasePointerCapture?.(event.pointerId);
    } catch (err) {
      // Already released by the browser.
    }
    seek(fraction);
    setScrubPct(null);
  };

  const cancelScrub = (event) => {
    dragging.current = false;
    try {
      trackRef.current?.releasePointerCapture?.(event.pointerId);
    } catch (err) {
      // Already released by the browser.
    }
    setScrubPct(null);
  };

  return (
    <div className={`global-audio-bar${playing ? ' is-playing' : ''}`} id="globalAudioBar">
      <div className="audio-bar-inner">
        <div className="audio-bar-track-info">
          <span className={`audio-equalizer${playing ? ' is-playing' : ''}`} aria-hidden="true">
            <span /><span /><span /><span />
          </span>
          <div className="audio-track-meta">
            <div className="surah-title" title={`${track.surahNo}. ${track.surahName}`}>
              <span className="audio-track-title-text">{track.surahNo}. {track.surahName}</span>
            </div>
            <div className="reciter-name" title={track.reciterName || 'Qur’an recitation'}>
              {track.reciterName || 'Qur’an recitation'}
            </div>
          </div>
        </div>

        <div className="audio-bar-actions">
          {/* Transport: previous, play/pause, next. Disabled at the ends of the
              Quran rather than silently doing nothing. */}
          <div className="audio-transport">
            <button type="button" className="audio-btn" onClick={() => skip(-1)}
                    disabled={!canSkipBack} aria-label="Previous surah">
              <span className="material-symbols-rounded">skip_previous</span>
            </button>
            <button type="button" className="audio-btn audio-btn-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
              <span className="material-symbols-rounded">{playing ? 'pause' : 'play_arrow'}</span>
            </button>
            <button type="button" className="audio-btn" onClick={() => skip(1)}
                    disabled={!canSkipForward} aria-label="Next surah">
              <span className="material-symbols-rounded">skip_next</span>
            </button>
          </div>

          <button
            ref={sleepBtnRef}
            type="button"
            className={`audio-btn audio-sleep-btn${sleepActiveMs ? ' is-on' : ''}`}
            aria-label={sleepLabel}
            aria-haspopup="menu"
            aria-expanded={sleepOpen}
            title={sleepLabel}
            onClick={() => setSleepOpen((open) => !open)}
          >
            {sleepActiveMs
              ? <span className="audio-sleep-count">{formatRemaining(sleepActiveMs)}</span>
              : <span className="material-symbols-rounded" aria-hidden="true">bedtime</span>}
          </button>

          <button type="button" className="audio-btn audio-close-btn" onClick={close} aria-label="Close audio">
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>

        <div className="audio-progress-row">
          <span className="audio-time">{formatTime(scrubPct !== null ? (scrubPct / 100) * duration : position)}</span>
          <div
            ref={trackRef}
            className={`audio-progress-track${scrubPct !== null ? ' is-scrubbing' : ''}`}
            onPointerDown={beginScrub}
            onPointerMove={moveScrub}
            onPointerUp={endScrub}
            onPointerCancel={cancelScrub}
          >
            <div className="audio-progress-fill" style={{ width: `${pct}%` }} />
            <span
              className="audio-progress-thumb"
              style={{ left: `${pct}%`, display: duration > 0 ? undefined : 'none' }}
              aria-hidden="true"
            />
            <input
              ref={rangeRef}
              type="range"
              className="audio-progress-input"
              min="0"
              max="100"
              value={pct}
              aria-label="Seek"
              onChange={(e) => {
                const fraction = Number(e.target.value) / 100;
                setScrubPct(fraction * 100);
                seek(fraction);
                setScrubPct(null);
              }}
            />
          </div>
          <span className="audio-time">{formatTime(duration)}</span>
        </div>
      </div>

      {sleepOpen && createPortal(
        <div
          ref={sleepMenuRef}
          className="audio-sleep-menu"
          role="menu"
          aria-label="Sleep timer"
          style={{
            top: sleepMenuPos ? `${sleepMenuPos.top}px` : undefined,
            left: sleepMenuPos ? `${sleepMenuPos.left}px` : undefined,
            width: sleepMenuPos ? `${sleepMenuPos.width}px` : undefined,
            visibility: sleepMenuPos ? 'visible' : 'hidden',
          }}
        >
          <div className="audio-sleep-head">
            <span className="material-symbols-rounded" aria-hidden="true">bedtime</span>
            Sleep timer
          </div>
          {SLEEP_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitem"
              className={`audio-sleep-option${isActiveSleepOption(option) ? ' is-selected' : ''}`}
              onPointerEnter={(event) => event.currentTarget.classList.add('is-active')}
              onPointerLeave={(event) => event.currentTarget.classList.remove('is-active')}
              onClick={() => chooseSleep(option)}
            >
              <span>{option.label}</span>
              {isActiveSleepOption(option)
                && <span className="material-symbols-rounded" aria-hidden="true">check</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
