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

  // --- Loop (repeat the recitation) ------------------------------------------
  //
  // `loop` is the reader's choice and drives the dock badge: 0 off, then 1, 2,
  // 3 repeats of the current surah once it finishes, cycling back to 0.
  // `loopsLeft` is the live count shown on the button: it starts at the chosen
  // number and drains as each repeat is consumed, so after the last replay the
  // badge returns to off and a finished track stops as it always did.
  //
  // The ref mirrors the mode synchronously because React state commits lag
  // behind clicks: two rapid taps on the cycle button must read 0 -> 1 -> 2,
  // not compute twice from the same stale 0 and land on 2 twice.
  const [loop, setLoop] = useState(0);
  const [loopsLeft, setLoopsLeft] = useState(0);
  const loopState = useRef({ mode: 0, left: 0 });

  const setLoopCount = useCallback((count) => {
    const mode = Math.min(3, Math.max(0, Math.round(Number(count)) || 0));
    // Selecting a mode re-arms the full count even mid-playback.
    loopState.current = { mode, left: mode };
    setLoop(mode);
    setLoopsLeft(mode);
  }, []);

  const cycleLoop = useCallback(() => {
    // Reads the ref, not the state: setLoopCount plays through ref + both
    // setters, so batched clicks advance one mode per tap.
    setLoopCount((loopState.current.mode + 1) % 4);
  }, [setLoopCount]);

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
      // A different surah gets the full repeat allowance again: the armed
      // loop applies to whatever the listener queued, not just the surah it
      // was armed on.
      loopState.current = { mode: loopState.current.mode, left: loopState.current.mode };
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

  // Pause only. The sleep timer needs it: when a countdown elapses the player
  // should stop where the listener dozed off, not close and discard the saved
  // resume position the way close() would.
  const pause = useCallback(() => {
    if (audio && !audio.paused) audio.pause();
  }, [audio]);

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
    const clamped = Math.min(1, Math.max(0, Number(fraction) || 0));
    const next = clamped * audio.duration;
    try {
      audio.currentTime = next;
    } catch (err) {
      return;
    }
    // Move the fill immediately. The next timeupdate tick would otherwise make
    // a completed drag look as if it had not registered for up to 250ms.
    setPosition(next);
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
    const onEnded = () => {
      // Replay first, drain second: picking a count must always replay the
      // recitation. The previous decrement-first order consumed the last
      // repeat before starting it, so a fresh count of 1 ended exactly like
      // loop off - the reader's complaint. Now the replay starts on this
      // 'ended' and the choice spends itself as each replay begins, so a
      // count of 1 plays one replay and then stops; 2 plays two, 3 three.
      const info = loopState.current;
      if (info && info.left > 0) {
        audio.currentTime = 0;
        const replay = audio.play();
        if (replay && typeof replay.catch === 'function') replay.catch(() => {});
        setPlaying(true);
        info.left -= 1;
        setLoopsLeft(info.left);
        if (info.left === 0) {
          // Spent: the badge resets to off while this last replay runs, and
          // its own 'ended' falls through to the normal stop below.
          info.mode = 0;
          setLoop(0);
        }
        return;
      }
      setPlaying(false);
      savePosition(true);
    };

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

  // System media controls: lock screen, notification shade, headphone and
  // Bluetooth buttons, car displays.
  //
  // Two targets, same handlers:
  // - navigator.mediaSession, which Chrome, the installed PWA and the Play
  //   Store (TWA) build turn into the lock-screen player.
  // - window.HasanathAndroid.media(), the native bridge in the Android APK.
  //   Android WebView has no Media Session API, so the APK draws its own
  //   notification and calls window.__hasanathMedia(action, value) back.
  const mediaHandlers = useMemo(() => {
    if (!audio || !track) return null;
    const surahNo = Number(track.surahNo);
    return {
      play: () => { audio.play().catch(() => {}); },
      pause: () => audio.pause(),
      stop: () => audio.pause(),
      previoustrack: surahNo > 1 ? () => skip(-1) : null,
      nexttrack: surahNo < 114 ? () => skip(1) : null,
      seekto: (details) => {
        const t = Number(details && details.seekTime);
        if (isFinite(t)) audio.currentTime = Math.max(0, t);
      },
      seekbackward: (details) => {
        audio.currentTime = Math.max(0, audio.currentTime - ((details && details.seekOffset) || 10));
      },
      seekforward: (details) => {
        const end = isFinite(audio.duration) ? audio.duration : Infinity;
        audio.currentTime = Math.min(end, audio.currentTime + ((details && details.seekOffset) || 10));
      },
    };
  }, [audio, track, skip]);

  useEffect(() => {
    const ms = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;

    window.__hasanathMedia = (action, value) => {
      const handler = mediaHandlers && mediaHandlers[action];
      if (handler) handler({ seekTime: Number(value) / 1000 });
    };

    if (!ms) return undefined;
    if (!track || !mediaHandlers) {
      ms.metadata = null;
      ms.playbackState = 'none';
      return undefined;
    }

    if (typeof window.MediaMetadata === 'function') {
      ms.metadata = new window.MediaMetadata({
        title: track.surahName ? `${track.surahNo}. ${track.surahName}` : "Qur'an recitation",
        artist: track.reciterName || '',
        album: 'Hasanath',
        artwork: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
    }
    const actions = Object.keys(mediaHandlers);
    actions.forEach((action) => {
      try { ms.setActionHandler(action, mediaHandlers[action]); } catch (err) { /* unsupported action */ }
    });
    return () => {
      actions.forEach((action) => {
        try { ms.setActionHandler(action, null); } catch (err) { /* unsupported action */ }
      });
    };
  }, [track, mediaHandlers]);

  // Playback state and position. The system player interpolates the progress
  // bar itself from position + playback rate, so this only needs to run when
  // something changes (play, pause, seek, new duration), not on every tick.
  useEffect(() => {
    if (!audio) return undefined;
    const ms = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;
    const bridge = typeof window !== 'undefined' && window.HasanathAndroid
      && typeof window.HasanathAndroid.media === 'function' ? window.HasanathAndroid : null;

    const sync = () => {
      const dur = isFinite(audio.duration) ? audio.duration : 0;
      if (ms) {
        ms.playbackState = !track ? 'none' : (audio.paused ? 'paused' : 'playing');
        if (track && dur > 0 && typeof ms.setPositionState === 'function') {
          try {
            ms.setPositionState({
              duration: dur,
              playbackRate: audio.playbackRate || 1,
              position: Math.min(audio.currentTime, dur),
            });
          } catch (err) { /* position briefly past duration while seeking */ }
        }
      }
      if (bridge) {
        try {
          bridge.media(JSON.stringify(!track ? { state: 'none' } : {
            state: audio.paused ? 'paused' : 'playing',
            title: track.surahName ? `${track.surahNo}. ${track.surahName}` : "Qur'an recitation",
            artist: track.reciterName || '',
            positionMs: Math.round(audio.currentTime * 1000),
            durationMs: Math.round(dur * 1000),
            canPrev: Number(track.surahNo) > 1,
            canNext: Number(track.surahNo) < 114,
          }));
        } catch (err) { /* bridge unavailable */ }
      }
    };

    sync();
    const events = ['play', 'pause', 'seeked', 'loadedmetadata', 'ratechange', 'ended'];
    events.forEach((e) => audio.addEventListener(e, sync));
    return () => events.forEach((e) => audio.removeEventListener(e, sync));
  }, [audio, track, playing, duration]);

  const value = useMemo(() => ({
    track, playing, position, duration,
    play, load, toggle, pause, seek, close, savePosition, skip,
    loop, loopsLeft, cycleLoop, setLoopCount,
    hasTrack: Boolean(track),
    canSkipBack: Boolean(track) && Number(track.surahNo) > 1,
    canSkipForward: Boolean(track) && Number(track.surahNo) < 114,
  }), [track, playing, position, duration, play, load, toggle, pause, seek, close, savePosition, skip, loop, loopsLeft, cycleLoop, setLoopCount]);

  return <AudioContext.Provider value={value}>{children}</AudioContext.Provider>;
}

export function useAudio() {
  const ctx = useContext(AudioContext);
  if (!ctx) throw new Error('useAudio must be used inside <AudioProvider>');
  return ctx;
}