import { useEffect } from 'react';
import { useAudio } from './AudioProvider';
import { quran } from '../services/api';

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Sits at the app root, outside <Routes>. This is the component that makes
// playback continuous - React never unmounts it, so the underlying <audio>
// element survives every route change.
export default function Player() {
  const { track, playing, position, duration, toggle, seek, close, load, hasTrack } = useAudio();

  // On first mount, show the saved track in the bar. load() deliberately does
  // not start playback: browsers block autoplay without a gesture anyway, and
  // silently beginning recitation on page load would be worse than presenting a
  // paused bar the user can resume.
  useEffect(() => {
    let cancelled = false;
    quran.progress()
      .then((data) => {
        if (cancelled || !data || !data.track) return;
        load(data.track);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasTrack) return null;

  const pct = duration > 0 ? (position / duration) * 100 : 0;

  return (
    <div className="player-bar">
      <div className="player-inner">
        <div className="player-meta">
          <span className="player-art material-symbols-rounded">graphic_eq</span>
          <div>
            <p className="player-title">{track.surahNo}. {track.surahName}</p>
            <p className="player-reciter">{track.reciterName}</p>
          </div>
        </div>

        <div className="player-controls">
          <button type="button" className="player-btn" onClick={toggle}
                  aria-label={playing ? 'Pause' : 'Play'}>
            <span className="material-symbols-rounded">{playing ? 'pause' : 'play_arrow'}</span>
          </button>

          <div className="player-progress">
            <span className="player-time">{formatTime(position)}</span>
            <div className="player-track" onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              seek((e.clientX - rect.left) / rect.width);
            }} role="slider" aria-label="Seek" tabIndex={0}>
              <div className="player-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="player-time">{formatTime(duration)}</span>
          </div>
        </div>

        <button type="button" className="player-close" onClick={close} aria-label="Close audio">
          <span className="material-symbols-rounded">close</span>
        </button>
      </div>
    </div>
  );
}