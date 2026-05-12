import React from "react";
import ReactDOM from "react-dom/client";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import App from "./App";
import "./index.css";
import { registerServiceWorker } from "./services/service-worker";
import { auth } from "./config/firebase-config";

// Auth-stamp every fetch that targets `/api/studio/local-asset`. The
// endpoint requires a Firebase ID token (via Authorization: Bearer …
// header, OR ?t=<idToken> query fallback), but multiple consumers
// downstream — playback-controller's HTMLAudioElement fallback,
// export-engine's audio prefetch, voidspace-loader's blob fetcher —
// hit the URL with a plain `fetch()`. Without auth, they all 401, the
// blob comes back null, and the audio engine silently drops the track.
// Symptom users see: music_url is in Firestore, "Background Music"
// shows on the timeline with a 5-minute clip, but no sound plays in
// preview AND the exported MP4 has video-only audio (narration only).
//
// Patch is keyed on the URL path, not the consumer, so any future
// fetch added in any package is auto-authed too. Cross-origin URLs
// (Suno temp links, Kie outputs, Firebase Storage gs://…) keep their
// existing query strings untouched.
if (typeof window !== "undefined") {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (rawUrl && /\/api\/studio\/local-asset(\?|$)/.test(rawUrl) && !/[?&]t=/.test(rawUrl)) {
      try {
        const u = auth.currentUser;
        const token = u ? await u.getIdToken(false) : "";
        if (token) {
          const sep = rawUrl.includes("?") ? "&" : "?";
          const stamped = `${rawUrl}${sep}t=${encodeURIComponent(token)}`;
          if (typeof input === "string" || input instanceof URL) {
            return origFetch(stamped, init);
          }
          // Request object — preserve its method/headers/body but
          // swap the URL. Request.clone() doesn't change the URL, so
          // we rebuild via the constructor with `input` as init source.
          return origFetch(new Request(stamped, input as Request), init);
        }
      } catch {
        // Fall through to unauthenticated fetch — surface 401 to caller.
      }
    }
    return origFetch(input, init);
  };
}

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
