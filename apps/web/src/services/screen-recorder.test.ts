import { describe, it, expect, vi, afterEach } from "vitest";
import {
  acquireHealthyWebcam,
  clearWebcamModeCache,
  MIN_USABLE_FPS,
  webcamDimsForAspect,
} from "./screen-recorder";
import type { RecordingOptions } from "./screen-recorder";

/**
 * Regression guard for the "recording is a static image" bug.
 *
 * A camera reports frameRate:30 in getSettings() while delivering 0.7. Measured
 * on a real Dell WB7022:
 *     1280x720  landscape → 30.0 fps
 *     1080x1920 PORTRAIT  → 29.7 fps
 *     720x1280  PORTRAIT  →  0.7 fps   ← same aspect, same camera
 * So geometry cannot be whitelisted; the acquisition path has to MEASURE and
 * fall back. These tests pin that behaviour.
 */

const OPTIONS: RecordingOptions = {
  mode: "camera",
  video: { resolution: "1080p", frameRate: 30 },
  audio: { systemAudio: false, microphone: true },
  webcam: { enabled: true, resolution: "720p" },
  targetAspect: 9 / 16, // portrait project → asks for 720x1280, the bad mode
};

/** Fake a camera whose per-geometry frame rate we control. */
function mockCamera(fpsFor: (w: number, h: number) => number) {
  // Each case must probe from scratch — the learned-mode cache is per session,
  // not per test.
  clearWebcamModeCache();
  const stopped: MediaStream[] = [];
  (globalThis as any).navigator = {
    ...(globalThis as any).navigator,
    mediaDevices: {
      getUserMedia: vi.fn(async (c: any) => {
        const w = c?.video?.width?.ideal ?? 1280;
        const h = c?.video?.height?.ideal ?? 720;
        const settings = { width: w, height: h, frameRate: 30 };
        const track = { getSettings: () => settings, stop: vi.fn() };
        const stream: any = {
          getVideoTracks: () => [track],
          getTracks: () => [track],
        };
        stream.__fps = fpsFor(w, h);
        stopped.push(stream);
        return stream;
      }),
    },
  };
  // measureTrackFps drives a <video>; stub the DOM it needs.
  (globalThis as any).document = {
    createElement: () => {
      const el: any = {
        play: async () => {},
        set srcObject(s: any) { el.__s = s; },
        get srcObject() { return el.__s; },
        requestVideoFrameCallback: (cb: any) => {
          // Fire ONE callback per frame interval. measureTrackFps re-registers
          // from inside the callback, so scheduling a batch here would recurse
          // exponentially — the counter must advance in real time, like the
          // real API does.
          const fps = el.__s?.__fps ?? 0;
          if (fps > 0) setTimeout(cb, 1000 / fps);
        },
      };
      return el;
    },
  };
  (globalThis as any).performance = globalThis.performance ?? { now: () => Date.now() };
  return stopped;
}

const realNav = (globalThis as any).navigator;
const realDoc = (globalThis as any).document;
afterEach(() => {
  (globalThis as any).navigator = realNav;
  (globalThis as any).document = realDoc;
  vi.restoreAllMocks();
});

describe("acquireHealthyWebcam", () => {
  it("keeps the project-aspect mode when it actually delivers frames", async () => {
    mockCamera(() => 30);
    const got = await acquireHealthyWebcam(OPTIONS);
    expect(got).not.toBeNull();
    expect(got!.fps).toBeGreaterThanOrEqual(MIN_USABLE_FPS);
    // 720p tier @ 9:16 → 720x1280, the first candidate.
    const s = got!.stream.getVideoTracks()[0].getSettings();
    expect(`${s.width}x${s.height}`).toBe("720x1280");
  });

  it("abandons a mode that reports 30fps but delivers ~0 (the real bug)", async () => {
    // Exactly the observed hardware behaviour: 720x1280 collapses, 1080x1920 fine.
    mockCamera((w, h) => (w === 720 && h === 1280 ? 0.7 : 30));
    const got = await acquireHealthyWebcam(OPTIONS);
    expect(got).not.toBeNull();
    const s = got!.stream.getVideoTracks()[0].getSettings();
    expect(`${s.width}x${s.height}`).not.toBe("720x1280");
    expect(got!.fps).toBeGreaterThanOrEqual(MIN_USABLE_FPS);
  });

  it("tries EVERY tier at the project aspect before abandoning it", async () => {
    // Only the 480p portrait mode works. We must find it rather than bailing to
    // landscape — matching the project's aspect is the default policy.
    mockCamera((w, h) => (w === 480 && h === 854 ? 30 : h > w ? 0.5 : 30));
    const got = await acquireHealthyWebcam(OPTIONS);
    expect(got).not.toBeNull();
    const s = got!.stream.getVideoTracks()[0].getSettings();
    expect(s.height!).toBeGreaterThan(s.width!); // still portrait
    expect(got!.matchedAspect).toBe(true);
  });

  it("falls back to the camera's default only when NO aspect-matching mode works", async () => {
    mockCamera((w, h) => (h > w ? 0.5 : 30));
    const got = await acquireHealthyWebcam(OPTIONS);
    expect(got).not.toBeNull();
    const s = got!.stream.getVideoTracks()[0].getSettings();
    expect(s.width!).toBeGreaterThan(s.height!); // landscape won
    expect(got!.matchedAspect).toBe(false); // and we KNOW we didn't match
    expect(got!.fps).toBeGreaterThanOrEqual(MIN_USABLE_FPS);
  });

  it("records LANDSCAPE for a landscape project", async () => {
    mockCamera(() => 30);
    const got = await acquireHealthyWebcam({ ...OPTIONS, targetAspect: 16 / 9 });
    expect(got).not.toBeNull();
    const s = got!.stream.getVideoTracks()[0].getSettings();
    expect(`${s.width}x${s.height}`).toBe("1280x720");
    expect(got!.matchedAspect).toBe(true);
  });

  it("records SQUARE for a 1:1 project", async () => {
    mockCamera(() => 30);
    const got = await acquireHealthyWebcam({ ...OPTIONS, targetAspect: 1 });
    expect(got).not.toBeNull();
    const s = got!.stream.getVideoTracks()[0].getSettings();
    expect(s.width).toBe(s.height);
    expect(got!.matchedAspect).toBe(true);
  });

  it("does not claim an aspect match when the camera hands back a different shape", async () => {
    // Ask for portrait, camera quietly returns landscape at a good frame rate.
    mockCamera(() => 30);
    const nav = (globalThis as any).navigator;
    const orig = nav.mediaDevices.getUserMedia;
    nav.mediaDevices.getUserMedia = async (c: any) => {
      const s: any = await orig(c);
      const track = { getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }), stop: vi.fn() };
      return { ...s, getVideoTracks: () => [track], getTracks: () => [track], __fps: 30 };
    };
    const got = await acquireHealthyWebcam(OPTIONS);
    expect(got).not.toBeNull();
    expect(got!.matchedAspect).toBe(false);
  });

  it("still returns the BEST available stream when nothing clears the bar", async () => {
    // Never fail the take outright — hand back the least-bad mode and let the
    // caller warn. A 8fps take beats no take.
    mockCamera((w, h) => (h > w ? 2 : 8));
    const got = await acquireHealthyWebcam(OPTIONS);
    expect(got).not.toBeNull();
    // It must hand back the BEST candidate (the 8fps landscape one), not the
    // last one tried. Exact fps isn't asserted — a short sample window quantises
    // it — only that it beat the 2fps portrait modes.
    expect(got!.fps).toBeGreaterThan(4);
    const s = got!.stream.getVideoTracks()[0].getSettings();
    expect(s.width!).toBeGreaterThan(s.height!);
  });
});

