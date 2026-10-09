/**
 * Board → video updates. The founder's rule these pin: a board change reaches
 * the cut IN PLACE — the clip keeps its start, its trim and everything the
 * editor did to it — and never by re-laying the timeline from the board.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./auto-save", () => ({
  autoSaveManager: {
    startAutoSave: vi.fn(), stopAutoSave: vi.fn(), triggerSave: vi.fn(),
    getRecentSaves: vi.fn().mockResolvedValue([]), loadSave: vi.fn(), deleteSave: vi.fn(),
  },
  initializeAutoSave: vi.fn().mockResolvedValue(undefined),
}));

import type { Clip, MediaItem, Project, Track } from "@openreel/core";
import { useProjectStore } from "../stores/project-store";
import {
  _resetBoardProjectReady, applyBoardUpdates, applyBoardUpdatesFor, findShotClip, isBoardLinkedClip, linkClipToShot,
  isFetchableMediaUrl, markBoardProjectReady, planAppendStart, planReorder, planRetime, shotFamily,
} from "./board-updates";

const clip = (id: string, startTime: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  id, mediaId: `m-${id}`, trackId: "track-video", startTime, duration, inPoint: 0, outPoint: duration,
  effects: [], audioEffects: [], keyframes: [], volume: 1,
  transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, anchor: { x: 0.5, y: 0.5 }, opacity: 1 },
  ...extra,
} as Clip);

const track = (id: string, clips: Clip[], type: Track["type"] = "video"): Track =>
  ({ id, type, name: id, clips, transitions: [], locked: false, hidden: false, muted: false, solo: false } as unknown as Track);

const projectOf = (tracks: Track[]): Project => ({ timeline: { tracks } } as unknown as Project);

describe("which clip IS the shot", () => {
  const p = projectOf([
    track("track-video", [
      clip("clip-video-s1", 0, 4, { shotId: "s1" }),
      clip("own-cut", 10, 3, { shotId: "s2" }),
    ]),
    track("track-take-2", [clip("clip-take-s1-t2", 0, 4, { shotId: "s1" })]),
  ]);

  it("prefers the compile's clip-video-<shotId>", () => {
    expect(findShotClip(p, "s1")?.clip.id).toBe("clip-video-s1");
  });
  it("falls back to any picture clip naming the shot, never an alternate", () => {
    expect(findShotClip(p, "s2")?.clip.id).toBe("own-cut");
    expect(findShotClip(p, "s9")).toBeNull();
  });
  it("a shot's family includes its alternates", () => {
    expect(shotFamily(p, "s1").map((l) => l.clip.id).sort()).toEqual(["clip-take-s1-t2", "clip-video-s1"]);
  });
  it("board-linked means it names a shot", () => {
    expect(isBoardLinkedClip({ shotId: "s1" })).toBe(true);
    expect(isBoardLinkedClip({})).toBe(false);
  });
});

describe("planRetime keeps start and in-point; never pushes the next clip", () => {
  const c = clip("a", 2, 4, { inPoint: 1, outPoint: 5 });
  it("lengthens within the media", () => {
    expect(planRetime(c, 10, 6, Infinity)).toMatchObject({ inPoint: 1, outPoint: 7, duration: 6, clampedBy: "" });
  });
  it("slides the window back before it shortens against the media end", () => {
    expect(planRetime(c, 6, 6, Infinity)).toMatchObject({ inPoint: 0, outPoint: 6, duration: 6 });
    expect(planRetime(c, 5, 6, Infinity)).toMatchObject({ inPoint: 0, outPoint: 5, clampedBy: "media" });
  });
  it("stops at the next clip instead of overlapping it", () => {
    expect(planRetime(c, 10, 6, 5)).toMatchObject({ duration: 3, clampedBy: "next clip" });
  });
  it("a still has no media length to respect", () => {
    expect(planRetime(clip("s", 0, 5), 0, 3.2, Infinity).duration).toBeCloseTo(3.2);
  });
});

describe("planAppendStart", () => {
  const t = track("track-video", [clip("a", 0, 4), clip("b", 6, 4)]);
  it("goes right after the shot before it when that gap fits", () => {
    expect(planAppendStart(t, t.clips[0], 2)).toBe(4);
  });
  it("otherwise appends at the end — never on top of anything", () => {
    expect(planAppendStart(t, t.clips[0], 3)).toBe(10);
    expect(planAppendStart(t, null, 1)).toBe(10);
  });
});

describe("planReorder re-sequences inside the slots the shots already hold", () => {
  const p = projectOf([track("track-video", [
    clip("clip-video-s1", 0, 4, { shotId: "s1" }),
    clip("clip-video-s2", 5, 2, { shotId: "s2" }), // 1s gap before it
    clip("clip-video-s3", 7, 3, { shotId: "s3" }),
  ])]);
  it("is a no-op when the order already matches", () => {
    expect(planReorder(p, ["s1", "s2", "s3"]).status).toBe("unchanged");
  });
  it("keeps the first start, each clip's own length and the gaps by position", () => {
    const plan = planReorder(p, ["s2", "s1", "s3"]);
    expect(plan.status).toBe("move");
    if (plan.status !== "move") return;
    expect(plan.moves.map((m) => [m.shotId, m.to])).toEqual([["s2", 0], ["s1", 3], ["s3", 7]]);
  });
  it("refuses rather than land on a clip that is not part of the move", () => {
    const q = projectOf([track("track-video", [
      clip("clip-video-s1", 0, 4, { shotId: "s1" }),
      clip("loose", 4, 1),
      clip("clip-video-s2", 5, 6, { shotId: "s2" }),
    ])]);
    expect(planReorder(q, ["s2", "s1"]).status).toBe("failed");
  });
});

describe("only fetchable media", () => {
  it("accepts http(s) and same-origin paths, refuses the rest", () => {
    expect(isFetchableMediaUrl("https://cdn.example.com/a.mp4")).toBe(true);
    expect(isFetchableMediaUrl("/api/media-library/file/x.mp4")).toBe(true);
    expect(isFetchableMediaUrl("javascript:alert(1)")).toBe(false);
    expect(isFetchableMediaUrl("data:video/mp4;base64,AAAA")).toBe(false);
  });
});

/**
 * THROUGH THE REAL STORE. A board-chosen take replaces the clip's media with
 * one undoable action and the clip stays exactly where the editor put it —
 * the opposite of the 8 Oct rebuild, which put it back at index × 6.04 s.
 */
