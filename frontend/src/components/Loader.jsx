import React from 'react';

// Branded loading state.
//
// The ring is an SVG circle whose stroke-dashoffset animates, so the brand
// colour genuinely fills the border rather than a spinner spinning over it.
// Drawn in SVG rather than CSS borders so the fill is continuous and the
// geometry is exact.
//
// Sizes:
//   fullPage - covers the viewport, used on first load
//   inline   - sits inside a content area, used while a page fetches
//   overlay  - absolute fill of its positioned parent

const SIZES = {
  fullPage: { ring: 72, logo: 34, label: true },
  // A whole page is still loading: fills the content column and centres, so the
  // spinner is not a small mark pinned to the top of the screen.
  page: { ring: 56, logo: 26, label: true },
  // A section within a loaded page: compact, no vertical reservation, so it
  // does not make the surrounding layout jump.
  inline: { ring: 40, logo: 20, label: false },
  overlay: { ring: 48, logo: 24, label: false },
};

export default function Loader({ variant = 'inline', label = 'Loading', className = '' }) {
  const size = SIZES[variant] || SIZES.inline;

  // Circumference for the dash trick. The ring is drawn at r = 42 inside a
  // 100x100 viewBox, so C = 2*pi*r.
  const r = 42;
  const c = 2 * Math.PI * r;

  const rootClass = [
    'app-loader',
    `app-loader--${variant}`,
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={rootClass} role="status" aria-live="polite" aria-busy="true">
      <div className="app-loader__ring">
        <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          {/* Track, so the unfilled portion is visible rather than transparent. */}
          <circle className="app-loader__track" cx="50" cy="50" r={r} />
          <circle
            className="app-loader__fill"
            cx="50" cy="50" r={r}
            strokeDasharray={c}
            strokeDashoffset={c * 0.75}
          />
        </svg>
        <span
          className="app-loader__logo material-symbols-rounded"
          style={{ fontSize: `${size.logo}px` }}
        >
          mosque
        </span>
      </div>
      {size.label && <span className="app-loader__label">{label}</span>}
      {/* Announced for screen readers; the visual label is decorative-ish. */}
      <span className="sr-only">{label}</span>
    </div>
  );
}