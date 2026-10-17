import { useCallback, useEffect, useState } from 'react';

// Minimal request-state helper, so every page reports loading and failure the
// same way instead of each inventing its own `loading`/`error` pair - which is
// how one page ends up showing an empty state where another shows a spinner.
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  const run = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      setState({ loading: false, data, error: null });
      return data;
    } catch (err) {
      setState({ loading: false, data: null, error: err });
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ loading: true, data: null, error: null });
      try {
        const data = await fn();
        if (!cancelled) setState({ loading: false, data, error: null });
      } catch (err) {
        if (!cancelled) setState({ loading: false, data: null, error: err });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, reload: run };
}
