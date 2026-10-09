/**
 * Voidspace API paths that serve media and REQUIRE a signed-in user — the ONE
 * list every fetch in the editor checks before it sends the user's token.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
 * The list used to live inside `voidspace-loader.ts` and was only consulted by
 * the loader's own `fetchMediaBlob`. The app-wide fetch hook in `main.tsx` — the
 * one EVERY other consumer goes through — kept a separate regex that knew only
 * `/api/studio/local-asset`.
 *
 * So the agent could place a library file (it fetched through the loader) but
 * the person could not: dragging anything from the Library panel onto the
 * timeline fetched `/api/media-library/file?id=…` bare, the server answered 401,
 * and the drop handler swallowed the failure. Nothing appeared and nothing said
 * why (founder, 9 Oct 2026: "I'm unable to drag and drop media onto the
 * timeline"). Two copies of one rule had drifted; there is now one.
 *
 * `requireUserId` accepts the token as `?t=`, which is how both callers send it.
 */
export const AUTHED_MEDIA_PATHS: readonly string[] = [
  "/api/studio/local-asset",
  "/api/media-library/file",
  "/api/media-library/thumb",
  "/api/media-library/proxy",
];

/**
 * Should this url carry the user's token?
 *
 * SAME-ORIGIN ONLY. The token is a bearer credential: appending it because the
 * PATH happened to match would hand it to any third-party host that chose the
 * same path, and generated media legitimately comes from CDNs we do not control.
 * Relative urls are ours by definition; an absolute one has to prove it.
 */
export function isAuthedMediaUrl(url: string, origin: string = window.location.origin): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  const path = parsed.pathname;
  return AUTHED_MEDIA_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Already carries a token (`?t=` / `&t=`) — never stamp twice. */
export function hasTokenParam(url: string): boolean {
  return /[?&]t=/.test(url);
}