describe("probe hygiene + explicit shape", () => {
  it("stops EVERY rejected probe stream (a held dead mode stutters the camera)", async () => {
    // The leak that made the preview lag: 720x1280 measured 0fps, was kept as
    // "best", and was still holding the camera when 1080x1920 won.
    const opened = mockCamera((w, h) => (w === 720 && h === 1280 ? 0.7 : 30));
    const got = await acquireHealthyWebcam(OPTIONS);
    expect(got).not.toBeNull();
    for (const s of opened) {
      const track = (s as any).getVideoTracks()[0];
      const isWinner = s === (got!.stream as any);
      expect(track.stop.mock.calls.length > 0, `${isWinner ? "winner" : "loser"} stopped?`).toBe(!isWinner);
    }
  });

  it("reuses the learned mode instead of re-probing on every preview", async () => {
    const opened = mockCamera((w, h) => (w === 720 && h === 1280 ? 0.7 : 30));
    const nav = (globalThis as any).navigator;
    await acquireHealthyWebcam(OPTIONS);
    const afterFirst = nav.mediaDevices.getUserMedia.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(1); // probed the ladder
    await acquireHealthyWebcam(OPTIONS);
    // Second acquisition must be a single direct open, not another ladder walk.
    expect(nav.mediaDevices.getUserMedia.mock.calls.length - afterFirst).toBe(1);
    expect(opened.length).toBeGreaterThan(0);
  });

  it("honours an EXPLICIT shape over the project's aspect", async () => {
    mockCamera(() => 30);
    // Portrait project, but the user picked 16:9 for this take.
    const got = await acquireHealthyWebcam({
      ...OPTIONS,
      webcam: { ...OPTIONS.webcam, aspect: "16:9" },
    });
    expect(got).not.toBeNull();
    const s = got!.stream.getVideoTracks()[0].getSettings();
    expect(`${s.width}x${s.height}`).toBe("1280x720");
  });

  it("'project' shape follows the project aspect", async () => {
    mockCamera(() => 30);
    const got = await acquireHealthyWebcam({
      ...OPTIONS,
      webcam: { ...OPTIONS.webcam, aspect: "project" },
    });
    const s = got!.stream.getVideoTracks()[0].getSettings();
    expect(`${s.width}x${s.height}`).toBe("720x1280"); // 9:16, as the project is
  });
});

describe("webcamDimsForAspect", () => {
  it("anchors the short side to the tier and derives the long side", () => {
    expect(webcamDimsForAspect("1080p", 16 / 9)).toMatchObject({ width: 1920, height: 1080 });
    expect(webcamDimsForAspect("1080p", 9 / 16)).toMatchObject({ width: 1080, height: 1920 });
    expect(webcamDimsForAspect("720p", 1)).toMatchObject({ width: 720, height: 720 });
  });

  it("always yields EVEN dimensions (odd breaks chroma subsampling)", () => {
    for (const tier of ["480p", "720p", "1080p"] as const) {
      for (const ar of [16 / 9, 9 / 16, 1, 4 / 5, 4 / 3, 2.39]) {
        const d = webcamDimsForAspect(tier, ar);
        expect(d.width % 2, `${tier}@${ar}`).toBe(0);
        expect(d.height % 2, `${tier}@${ar}`).toBe(0);
      }
    }
  });
});
