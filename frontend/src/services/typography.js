// Interface typography applier.
//
// The Settings page and the shell both need to turn the stored preferences
// (appFont + the two text-size percents) into live DOM, so the logic lives
// here rather than in App.jsx. `persist=false` runs it as a dry preview:
// the DOM updates for the current page but localStorage keeps the saved
// values, so a reload replays what is actually stored.

// Storage keys duplicated with the pre-paint script in index.html, exactly
// like THEME_STORAGE_KEY: the inline script cannot import from the bundle it
// races, so both sites must stay byte-compatible.
export const APP_FONT_STORAGE_KEY = 'salah-appfont';
export const APP_SCALE_STORAGE_KEY = 'salah-appscale';
export const QURAN_SCALE_STORAGE_KEY = 'salah-qscale';

// The font ids the Settings page offers, mirrored by the CSS rules keyed off
// html[data-app-font=...]. "default" deliberately has no attribute: the
// stylesheet's :root stack (Plus Jakarta Sans) is the unmodified current face.
export const APP_FONT_IDS = ['default', 'inter', 'roboto', 'poppins', 'nunito', 'lora'];

// Clamp to the same 80-150 range the server enforces, so a stale or corrupted
// value cannot set a 2px root font.
function clampPercent(value) {
  return Math.min(150, Math.max(80, Math.round(Number(value) || 100)));
}

export function applyTypography(t, { persist = true } = {}) {
  const root = document.documentElement;
  const font = APP_FONT_IDS.includes(t.appFont) ? t.appFont : 'default';
  if (font === 'default') root.removeAttribute('data-app-font');
  else root.setAttribute('data-app-font', font);
  const appSize = clampPercent(t.appFontSize);
  const quranSize = clampPercent(t.quranFontSize);
  root.style.setProperty('--app-font-scale', String(appSize / 100));
  root.style.setProperty('--quran-font-scale', String(quranSize / 100));
  if (persist) {
    try {
      localStorage.setItem(APP_FONT_STORAGE_KEY, font);
      localStorage.setItem(APP_SCALE_STORAGE_KEY, String(appSize));
      localStorage.setItem(QURAN_SCALE_STORAGE_KEY, String(quranSize));
    } catch (err) {
      // Private mode: the current page still gets the setting applied.
    }
  }
}
