// Thin fetch wrapper over the backend.
//
// Same-origin on purpose. The frontend calls /api/* on its own domain and Vercel
// rewrites those to the Express backend, so requests never leave the origin and
// the session cookie plus the signed guest cookie are sent automatically.
//
// This is the one deliberate divergence from the nafahperfumes frontend, which
// points axios straight at the backend URL with `withCredentials: false` and a
// Bearer token in localStorage. That is fine there because it has no cookies;
// this app does, and a cross-origin call would force SameSite=None and break
// the guest store that holds a signed-out visitor's data.

const BASE = '/api';

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(BASE + path, {
    method,
    // Explicit even though same-origin: it documents the requirement and keeps
    // this working if the backend is ever called cross-origin.
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (err) {
      // A non-JSON body means we hit a page route rather than an API route.
      // Surfacing it as an error is more useful than silently passing on HTML.
      throw new ApiError(`Unexpected non-JSON response (${response.status})`, response.status, text.slice(0, 200));
    }
  }

  if (!response.ok) {
    const message = (payload && (payload.error || payload.message)) || `Request failed (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }

  return payload;
}

export const api = {
  get: (path, opts) => request(path, opts),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
};

// ---- Quran module --------------------------------------------------------

export const quran = {
  index: () => api.get('/quran/index'),
  surah: (no) => api.get(`/quran/surah/${no}`),
  reciters: () => api.get('/quran/reciters'),
  audio: (surahNo, reciter) =>
    api.get(`/quran/audio?surahNo=${encodeURIComponent(surahNo)}` + (reciter ? `&reciter=${encodeURIComponent(reciter)}` : '')),
  saveReciter: (reciter) => api.post('/quran/reciter', { reciter }),
  favourites: () => api.get('/quran/favourites'),
  progress: () => api.get('/quran/progress'),
  saveProgress: (payload) => api.post('/quran/progress', payload),
  toggleFavourite: (surahNo, ayahNo) => api.post('/quran/favourites/toggle', { surahNo, ayahNo }),
};

export { ApiError };