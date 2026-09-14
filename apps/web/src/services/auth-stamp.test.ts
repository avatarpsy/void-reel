import { describe, it, expect } from "vitest";
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
const SRC = readFileSync(
  join(__dirname, "voidspace-loader.ts"),
  "utf8",
);

describe("authenticated media fetches are stamped", () => {
  it("covers the media-library file endpoint, not just studio local-asset", () => {
    expect(SRC).toMatch(/"\/api\/media-library\/file"/);
    expect(SRC).toMatch(/"\/api\/studio\/local-asset"/);
  });

  it("covers thumbnails and the proxy, which share the same auth", () => {
    // A thumbnail that 401s makes a full library look empty.
    expect(SRC).toMatch(/"\/api\/media-library\/thumb"/);
    expect(SRC).toMatch(/"\/api\/media-library\/proxy"/);
  });

  /**
   * The token is a bearer credential. Matching on PATH alone would hand it to
   * any third-party host that happened to use the same path — and generated
   * media legitimately comes from CDNs we do not control.
   */
  it("refuses to stamp a cross-origin url", () => {
    const fn = /async function maybeAuthStamp\([\s\S]*?\n\}/.exec(SRC);
    expect(fn, "maybeAuthStamp must exist").toBeTruthy();
    expect(fn![0]).toMatch(/parsed\.origin !== window\.location\.origin/);
    expect(fn![0]).toMatch(/return url;/);
  });

  it("still sends the token the way requireUserId reads it", () => {
    const fn = /async function maybeAuthStamp\([\s\S]*?\n\}/.exec(SRC)![0];
    expect(fn).toMatch(/t=\$\{encodeURIComponent\(token\)\}/);
  });

  it("does not stamp when nobody is signed in", () => {
    const fn = /async function maybeAuthStamp\([\s\S]*?\n\}/.exec(SRC)![0];
    expect(fn).toMatch(/if \(!u\) return url;/);
  });
});
