import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import "./app/styles.css";

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Hivo Studio render failed", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-error-boundary">
          <div className="app-error-card">
            <strong>Hivo Studio could not render this chat.</strong>
            <p>{this.state.error.message}</p>
            <button onClick={() => window.location.reload()} type="button">Reload Hivo Studio</button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
