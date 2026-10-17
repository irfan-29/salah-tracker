import { useEffect } from 'react';

// Share buttons delegate to this.
//
// The EJS version of this lived in views/footer.ejs as an inline script. The
// React tree does not render footer.ejs, so without this the Share buttons were
// present and did nothing - a silent failure that only shows up when clicked.
//
// Delegated on document because the buttons live inside post cards and the
// favourites list, which are re-rendered wholesale.

function flashCopied(button) {
  const label = button.querySelector('.post-share-label');
  button.dataset.copied = 'true';
  if (label) label.textContent = 'Link copied';
  setTimeout(() => {
    delete button.dataset.copied;
    if (label) label.textContent = 'Share';
  }, 1600);
}

async function share(button) {
  const url = button.dataset.shareUrl;
  if (!url) return;

  // navigator.share is the better experience where it exists, but it is absent
  // on desktop Chrome and on any non-secure origin, so the clipboard has to be
  // the primary path rather than the fallback.
  if (navigator.share) {
    try {
      await navigator.share({ title: document.title, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user dismissed
      // Fall through to copying.
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    flashCopied(button);
  } catch (err) {
    // The clipboard API needs a secure context. Select the text instead of
    // silently doing nothing.
    const field = document.createElement('textarea');
    field.value = url;
    field.setAttribute('readonly', '');
    field.style.position = 'absolute';
    field.style.left = '-9999px';
    document.body.appendChild(field);
    field.select();
    try { document.execCommand('copy'); flashCopied(button); } catch (e) { /* nothing left to try */ }
    document.body.removeChild(field);
  }
}

export default function useShareHandler() {
  useEffect(() => {
    const onClick = (event) => {
      const button = event.target.closest('[data-share-url]');
      if (button) share(button);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}