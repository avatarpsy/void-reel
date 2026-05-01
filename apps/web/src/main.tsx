import React from "react";
import ReactDOM from "react-dom/client";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import App from "./App";
import "./index.css";
import { registerServiceWorker } from "./services/service-worker";

const POSTHOG_KEY = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;

if (POSTHOG_KEY && POSTHOG_HOST) {
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: true,
    capture_pageleave: true,
  });
}

registerServiceWorker().then((registration) => {
  if (registration) {
  }
});

// Synchronous fail-fast cleanup of any stale Service Worker that was
// installed by an earlier standalone openreel build (origin localhost:5173).
// When this iframe loads in the embedded chat, that SW will intercept
// asset and API requests and serve cached responses pointing at a port
// that's no longer running — the user sees "localhost refused to
// connect" inside the iframe on first load. registerServiceWorker()
// also unregisters but its async cleanup runs after the lazy imports
// below have already gone through the SW. We fire an additional
// fire-and-forget cleanup HERE so the unregister starts before the
// React tree even begins importing chunks.
if (typeof window !== "undefined" && typeof navigator !== "undefined") {
  const isEmbedded =
    window.self !== window.top ||
    new URLSearchParams(window.location.search).get("embed") === "1";
  if (isEmbedded) {
    void (async () => {
      try {
        const regs = await navigator.serviceWorker?.getRegistrations?.();
        for (const r of regs ?? []) {
          try { await r.unregister(); } catch { /* ignore */ }
        }
        if (typeof caches !== "undefined" && caches.keys) {
          const keys = await caches.keys();
          for (const k of keys) {
            try { await caches.delete(k); } catch { /* ignore */ }
          }
        }
      } catch { /* best-effort */ }
    })();
  }
}

const root = document.getElementById("root")!;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {POSTHOG_KEY && POSTHOG_HOST ? (
      <PostHogProvider client={posthog}>
        <App />
      </PostHogProvider>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
