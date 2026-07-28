// src/components/healing/AIErrorBoundary.jsx
// Error boundary that catches React render errors in the AI healing
// panel and shows a recovery UI instead of crashing the whole editor.
'use client';

import React from 'react';
import { AlertTriangle, RefreshCcw } from 'lucide-react';


/**
 * React error boundary for AI healing components.
 *
 * Catches render-time exceptions and displays a recovery UI
 * with error details and a retry button.
 */
export class AIErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    console.error('[AIErrorBoundary] Caught error:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center p-6 text-center">
          <AlertTriangle size={32} className="mb-3" style={{ color: 'var(--accent-warning)' }} />
          <h3 className="mb-1 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Healing panel error
          </h3>
          <p className="mb-3 max-w-xs text-xs" style={{ color: 'var(--text-muted)' }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>

          <button
            onClick={this.handleRetry}
            className="th-focus-ring th-btn-ghost flex items-center gap-1.5 rounded-[var(--radius-control)] border px-3 py-1.5 text-xs transition-colors"
            style={{ color: 'var(--attention-purple)', borderColor: 'var(--border-subtle)' }}
          >
            <RefreshCcw size={12} />
            Retry
          </button>

          {process.env.NODE_ENV === 'development' && this.state.errorInfo && (
            <details className="mt-4 text-left w-full">
              <summary className="cursor-pointer text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Stack trace (dev only)
              </summary>
              <pre className="mt-1 max-h-32 overflow-auto rounded-[var(--radius-control)] p-2 text-[9px]" style={{ background: 'var(--bg-app)', color: 'var(--text-muted)' }}>
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
