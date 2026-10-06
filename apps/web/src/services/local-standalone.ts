/** The local development editor can work without the Nuxt/cloud host. */
export function isLocalStandalone(): boolean {
  return import.meta.env.DEV && window.parent === window
    && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}
