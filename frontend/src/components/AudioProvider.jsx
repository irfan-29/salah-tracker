import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { quran } from '../services/api';

// The persistent player.
//
// This is the entire point of the rewrite: the <audio> element is owned here,
// mounted once, above the router. Previously the reader had one element and the
// footer had another, so navigating tore down whichever one was playing and the
// other arrived paused. Nothing below this component can destroy it - React
// re-renders routes, it does not remount this tree.

const AudioContext = createContext(null);

export function AudioProvider({ children }) {
  const audioRef = useRef(null);
  if (audioRef.current === null && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    audioRef.current.preload = 'metadata';
  }
  const audio = audioRef.current;

  const [track, setTrack] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  // Persist the position so a full page load or a return visit resumes where
  // the user stopped. Throttled while playing, and forced on pause/unload -
  // the previous implementation only saved every 5s during playback, so closing
  // the tab mid-recitation lost up to five seconds.
  //
  // Guarded by dismissing, which close() sets. Without that guard the sequence
  // was: close() -> audio.pause() -> the pause handler below -> savePosition()
  // -> the bar wrote itself straight back to the database, so the next page load
  // restored a player the user had just dismissed.
  const lastSaved = useRef(0);
  const dismissing = useRef(false);

  const savePosition = useCallback(async (force = false) => {
    if (!audio || !track || !audio.src) return;
    if (dismissing.current) return;
    if (!force && Math.abs(audio.currentTime - lastSaved.current) < 5) return;
    lastSaved.current = audio.currentTime;
    try {
      await quran.saveProgress({
        surahNo: track.surahNo,
        surahName: track.surahName,
        time: audio.currentTime,
      });
    } catch (err) {
      // Losing a position is not worth interrupting playback over.
    }
  }, [audio, track]);

  const play = useCallback(async (next) => {
    if (!audio || !next || !next.url) return;
    // A fresh track is not a dismissal. Reset here rather than in a timeout
    // after close(), because play() can be called immediately after close() and
    // the guard has to be down before this track's first timeupdate.
    dismissing.current = false;
    const changed = !track || track.url !== next.url;

    setTrack({ ...next, surahNo: Number(next.surahNo) });
    audio.src = next.url;
    if (changed) {
      audio.currentTime = Number(next.startAt) || 0;
    }
    try {
      await audio.play();
    } catch (err) {
      // Autoplay can be refused when play() is not the direct result of a user
      // gesture. The UI stays correct either way - it simply shows paused.
    }
  }, [audio, track]);

  const toggle = useCallback(() => {
    if (!audio || !track) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }, [audio, track]);

  // Load a track into the bar WITHOUT starting it. Separate from play() because
  // conflating them meant restoring a saved position auto-played, which browsers
  // refuse anyway and which is intrusive when it does not.
  const load = useCallback((next) => {
    if (!audio || !next || !next.url) return;
    // Same reset as play(): the restore path below calls load() on every page
    // load, and it must not inherit a guard left standing by an earlier close.
    dismissing.current = false;
    setTrack({ ...next, surahNo: Number(next.surahNo) });
    audio.src = next.url;
    audio.load();
    const startAt = Number(next.startAt) || 0;
    if (startAt > 0) {
      const apply = () => { try { audio.currentTime = startAt; } catch (e) {} };
      if (audio.readyState >= 1) apply();
      else audio.addEventListener('loadedmetadata', apply, { once: true });
    }
  }, [audio]);

  const seek = useCallback((fraction) => {
    if (!audio || !isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = fraction * audio.duration;
  }, [audio]);

  const close = useCallback(() => {
    if (!audio) return;

    // Set BEFORE pause(). The pause event is dispatched asynchronously, so a
    // flag raised after audio.pause() can lose the race and the handler will
    // save the position of a player that is being thrown away.
    dismissing.current = true;

    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    setTrack(null);
    setPosition(0);
    setDuration(0);

    // Memory alone is not enough. The previous version of this function cleared
    // local state and stopped there, so the server still held the last saved
    // position and the next page load put the bar straight back. Cleared here
    // and never re-saved, because `dismissing` keeps the pause handler quiet.
    //
    // Deliberately not awaited: the bar closing should not wait on a round
    // trip, and a failed clear leaves the position merely resume-able rather
    // than broken. Fire-and-forget with the failure logged by the client.
    quran.clearProgress().catch(() => {});
  }, [audio]);

  useEffect(() => {
    if (!audio) return undefined;

    const onLoaded = () => setDuration(isFinite(audio.duration) ? audio.duration : 0);
    const onTime = () => {
      setPosition(audio.currentTime);
      savePosition(false);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => { setPlaying(false); savePosition(true); };
    const onEnded = () => { setPlaying(false); savePosition(true); };

    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);

    // pagehide rather than beforeunload: mobile Safari often skips the latter.
    const onHide = () => { savePosition(true); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);

    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [audio, savePosition]);

  // Previous / next surah.
  //
  // views/footer.ejs had skip_previous and skip_next beside the play button;
  // the React port dropped them, leaving a transport with no way to move
  // between surahs once playback had started.
  //
  // The track carries its surahNo and reciterId, so stepping resolves the
  // neighbouring surah through the same endpoint the Audio tab uses. The
  // reciter is passed explicitly rather than left to the server's saved
  // preference, so changing it in Settings mid-playback cannot silently change
  // the recitation mid-surah.
  const skip = useCallback(async (delta) => {
    if (!track || !Number.isInteger(Number(track.surahNo))) return;
    const target = Number(track.surahNo) + delta;
    if (target < 1 || target > 114) return;   // Al-Fatiha and An-Nas are the ends
    try {
      const next = await quran.audio(target, track.reciterId || "1");
      await play({
        url: next.url,
        surahNo: next.surahNo,
        surahName: next.surahName,
        reciterName: next.reciter,
        reciterId: next.reciterId,
        startAt: 0,
      });
    } catch (err) {
      // A missing recitation for one surah must not break the player; the
      // current track simply keeps playing.
    }
  }, [track, play]);

  const value = useMemo(() => ({
    track, playing, position, duration,
    play, load, toggle, seek, close, savePosition, skip,
    hasTrack: Boolean(track),
    canSkipBack: Boolean(track) && Number(track.surahNo) > 1,
    canSkipForward: Boolean(track) && Number(track.surahNo) < 114,
  }), [track, playing, position, duration, play, load, toggle, seek, close, savePosition, skip]);

  return <AudioContext.Provider value={value}>{children}</AudioContext.Provider>;
}

export function useAudio() {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used inside <AudioProvider>');
  return ctx;
}