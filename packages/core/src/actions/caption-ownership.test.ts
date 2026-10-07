import { describe, it, expect } from "vitest";
import { ActionExecutor, type TitleEngineAdapter } from "./action-executor";
import { ActionHistory } from "./action-history";
import type { Action } from "../types/actions";
import type { Project } from "../types/project";
import type { Clip } from "../types/timeline";
import type { TextClip } from "../text/types";
import {
  captionOwnerId,
  captionsOwnedBy,
  planOwnedCaptions,
} from "../text/caption-ownership";

/**
 * Caption ownership (7 Oct, project bb319c0e): a clip edit may only touch the
 * captions LINKED to that clip. Typed lyrics/titles are timeline-anchored.
 */

let seq = 0;
const act = (type: string, params: Record<string, unknown>): Action => ({
  type,
  id: `a-${seq++}`,
  timestamp: 0,
  params,
});

const cap = (id: string, startTime: number, duration: number, linkedClipId?: string) =>
  ({ id, startTime, duration, text: id, ...(linkedClipId ? { linkedClipId } : {}) });

describe("captionOwnerId", () => {
  const exists = (ids: string[]) => (id: string) => ids.includes(id);

  it("an explicit link wins", () => {
    expect(captionOwnerId(cap("text-1", 0, 1, "clip-x"), exists([]))).toBe("clip-x");
  });

  it("typed text clips are unlinked", () => {
    expect(captionOwnerId(cap("text-abc", 0, 1), exists(["clip-video-1"]))).toBeNull();
    expect(captionOwnerId(cap("agent-text-1", 0, 1), exists(["clip-video-1"]))).toBeNull();
  });

  it("legacy loader captions link by scene key, narration first — never by position", () => {
    expect(captionOwnerId(cap("caption-3-0", 0, 1), exists(["clip-video-3", "clip-narration-3"])))
      .toBe("clip-narration-3");
    expect(captionOwnerId(cap("caption-3-0", 0, 1), exists(["clip-video-3"]))).toBe("clip-video-3");
    expect(captionOwnerId(cap("caption-shot-ab-12", 0, 1), exists(["clip-video-shot-ab"])))
      .toBe("clip-video-shot-ab");
    expect(captionOwnerId(cap("caption-9-0", 0, 1), exists(["clip-video-3"]))).toBeNull();
  });

  it("captionsOwnedBy never returns an unlinked caption", () => {
    const all = [cap("caption-1-0", 1, 1), cap("text-lyric", 1, 1), cap("text-2", 2, 1, "clip-video-1")];
    expect(captionsOwnedBy("clip-video-1", all, exists(["clip-video-1"])).map((c) => c.id))
      .toEqual(["caption-1-0", "text-2"]);
  });
});

describe("planOwnedCaptions", () => {
  const before = { startTime: 10, inPoint: 0, duration: 6 };

  it("a tail trim removes only captions now wholly past the end", () => {
    const caps = [cap("a", 10, 2), cap("b", 13, 1.5), cap("c", 14.5, 1.5)];
    const plan = planOwnedCaptions(caps, before, { startTime: 10, inPoint: 0, duration: 4 });
    expect(plan.removed.map((c) => c.id)).toEqual(["c"]);
    expect(plan.moved).toEqual([]); // b straddles the new end: kept, untouched
  });

  it("a head trim keeps captions on the words (shift by -Δin)", () => {
    const caps = [cap("a", 10, 1), cap("b", 13, 1)];
    const plan = planOwnedCaptions(caps, before, { startTime: 10, inPoint: 2, duration: 4 });
    expect(plan.removed.map((c) => c.id)).toEqual(["a"]);
    expect(plan.moved).toEqual([{ caption: caps[1], startTime: 11 }]);
  });

  it("a move carries every caption by the same amount and removes none", () => {
    const caps = [cap("a", 10, 1), cap("b", 15, 1)];
    const plan = planOwnedCaptions(caps, before, { startTime: 20, inPoint: 0, duration: 6 });
    expect(plan.removed).toEqual([]);
    expect(plan.moved.map((m) => m.startTime)).toEqual([20, 25]);
  });

  it("a caption placed outside its owner on purpose is never removed", () => {
    const plan = planOwnedCaptions([cap("far", 40, 1)], before, { startTime: 10, inPoint: 0, duration: 2 });
    expect(plan.removed).toEqual([]);
  });
});

