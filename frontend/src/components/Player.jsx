import { useEffect, useState } from 'react';
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
  const { track, playing, position, duration, toggle, seek, close, load, hasTrack } = useAudio();
  const [restored, setRestored] = useState(false);

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

  const pct = duration > 0 ? (position / duration) * 100 : 0;

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
          <div className="audio-transport">
            <button type="button" className="audio-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
              <span className="material-symbols-rounded">{playing ? 'pause' : 'play_arrow'}</span>
            </button>
          </div>
          <div className="audio-progress-row">
            <span className="audio-time">{formatTime(position)}</span>
            <div className="audio-progress-track" onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              seek((e.clientX - rect.left) / rect.width);
            }}>
              <div className="audio-progress-fill" style={{ width: `${pct}%` }} />
              <input
                type="range"
                className="audio-progress-input"
                min="0"
                max="100"
                value={pct}
                aria-label="Seek"
                onChange={(e) => seek(Number(e.target.value) / 100)}
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