describe("applied in place through the editor's actions", () => {
  const media = (id: string, url: string, duration: number): MediaItem => ({
    id, name: id, type: "video", fileHandle: null, blob: null,
    metadata: { duration, width: 0, height: 0, frameRate: 30, codec: "", sampleRate: 0, channels: 0, fileSize: 0 },
    thumbnailUrl: null, waveformData: null, originalUrl: url,
  } as unknown as MediaItem);

  beforeEach(() => {
    _resetBoardProjectReady();
    useProjectStore.getState().createNewProject("board-linked");
    const s = useProjectStore.getState();
    const cut: Track = track("track-video", [
      // Hand-cut: moved to 1.5s and trimmed to 2s of a 6.04s take.
      clip("clip-video-s1", 1.5, 2, { shotId: "s1", mediaId: "media-old", inPoint: 1, outPoint: 3 }),
      clip("clip-video-s2", 4, 3, { shotId: "s2", mediaId: "media-old2", inPoint: 0, outPoint: 3 }),
    ]);
    useProjectStore.setState({
      project: {
        ...s.project,
        mediaLibrary: { items: [media("media-old", "https://x/old.mp4", 6.04), media("media-old2", "https://x/old2.mp4", 6.04)] },
        timeline: { ...s.project.timeline, tracks: [cut] },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["x"], { type: "video/mp4" }))));
  });

  const at = (id: string) => useProjectStore.getState().project.timeline.tracks
    .flatMap((t) => t.clips).find((c) => c.id === id);

  it("a new take keeps start, length and trim", async () => {
    const [r] = await applyBoardUpdates([{ kind: "take", shotId: "s1", url: "https://x/new.mp4", durationSec: 6.04 }]);
    expect(r.status).toBe("applied");
    const c = at("clip-video-s1")!;
    expect(c.startTime).toBe(1.5);
    expect(c.inPoint).toBe(1);
    expect(c.outPoint).toBe(3);
    expect(c.mediaId).not.toBe("media-old");
    // Idempotent: the same take again changes nothing.
    const [again] = await applyBoardUpdates([{ kind: "take", shotId: "s1", url: "https://x/new.mp4" }]);
    expect(again.status).toBe("unchanged");
  });

  it("a retime changes only the length, and stops at the next clip", async () => {
    const [r] = await applyBoardUpdates([{ kind: "retime", shotId: "s1", durationSec: 5 }]);
    expect(r.status).toBe("applied");
    const c = at("clip-video-s1")!;
    expect(c.startTime).toBe(1.5);
    expect(c.inPoint).toBe(1);
    expect(c.duration).toBeCloseTo(2.5); // room until s2 at 4s
    expect(at("clip-video-s2")!.startTime).toBe(4);
  });

  it("a removed shot leaves its gap; a new shot lands after the one before it or at the end", async () => {
    const res = await applyBoardUpdates([
      { kind: "remove", shotId: "s1" },
      { kind: "take", shotId: "s3", url: "https://x/s3.mp4", durationSec: 2, afterShotId: "s2", newShot: true },
    ]);
    expect(res.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(at("clip-video-s1")).toBeUndefined();
    expect(at("clip-video-s2")!.startTime).toBe(4);
    expect(at("clip-video-s3")!.startTime).toBe(7);
  });

  it("an existing shot with no linked clip is reported, never appended as a stray copy", async () => {
    const before = useProjectStore.getState().project.timeline.tracks.flatMap((x) => x.clips).length;
    const [r] = await applyBoardUpdates([{ kind: "take", shotId: "s9", url: "https://x/s9.mp4", durationSec: 2 }]);
    expect(r.status).toBe("skipped");
    expect(r.detail).toMatch(/linkShotId/);
    expect(useProjectStore.getState().project.timeline.tracks.flatMap((x) => x.clips).length).toBe(before);
  });

  it("a hand-placed clip playing one of the shot's takes is linked and updated in place", async () => {
    // A clip swapped in by hand: no shotId, plays the shot's OLD take.
    const s = useProjectStore.getState();
    useProjectStore.setState({ project: { ...s.project,
      mediaLibrary: { items: [...s.project.mediaLibrary.items, media("media-hand", "https://x/s7-take1.mp4", 6)] },
      timeline: { ...s.project.timeline, tracks: s.project.timeline.tracks.map((tr) => ({ ...tr,
        clips: [...tr.clips, clip("hand-7", 8, 2, { mediaId: "media-hand", inPoint: 0.5, outPoint: 2.5 })] })) } } });
    const [r] = await applyBoardUpdates([{ kind: "take", shotId: "s7", url: "https://x/s7-take2.mp4", durationSec: 6,
      takeUrls: ["https://x/s7-take1.mp4", "https://x/s7-take2.mp4"] }]);
    expect(r.status, r.detail).toBe("applied");
    const c = at("hand-7")!;
    expect(c.shotId).toBe("s7");
    expect(c.startTime).toBe(8);
    expect(c.inPoint).toBe(0.5);
    expect(c.mediaId).not.toBe("media-hand");
  });

  it("linkClipToShot makes one clip the shot and unlinks any other", () => {
    expect(linkClipToShot("clip-video-s2", "s1")).toBe(true);
    expect(at("clip-video-s2")!.shotId).toBe("s1");
    expect(at("clip-video-s1")!.shotId).toBeUndefined();
  });

  it("waits for the project to load, and refuses another project", async () => {
    const pending = applyBoardUpdatesFor("p1", [{ kind: "retime", shotId: "s2", durationSec: 2 }]);
    markBoardProjectReady("p1");
    expect((await pending)[0].status).toBe("applied");
    await expect(applyBoardUpdatesFor("p2", [])).rejects.toThrow(/holds project p1/);
  });
});
