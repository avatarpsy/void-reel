import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** A node, or a render function that receives the error and a retry that
   *  remounts the subtree — the latter so a fallback can SAY what broke. */
  fallback?:
    | React.ReactNode
    | ((error: Error | null, retry: () => void) => React.ReactNode);
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[ErrorBoundary] Component error:", error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (typeof this.props.fallback === "function") {
        return this.props.fallback(this.state.error, this.handleRetry);
      }
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center p-8 text-center bg-background-secondary/50 rounded-lg m-2">
          <div className="text-red-400 text-sm font-medium mb-2">
            Something went wrong
          </div>
          <div className="text-text-muted text-xs mb-4 max-w-xs">
            {this.state.error?.message || "An unexpected error occurred"}
          </div>
          <button
            onClick={this.handleRetry}
            className="px-4 py-2 bg-primary/20 hover:bg-primary/30 text-primary text-xs rounded transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

interface PanelErrorBoundaryProps {
  name: string;
  children: React.ReactNode;
}

/**
 * A panel that crashed, WITH the reason.
 *
 * The old fallback said only "<name> failed to load. Please refresh the page."
 * That advice is usually wrong — a panel most often dies on persisted project
 * data, so every refresh reproduces it — and it hid the one thing anybody
 * needed: the error. The Assets panel sat broken for weeks as "root cause never
 * diagnosed" because of it. Show the message, offer a real retry (remounting
 * the subtree is what "refresh" was reaching for), and keep the panel's own
 * background so a dead panel still reads as part of the editor.
 */
export const PanelErrorBoundary: React.FC<PanelErrorBoundaryProps> = ({
  name,
  children,
}) => (
  <ErrorBoundary
    fallback={(error, retry) => (
      <div className="flex-1 min-w-0 flex items-center justify-center p-6 bg-background-secondary">
        <div className="max-w-xs text-center">
          <div className="text-text-primary text-xs font-medium mb-1.5">
            {name} couldn’t open
          </div>
          <div className="text-text-muted text-[11px] leading-relaxed mb-3 break-words">
            {error?.message || "An unexpected error occurred"}
          </div>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={retry}
              className="px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary text-[11px] rounded transition-colors"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 text-text-secondary hover:text-text-primary text-[11px] rounded transition-colors"
            >
              Reload editor
            </button>
          </div>
        </div>
      </div>
    )}
  >
    {children}
  </ErrorBoundary>
);
