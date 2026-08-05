/**
 * Which theme should this editor boot in?
 *
 * WHY THIS EXISTS
 * The editor is reachable two ways, and only one of them used to answer the
 * question. Embedded in the Voidspace site, the host relays its light/dark
 * choice (`?theme=` on the iframe src, then `voidspace:theme` on every change).
 * But the LANDING pages — "Create a video project" / "Create a music project"
 * open `/studio/?forceWelcome=1` as a top-level navigation — have no host to
 * ask, so they fell back to the store's dark default and rendered dark on a
 * light site. The one part of the product that ignored the user's theme.
 *
 * It never needed a message: `/studio/` is served from the site's own origin,
 * so the site's stored preference is right there in localStorage. Read it.
 *
 * Order of authority:
 *   1. `?theme=` — an embedding host said so explicitly; it wins.
 *   2. The site's own saved preference (`voidspace-theme-mode`).
 *   3. The OS preference, which is what the site itself falls back to.
 *   4. Dark — the editor's palette is authored dark-first.
 */

/** The key `composables/useThemeMode.ts` writes on the Voidspace site. */
const SITE_THEME_KEY = "voidspace-theme-mode";

export type SiteTheme = "light" | "dark";

/** The site's saved choice, or null when the user has never set one. */
export function readSiteTheme(): SiteTheme | null {
  try {
    const v = window.localStorage.getItem(SITE_THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // private mode / storage disabled
  }
}

function systemTheme(): SiteTheme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "dark";
  }
}

/** The theme to boot in. `urlTheme` is the `?theme=` param, if any. */
export function resolveBootTheme(urlTheme?: string | null): SiteTheme {
  if (urlTheme === "light" || urlTheme === "dark") return urlTheme;
  return readSiteTheme() ?? systemTheme();
}

/**
 * Follow the site while this tab is open.
 *
 * `storage` fires in OTHER documents of the origin — which is exactly the
 * standalone landing's case: the user flips the toggle on the site in another
 * tab. (Embedded, the host's `voidspace:theme` message already covers it.)
 * Returns an unsubscribe.
 */
export function watchSiteTheme(onChange: (t: SiteTheme) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key !== SITE_THEME_KEY) return;
    const v = e.newValue;
    onChange(v === "light" || v === "dark" ? v : systemTheme());
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}
