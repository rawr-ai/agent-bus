import { Component, type ReactNode } from "react";

/**
 * A render defect, such as a rejected observation invariant, replaces the viewer with a visible
 * stop instead of a blank page. It does not retry, recover or display the private cause.
 */
export class ViewerErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="viewer-stopped" role="alert">
        <h1>The viewer stopped</h1>
        <p>An observation could not be displayed. Reload to observe again.</p>
        <button type="button" className="read-context" onClick={() => location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
