import { describe, it, expect } from "vitest";
import { isSupportedFormat, inferMediaType, resolveMimeType } from "./mediabunny-engine";

/**
 * REAL SERVERS DO NOT RELIABLY LABEL MEDIA.
 *
 * This was found by an end-to-end run, not by reading code: importing a plain
 * H.264 .mp4 over HTTP failed with "Unsupported format: application/mp4",
 * because the format check compared the response's Content-Type against a
 * fixed list of six video types.
 *
 * The dev server that exposed it is the least of it. `application/octet-stream`
 * is what S3, GCS and most CDNs send when an object's content-type was never
 * set — the common case for generated media and for anything uploaded by an API
 * rather than a browser. The agent's `add_library_media` imports from exactly
 * those URLs and does not control their headers, so this was a failure it could
 * neither diagnose nor route around: a good file, refused, with a message about
 * a MIME type the user never chose.
 *
 * The rule: a specific header is believed; an ambiguous one is a MISSING answer
 * and the filename is asked next.
 */
describe("import format detection", () => {
  it("accepts the ordinary specific types", () => {
    expect(isSupportedFormat("video/mp4")).toBe(true);
    expect(isSupportedFormat("audio/mpeg")).toBe(true);
    expect(isSupportedFormat("image/png")).toBe(true);
  });

  it("accepts application/mp4 — a REGISTERED mp4 type (RFC 4337)", () => {
    expect(isSupportedFormat("application/mp4", "clip.mp4")).toBe(true);
    expect(inferMediaType("application/mp4", "clip.mp4")).toBe("video");
  });

  it("accepts octet-stream when the filename says what it is", () => {
    // What S3/GCS/most CDNs send for an object with no content-type set.
    expect(isSupportedFormat("application/octet-stream", "render.mp4")).toBe(true);
    expect(inferMediaType("application/octet-stream", "song.mp3")).toBe("audio");
    expect(inferMediaType("application/octet-stream", "cover.png")).toBe("image");
    expect(isSupportedFormat("binary/octet-stream", "a.webm")).toBe(true);
  });

  it("accepts an empty content-type with a usable filename", () => {
    expect(isSupportedFormat("", "take-2.mov")).toBe(true);
    expect(inferMediaType("", "take-2.mov")).toBe("video");
  });

  it("reads the extension through a URL query string", () => {
    // Signed CDN URLs always carry one.
    expect(isSupportedFormat("application/octet-stream",
      "https://cdn.example.com/a/b/final.mp4?X-Amz-Expires=900&sig=abc")).toBe(true);
  });

  it("handles m4a and m4v, which the old list missed entirely", () => {
    expect(inferMediaType("application/octet-stream", "voice.m4a")).toBe("audio");
    expect(inferMediaType("application/octet-stream", "reel.m4v")).toBe("video");
  });

  /**
   * The guard on the guard: guessing must only happen where there is nothing to
   * override. A server that says "image/tiff" has given a real answer, and a
   * filename must not be allowed to argue with it.
   */
  it("does NOT override a specific header it simply does not support", () => {
    expect(isSupportedFormat("image/tiff", "scan.mp4")).toBe(false);
    expect(inferMediaType("video/x-flv", "old.mp4")).toBeNull();
  });

  it("still refuses bytes it cannot identify at all", () => {
    expect(isSupportedFormat("application/octet-stream", "notes.txt")).toBe(false);
    expect(isSupportedFormat("application/octet-stream")).toBe(false);
    expect(isSupportedFormat("", "")).toBe(false);
  });

  it("ignores charset parameters and case", () => {
    expect(isSupportedFormat("VIDEO/MP4; charset=binary")).toBe(true);
    expect(resolveMimeType("Video/WebM")).toBe("video/webm");
  });
});