// ── clip/replaceMedia through the executor ────────────────────────────────

function clip(id: string, over: Partial<Clip> = {}): Clip {
  return {
    id, mediaId: "m-old", trackId: "t1", startTime: 4, duration: 5, inPoint: 1, outPoint: 6,
    effects: [{ id: "fx1", type: "blur", params: {}, enabled: true }] as any,
    audioEffects: [],
    transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, anchor: { x: 0.5, y: 0.5 }, opacity: 1 },
    volume: 0.7, keyframes: [], ...over,
  } as Clip;
}

const media = (id: string, duration: number) => ({
  id, name: id, type: "video", fileHandle: null, blob: null,
  metadata: { duration, fileSize: 0, sampleRate: 48000, channels: 2 },
  thumbnailUrl: null, waveformData: null,
});

function project(clips: Clip[]): Project {
  return {
    id: "p", name: "p", createdAt: 0, modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [media("m-old", 10), media("m-new", 8)] },
    timeline: {
      duration: 9, subtitles: [],
      tracks: [{ id: "t1", type: "video", name: "V", clips, transitions: [], locked: false, hidden: false, muted: false, solo: false }],
    },
    textClips: [],
  } as unknown as Project;
}

describe("clip/replaceMedia", () => {
  it("swaps the media in place and undo restores the old clip exactly", async () => {
    const p = project([clip("clip-video-1")]);
    const before = JSON.parse(JSON.stringify(p.timeline.tracks[0].clips[0]));
    const ex = new ActionExecutor(new ActionHistory());
    const r = await ex.execute(
      act("clip/replaceMedia", { clipId: "clip-video-1", mediaId: "m-new", inPoint: 0, outPoint: 5 }), p);
    expect(r.success).toBe(true);
    const c = p.timeline.tracks[0].clips[0];
    expect(c).toMatchObject({ id: "clip-video-1", trackId: "t1", startTime: 4, mediaId: "m-new", inPoint: 0, outPoint: 5, duration: 5, volume: 0.7 });
    expect(c.effects).toHaveLength(1);

    expect((await ex.undo(p)).success).toBe(true);
    expect(p.timeline.tracks[0].clips[0]).toEqual(before);
  });

  it("refuses unknown media and an empty range", async () => {
    const p = project([clip("c1")]);
    const ex = new ActionExecutor(new ActionHistory());
    expect((await ex.execute(act("clip/replaceMedia", { clipId: "c1", mediaId: "nope", inPoint: 0, outPoint: 2 }), p)).success).toBe(false);
    expect((await ex.execute(act("clip/replaceMedia", { clipId: "c1", mediaId: "m-new", inPoint: 2, outPoint: 2 }), p)).success).toBe(false);
  });
});

describe("text/remove tombstones the caption", () => {
  it("so a rebuild cannot re-add it, and undo lifts the tombstone", async () => {
    const tc = { id: "caption-1-0", trackId: "track-captions", startTime: 0, duration: 1, text: "HI", style: {}, transform: {}, keyframes: [] } as unknown as TextClip;
    const clips = new Map<string, TextClip>([[tc.id, tc]]);
    const engine: TitleEngineAdapter = {
      getTextClip: (id) => clips.get(id),
      getAllTextClips: () => [...clips.values()],
      loadTextClips: (cs) => { clips.clear(); cs.forEach((c) => clips.set(c.id, c)); },
      updateTextClip: () => undefined,
      deleteTextClip: (id) => clips.delete(id),
    };
    const p = project([]);
    const ex = new ActionExecutor(new ActionHistory(), { getTitleEngine: () => engine });
    await ex.execute(act("text/remove", { clipId: tc.id, previous: tc }), p);
    const tombs = () => (p as any).deletedTracks?.flatMap((d: any) => d.clipIds) ?? [];
    expect(tombs()).toContain("caption-1-0");
    await ex.undo(p);
    expect(tombs()).not.toContain("caption-1-0");
    expect(clips.has("caption-1-0")).toBe(true);
  });
});
