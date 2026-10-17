import { Component } from 'react';

// Last line of defence against a blank page.
//
// views/error.ejs existed for the server-rendered pages. Removing the EJS layer
// removed the only recovery path: a render error in React unmounts the whole
// tree, so without a boundary the user gets a white screen with nothing to
// click - which is exactly the symptom seen twice during this migration, once
// from a hook-order violation in Shell and once from useCallback being called
// without being imported.
//
// An error boundary catches errors thrown while RENDERING a component subtree.
// It deliberately does not catch async failures inside an event handler or a
// fetch - those set state and are handled where they happen.
//
// While developing it re-throws, so a bug is still loud in the console instead
// of being quietly replaced by a message box.

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Log, but do NOT re-throw.
    //
    // An earlier version re-threw in development "so bugs stay loud". That
    // defeated the entire component: re-throwing from componentDidCatch
    // unmounts the tree the boundary was there to protect, so a deliberate
    // crash produced a blank page instead of the error card - verified, not
    // assumed. The console already shows the stack; the user still needs a
    // page they can act on.
    console.error('render error:', error, info && info.componentStack);
  }

  reset() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="main-content" style={{ marginLeft: 0 }}>
        <div className="error-card">
          <span className="material-symbols-rounded error-icon">error_outline</span>
          <h2 style={{ fontWeight: 700, marginBottom: '0.75rem' }}>Something went wrong</h2>
          <p style={{ color: 'var(--color-text-secondary)' }}>
            {error.message || 'An unexpected error occurred.'}
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
            {/* Reset first, so a transient failure does not force a reload.
                Reload still offered because the error may be in persisted
                state - a bad setting, for instance. */}
            <button type="button" className="btn btn-primary" onClick={this.reset}>
              Try again
            </button>
            <a href="/" className="btn btn-secondary">Go Home</a>
          </div>
        </div>
      </div>
    );
  }
}