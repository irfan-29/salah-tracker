import { useCallback, useEffect, useRef, useState } from 'react';
import { quran } from '../services/api';

// Favourites live in one hook rather than per component, so a heart toggled in
// the reader and the list shown in the tab can never disagree. The previous
// EJS version had two independent copies of this state.
export function useFavourites() {
  const [favourites, setFavourites] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const keysRef = useRef(new Set());

  const reload = useCallback(async () => {
    try {
      const data = await quran.favourites();
      const entries = data.entries || [];
      keysRef.current = new Set(entries.map((f) => `${f.surahNo}:${f.ayahNo}`));
      setFavourites(entries);
      setLoaded(true);
      return entries;
    } catch (err) {
      // 401 means signed out - an empty list is the correct representation.
      if (err.status === 401) {
        keysRef.current = new Set();
        setFavourites([]);
        setLoaded(true);
        return [];
      }
      return favourites;
    }
  }, [favourites]);

  useEffect(() => {
    reload();
    // Intentionally runs once: reload depends on favourites, and depending on it
    // here would refetch on every toggle.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isFavourite = useCallback((surahNo, ayahNo) => keysRef.current.has(`${surahNo}:${ayahNo}`), []);

  const toggleFavourite = useCallback(async (surahNo, ayahNo) => {
    const key = `${surahNo}:${ayahNo}`;
    const wasOn = keysRef.current.has(key);

    // Optimistic, so the heart responds on the click. Rolled back below if the
    // server disagrees.
    if (wasOn) keysRef.current.delete(key); else keysRef.current.add(key);
    setFavourites((current) => {
      if (wasOn) return current.filter((f) => !(f.surahNo === surahNo && f.ayahNo === ayahNo));
      return [{ surahNo, ayahNo }, ...current];
    });

    try {
      const result = await quran.toggleFavourite(surahNo, ayahNo);
      await reload();
      return result.favorited;
    } catch (err) {
      if (wasOn) keysRef.current.add(key); else keysRef.current.delete(key);
      await reload();
      return wasOn;
    }
  }, [reload]);

  return { favourites, loaded, isFavourite, toggleFavourite, reload };
}
