import { ConvexError } from "convex/values";
import { Component, type ReactNode } from "react";

// The data of a backend error, which carries a `code` from
// `@agentdesk/contract` and optionally the failing `field`, or null for any
// other failure.
export function errorData(error: unknown): { code: string; field?: string } | null {
  if (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    typeof error.data.code === "string"
  ) {
    return error.data;
  }
  return null;
}

type Props = {
  children: ReactNode;
  fallback: (error: unknown, retry: () => void) => ReactNode;
};

// Convex's useQuery throws a failed query's error while rendering. This
// boundary shows `fallback` instead of the screen, and `retry` renders the
// screen again, which subscribes to the query again. Give the boundary a
// `key` that changes with the screen's input, so a new input starts clean.
export class QueryErrorBoundary extends Component<Props, { error: unknown; failed: boolean }> {
  override state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  retry = () => {
    this.setState({ error: null, failed: false });
  };

  override render() {
    if (this.state.failed) {
      return this.props.fallback(this.state.error, this.retry);
    }
    return this.props.children;
  }
}
