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
  request,
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
  // Told to the server when the player is dismissed, so the next page load does
  // not restore a bar the user just closed. See AudioProvider.close().
  clearProgress: () => api.request('/quran/progress', { method: 'DELETE' }),
  toggleFavourite: (surahNo, ayahNo) => api.post('/quran/favourites/toggle', { surahNo, ayahNo }),
};

// ---- Challenges, salah, posts, profile, account, settings ----

export const challenges = {
  list: () => api.get('/challenges'),
  create: (challenge) => api.post('/challenges', { challenge }),
  rename: (id, challenge) => api.post(`/challenges/${id}`, { challenge }),
  remove: (id) => api.request(`/challenges/${id}`, { method: 'DELETE' }),
  saveStreaks: (payload) => api.post('/challenges/streaks', payload),
};

export const salah = {
  list: (date) => api.get('/salah' + (date ? `?date=${encodeURIComponent(date)}` : '')),
  record: (payload) => api.post('/salah', payload),
};

export const posts = {
  list: () => api.get('/posts'),
  create: (payload) => api.post('/posts', payload),
  one: (id) => api.get(`/posts/${id}`),
  // PATCH, not PUT: only content/reference are accepted, and the server keeps
  // the post type (text vs video) fixed at creation.
  update: (id, payload) => api.request(`/posts/${id}`, { method: 'PATCH', body: payload }),
  remove: (id) => api.request(`/posts/${id}`, { method: 'DELETE' }),
  profile: (username) => api.get(`/u/${encodeURIComponent(username)}`),
};

export const account = {
  me: () => api.get('/account'),
};

export const settings = {
  get: () => api.get('/settings'),
};

export { ApiError };