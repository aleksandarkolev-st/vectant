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
          <AlertTriangle size={32} className="text-yellow-400 mb-3" />
          <h3 className="text-sm font-medium text-white/80 mb-1">
            AI Healing panel error
          </h3>
          <p className="text-xs text-white/40 mb-3 max-w-xs">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>

          <button
            onClick={this.handleRetry}
            className="flex items-center gap-1.5 text-xs bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 px-3 py-1.5 rounded transition-colors"
          >
            <RefreshCcw size={12} />
            Retry
          </button>

          {process.env.NODE_ENV === 'development' && this.state.errorInfo && (
            <details className="mt-4 text-left w-full">
              <summary className="text-[10px] text-white/30 cursor-pointer">
                Stack trace (dev only)
              </summary>
              <pre className="mt-1 text-[9px] text-white/20 overflow-auto max-h-32 bg-black/30 p-2 rounded">
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
