import { describe, it, expect } from "vitest";
import { AUTHED_MEDIA_PATHS, isAuthedMediaUrl, hasTokenParam } from "./authed-media";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE AGENT COULD NOT PUT ANYTHING FROM THE LIBRARY ON THE TIMELINE.
 *
 * ── THE BUG, FOUND BY WATCHING A REAL TURN ──────────────────────────────────
 * `search_media` / `use_media_library_asset` return urls like
 * `/api/media-library/file?id=…` for the user's own media. That endpoint calls
 * `requireUserId` and answers 401 without a token. The editor's `fetchMediaBlob`
 * stamped a token onto exactly ONE path — `/api/studio/local-asset` — so every
 * library url was fetched bare and failed with "could not fetch media" in ~12ms.
 *
 * It presented as an agent that could not make up its mind: it searched, found
 * media, tried to place it, failed, concluded it had chosen badly, and searched
 * again until the request deadline ended the turn. The looping was the symptom.
 * A missing query parameter was the disease, and "put two videos from my library
 * on the timeline" was impossible.
 *
 * ── WHY SOURCE ASSERTIONS ───────────────────────────────────────────────────
 * `fetchMediaBlob` needs Firebase auth, a live `window.location` and a network.
 * What must not regress is the LIST and the same-origin guard, and both are
 * readable from the source.
 */
const SRC = readFileSync(join(__dirname, "voidspace-loader.ts"), "utf8");
const MAIN = readFileSync(join(__dirname, "..", "main.tsx"), "utf8");
const ORIGIN = "https://voidspace.ai";

describe("authenticated media fetches are stamped", () => {
  it("covers the media-library file endpoint, not just studio local-asset", () => {
    expect(AUTHED_MEDIA_PATHS).toContain("/api/media-library/file");
    expect(AUTHED_MEDIA_PATHS).toContain("/api/studio/local-asset");
  });

  it("covers thumbnails and the proxy, which share the same auth", () => {
    // A thumbnail that 401s makes a full library look empty.
    expect(AUTHED_MEDIA_PATHS).toContain("/api/media-library/thumb");
    expect(AUTHED_MEDIA_PATHS).toContain("/api/media-library/proxy");
  });

  it("matches relative and same-origin urls on those paths", () => {
    expect(isAuthedMediaUrl("/api/media-library/file?id=abc", ORIGIN)).toBe(true);
    expect(isAuthedMediaUrl(`${ORIGIN}/api/media-library/file?id=abc`, ORIGIN)).toBe(true);
    expect(isAuthedMediaUrl("/api/studio/local-asset?projectId=p&kind=video&filename=a.mp4", ORIGIN)).toBe(true);
    expect(isAuthedMediaUrl("/api/media-library/search?q=x", ORIGIN)).toBe(false);
  });

  /**
   * The token is a bearer credential. Matching on PATH alone would hand it to
   * any third-party host that happened to use the same path — and generated
   * media legitimately comes from CDNs we do not control.
   */
  it("refuses to stamp a cross-origin url", () => {
    expect(isAuthedMediaUrl("https://evil.example/api/media-library/file?id=abc", ORIGIN)).toBe(false);
    expect(isAuthedMediaUrl("https://storage.googleapis.com/api/studio/local-asset", ORIGIN)).toBe(false);
  });

  it("never stamps twice", () => {
    expect(hasTokenParam("/api/media-library/file?id=a&t=tok")).toBe(true);
    expect(hasTokenParam("/api/media-library/file?id=a")).toBe(false);
  });

  /**
   * THE BUG THIS FILE NOW GUARDS (9 Oct 2026): the loader used the list, but the
   * app-wide fetch hook in main.tsx kept its own local-asset-only regex, so a
   * Library item DRAGGED onto the timeline fetched bare, 401'd, and the drop did
   * nothing. Both must read the one list.
   */
  it("the app-wide fetch hook uses the shared list, not its own regex", () => {
    expect(MAIN).toMatch(/isAuthedMediaUrl\(rawUrl\)/);
    // The old private regex (`/\/api\/studio\/local-asset(\?|$)/.test(rawUrl)`) must be gone.
    expect(MAIN.includes("local-asset(\\?|$)/.test")).toBe(false);
  });

  it("the loader stamps through the shared helper the way requireUserId reads it", () => {
    const fn = /async function maybeAuthStamp\([\s\S]*?\n\}/.exec(SRC);
    expect(fn, "maybeAuthStamp must exist").toBeTruthy();
    expect(fn![0]).toMatch(/isAuthedMediaUrl\(url\)/);
    expect(fn![0]).toMatch(/t=\$\{encodeURIComponent\(token\)\}/);
  });

  it("does not stamp when nobody is signed in", () => {
    const fn = /async function maybeAuthStamp\([\s\S]*?\n\}/.exec(SRC)![0];
    expect(fn).toMatch(/if \(!u\) return url;/);
  });
});
