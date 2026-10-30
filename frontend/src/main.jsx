import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

// The app stylesheet, not a copy. See scripts/sync-frontend-css.js.
import './styles/base.css';
import './styles/shell.css';

// The boot loader in index.html exists to cover the gap before any of this has
// downloaded. Remove it only once React has actually painted, so it never blinks
// out and back in.
const bootLoader = document.getElementById('boot-loader');
function dismissBootLoader() {
  if (!bootLoader) return;
  bootLoader.hidden = true;
  // Remove rather than just hide, so it cannot trap focus or be picked up by a
  // later querySelector.
  bootLoader.remove();
}

createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      {/* Outermost, so it also covers a crash inside BrowserRouter or App
          itself. Without it a render error unmounts everything and the user
          gets a white page with no way back - the failure mode that hit this
          app twice during the React migration. */}
      <ErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>
  );

// requestAnimationFrame twice: once to let React commit, once to be sure the
// browser has painted the result.
requestAnimationFrame(() => requestAnimationFrame(dismissBootLoader));

// Service worker: makes Hasanath installable and lets the Android app open on a
// flaky connection. Production only, so `npm run dev` never serves a cached
// shell over your live edits. Registered after load so it never competes with
// the first paint.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
