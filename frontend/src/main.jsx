import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';

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
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// requestAnimationFrame twice: once to let React commit, once to be sure the
// browser has painted the result.
requestAnimationFrame(() => requestAnimationFrame(dismissBootLoader));
