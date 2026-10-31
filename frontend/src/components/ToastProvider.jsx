import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

// Small self-dismissing confirmations for every write - "Challenge deleted",
// "Donation added" - the way most apps do it. Pages call `const toast =
// useToast()` and `toast('Challenge deleted')` after the request succeeds;
// each message hides itself after ~2.6s and stacked messages queue in a
// column above the tab bar.
const ToastContext = createContext(() => {});

let nextId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef({});

  const toast = useCallback((message, { kind = 'ok', duration = 2600 } = {}) => {
    const id = nextId += 1;
    setToasts((current) => [...current, { id, message, kind }]);
    // Keep the handle so a fast duplicate does not leave a dead timer that
    // filters a toast the list no longer has (harmless, but noisy).
    timers.current[id] = setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
      delete timers.current[id];
    }, duration);
  }, []);
  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="app-toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`app-toast app-toast-${t.kind}`}>
            <span className="material-symbols-rounded" aria-hidden="true">
              {t.kind === 'delete' ? 'delete' : t.kind === 'error' ? 'error' : 'check_circle'}
            </span>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const toast = useContext(ToastContext);
  // `toast(message)` → success pill; `toast(message, { kind: 'delete' })` →
  // the red destructive pill, so a removal never reads as a celebration.
  return toast;
}
