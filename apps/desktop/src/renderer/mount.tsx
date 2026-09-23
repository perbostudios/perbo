import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/caveat/500.css";
// motion.css first: tokens.css maps its colour tokens onto the theme, and the later sheet wins at :root.
import "./ui/motion.css";
import "./ui/tokens.css";
import "./styles.css";
import { App } from "./shell/App.js";
import { SurfaceProvider, type Surface } from "./shell/surface.js";
import { bridge } from "./workspace/index.js";
import { flushContractEditors } from "./contract-editor.js";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { message: string | null }
> {
  override state = { message: null as string | null };
  static getDerivedStateFromError(error: Error): { message: string } {
    return { message: error.message };
  }
  override render(): React.ReactNode {
    return this.state.message ? (
      <main className="fatal">
        <h1>Let’s get you back.</h1>
        <p>
          The interface couldn’t render this record. Your CLI records are still
          on disk.
        </p>
        <pre>{this.state.message}</pre>
        <button onClick={() => location.reload()}>Reload Perbo</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});
/** Render the app into `root`, against whatever adapter fills `window.perbo`. */
export function mountApp(root: HTMLElement, surface: Surface = "native"): void {
  bridge.beforeClose?.(flushContractEditors);
  createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={client}>
          <SurfaceProvider value={surface}>
            <App />
          </SurfaceProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
