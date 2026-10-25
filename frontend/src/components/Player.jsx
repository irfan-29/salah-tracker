import { useEffect, useRef, useState } from 'react';
import { useAudio } from './AudioProvider';
import { quran } from '../services/api';

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Same class names and structure as the audio bar in views/footer.ejs, so the
// existing stylesheet renders it identically. The difference is where it lives:
// here it is mounted above the router, which is why playback survives
// navigation.
export default function Player() {
  const { track, playing, position, duration, toggle, seek, close, load, hasTrack,
          skip, canSkipBack, canSkipForward } = useAudio();
  const [restored, setRestored] = useState(false);
  const [scrubPct, setScrubPct] = useState(null);
  const trackRef = useRef(null);
  const rangeRef = useRef(null);
  const dragging = useRef(false);

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
    <div className="global-audio-bar" id="globalAudioBar">
      <div className="audio-bar-inner">
        <div className="audio-bar-track-info">
          <div className="audio-artwork">
            <img src="/images/audio-player.webp" alt="Quran Audio" className="rotating-icon" />
          </div>
          <div className="audio-track-meta">
            <div className="surah-title">{track.surahNo}. {track.surahName}</div>
            <div className="reciter-name">{track.reciterName}</div>
          </div>
        </div>

        <div className="audio-bar-center">
          {/* Same three controls as views/footer.ejs: previous, play/pause,
              next. The port kept only the middle one. Disabled at the ends of
              the Quran rather than silently doing nothing. */}
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

        <button type="button" className="audio-close-btn" onClick={close} aria-label="Close audio">
          <span className="material-symbols-rounded">close</span>
        </button>
      </div>
    </div>
  );
}