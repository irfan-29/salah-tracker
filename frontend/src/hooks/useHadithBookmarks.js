import { useCallback, useEffect, useRef, useState } from 'react';
import { hadiths } from '../services/api';

// Hadith bookmarks mirror useFavourites: one hook owns the state, so a bookmark
// toggled in the reader and the list on the collections page can never
// disagree. Only coordinates ({ collection, number }) are stored on the user;
// the texts in the list are resolved server-side from the same cached section
// documents the reader uses.
export function useHadithBookmarks() {
  const [bookmarks, setBookmarks] = useState([]);
  const [loaded, setLoaded] = useState(false);
  // True once the server has answered 401 - the Bookmarks tab uses it to show
  // the sign-in gate instead of a wrongly-empty list.
  const [signedOut, setSignedOut] = useState(false);
  const keysRef = useRef(new Set());

  const reload = useCallback(async () => {
    try {
      const data = await hadiths.bookmarks();
      const entries = data.entries || [];
      keysRef.current = new Set(entries.map((b) => `${b.collection}:${b.number}`));
      setBookmarks(entries);
      setSignedOut(false);
      setLoaded(true);
      return entries;
    } catch (err) {
      // 401 means signed out - an empty list is the correct representation.
      if (err.status === 401) {
        keysRef.current = new Set();
        setBookmarks([]);
        setSignedOut(true);
        setLoaded(true);
        return [];
      }
      return bookmarks;
    }
  }, [bookmarks]);

  useEffect(() => {
    reload();
    // Intentionally runs once: reload depends on bookmarks, and depending on it
    // here would refetch on every toggle.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isBookmarked = useCallback(
    (collection, number) => keysRef.current.has(`${collection}:${number}`),
    []
  );

  const toggleBookmark = useCallback(async (collection, number) => {
    const key = `${collection}:${number}`;
    const wasOn = keysRef.current.has(key);

    // Optimistic, so the bookmark responds on the click. Rolled back below if
    // the server disagrees.
    if (wasOn) keysRef.current.delete(key); else keysRef.current.add(key);
    setBookmarks((current) => {
      if (wasOn) {
        return current.filter((b) => !(b.collection === collection && Number(b.number) === Number(number)));
      }
      return [{ collection, number }, ...current];
    });

    try {
      const result = await hadiths.toggleBookmark(collection, number);
      await reload();
      return result.bookmarked;
    } catch (err) {
      if (wasOn) keysRef.current.add(key); else keysRef.current.delete(key);
      await reload();
      return wasOn;
    }
  }, [reload]);

  return { bookmarks, loaded, signedOut, isBookmarked, toggleBookmark, reload };
}
