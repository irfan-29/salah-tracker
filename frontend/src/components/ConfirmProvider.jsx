import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

// In-app replacement for window.confirm. A browser alert is a poor fit for the
// installed app: on Android it draws a bare system dialog outside the app's
// chrome, and inside the APK's WebView it can be suppressed entirely. Pages
// call `const ask = useConfirm()` and `await ask({ ... })` - a promise that
// resolves true only when the confirm button is pressed.
const ConfirmContext = createContext(() => Promise.resolve(false));

export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback((options) => {
    return new Promise((resolve) => {
      resolver.current = resolve;
      setDialog({
        title: (options && options.title) || 'Are you sure?',
        message: (options && options.message) || '',
        confirmLabel: (options && options.confirmLabel) || 'Confirm',
        danger: !!(options && options.danger)
      });
    });
  }, []);

  const settle = (answer) => {
    setDialog(null);
    if (resolver.current) {
      resolver.current(answer);
      resolver.current = null;
    }
  };

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {dialog && (
        <div className="confirm-overlay" role="presentation" onClick={() => settle(false)}>
          <div
            className="confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-label={dialog.title}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="confirm-title">{dialog.title}</h3>
            {dialog.message && <p className="confirm-message">{dialog.message}</p>}
            <div className="confirm-actions">
              <button type="button" className="btn btn-outline" onClick={() => settle(false)}>
                Cancel
              </button>
              <button
                type="button"
                className={`btn ${dialog.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => settle(true)}
              >
                {dialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ask = useContext(ConfirmContext);
  return ask;
}
