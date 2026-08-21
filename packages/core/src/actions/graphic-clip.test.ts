/**
 * A GRAPHIC IS BORN COMPOSITED, WHATEVER PUT IT THERE.
 *
 * A rendered HyperFrames block has a transparent background, and this
 * compositor receives every transparent pixel as BLACK — so on the default
 * blend the graphic covers the shot instead of sitting on it. `screen` is the
 * fix, and the reason it is applied at `clip/add` rather than at each caller is
 * that there are four callers and counting: the board handoff, the agent's
 * `add_overlay`, a drag from the block library, and duplicating a clip that is
 * already on the timeline. A rule spread across four sites is four chances to
 * forget, and forgetting produces a black rectangle nobody can explain.
 *
 * These tests drive the executor directly — the same action every one of those
 * routes ends up dispatching.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { ActionExecutor } from "./action-executor";
import type { Action } from "../types/actions";
import type { Project, MediaItem } from "../types/project";

function media(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "m-graphic",
    name: "lt-clean-bar.webm",
    type: "video",
    source: "generated",
    url: "blob:x",
    metadata: {
      duration: 4.8, width: 1920, height: 1080, frameRate: 30,
      codec: "vp9", sampleRate: 0, channels: 0, fileSize: 1,
    },
    ...over,
  } as MediaItem;
}

function project(items: MediaItem[]): Project {
  return {
    id: "p", name: "p", createdAt: 0, modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items },
    timeline: {
      duration: 30,
      tracks: [{
        id: "track-video", type: "video", name: "Video", clips: [],
        transitions: [], locked: false, hidden: false, muted: false, solo: false,
      }],
    },
  } as unknown as Project;
}

const GRAPHIC = { block: "lt-clean-bar", slots: { name: "Nihar" }, mode: "overlay" as const };

function addClip(extra: Record<string, unknown> = {}): Action {
  return {
    type: "clip/add",
    id: "a1",
    timestamp: 1,
    params: { trackId: "track-video", mediaId: "m-graphic", startTime: 0, duration: 4.8, ...extra },
  } as Action;
}

describe("a clip added from a graphic media item", () => {
  let exec: ActionExecutor;
  beforeEach(() => { exec = new ActionExecutor(); });

  const placed = async (p: Project, action: Action) => {
    const r = await exec.execute(action, p);
    expect(r.success, JSON.stringify((r as any).error)).toBe(true);
    return p.timeline.tracks[0]!.clips[0]!;
  };

  it("gets screen blend, so it composites instead of covering the shot", async () => {
    const p = project([media({ metadata: { ...media().metadata, graphic: GRAPHIC } as never })]);
    expect((await placed(p, addClip())).blendMode).toBe("screen");
  });

  it("carries which block it is, and what was typed into it", async () => {
    // Without this the inspector holding a clip cannot offer the slots, and
    // "change that title" means rendering a new graphic from nothing.
    const p = project([media({ metadata: { ...media().metadata, graphic: GRAPHIC } as never })]);
    const clip = await placed(p, addClip());
    expect(clip.metadata?.graphic).toEqual(GRAPHIC);
  });

  it("NEVER overrides a blend the caller asked for — including normal", async () => {
    // The inspector must be able to take a graphic off screen blend and have it
    // stay off; a rule that fought the user every time they placed a clip would
    // be worse than no rule.
    const p = project([media({ metadata: { ...media().metadata, graphic: GRAPHIC } as never })]);
    const clip = await placed(p, addClip({ blendMode: "normal" }));
    expect(clip.blendMode).toBe("normal");
  });

  it("leaves an ORDINARY clip exactly as it was — no blend, no metadata", async () => {
    // The whole rule has to be invisible to footage. If plain video started
    // arriving with a blend or a metadata bag, every existing project would
    // begin composing differently.
    const p = project([media()]);
    const clip = await placed(p, addClip());
    expect(clip.blendMode).toBeUndefined();
    expect(clip.metadata).toBeUndefined();
  });

});
