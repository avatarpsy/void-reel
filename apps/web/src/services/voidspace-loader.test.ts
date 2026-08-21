import { describe, it, expect } from "vitest";
import {
  buildGraphicTracks,
  resolveGraphicWindow,
  buildTakeTracks,
  sceneIdKey,
  mergeSavedArrangement,
  isEphemeralMediaHost,
  healStaleGeneratedMediaUrls,
  type HealableMediaItem,
  type HealableScene,
} from "./voidspace-loader";

// A real expired Kie voiceover temp URL (the exact shape that rotted in the
// reported bug) and the durable GCS copy the chat pipeline mirrors it to.
const KIE_VO = "https://tempfile.redpandaai.co/kieai/161727/voidspace-studio/vo-mqr1jm7v-s6ys.mp3";
const GCS_VO = "https://storage.googleapis.com/voidspace-v1.appspot.com/studio-mirrors/uid/proj/narration/scene-1.mp3";
const GROK_VIDEO = "https://tempfile.aiquickdraw.com/abc/scene1.mp4";
const GCS_VIDEO = "https://storage.googleapis.com/voidspace-v1.appspot.com/studio-mirrors/uid/proj/video/scene-1.mp4";

const DOC = "sceneDoc1";

describe("isEphemeralMediaHost", () => {
  it("flags Kie / Grok / Suno temp hosts", () => {
    expect(isEphemeralMediaHost(KIE_VO)).toBe(true);
    expect(isEphemeralMediaHost(GROK_VIDEO)).toBe(true);
    expect(isEphemeralMediaHost("https://apiboxfiles.erweima.ai/x.mp3")).toBe(true);
  });
  it("does NOT flag durable GCS / Firebase / imports / blobs", () => {
    expect(isEphemeralMediaHost(GCS_VO)).toBe(false);
    expect(isEphemeralMediaHost("https://firebasestorage.googleapis.com/v0/b/x/o/y?alt=media")).toBe(false);
    expect(isEphemeralMediaHost("blob:https://voidspace.ai/abc")).toBe(false);
    expect(isEphemeralMediaHost(undefined)).toBe(false);
    expect(isEphemeralMediaHost(null)).toBe(false);
  });
});

describe("healStaleGeneratedMediaUrls", () => {
  it("repoints an expired narration temp URL to the durable Firestore value", () => {
    const items: HealableMediaItem[] = [
      { id: `media-narration-${DOC}-asset9`, originalUrl: KIE_VO, type: "audio", role: "narration", blob: null },
    ];
    const scenes: HealableScene[] = [{ _docId: DOC, narration_url: GCS_VO }];

    const healed = healStaleGeneratedMediaUrls(items, scenes);

    expect(healed).toBe(1);
    expect(items[0].originalUrl).toBe(GCS_VO);
  });

  it("heals video + frame + music by their id/category in one pass", () => {
    const items: HealableMediaItem[] = [
      { id: `media-video-${DOC}-v1`, originalUrl: GROK_VIDEO, type: "video" },
      { id: `media-frame-${DOC}-f1`, originalUrl: "https://tempfile.aiquickdraw.com/f.jpg", type: "image", thumbnailUrl: "https://tempfile.aiquickdraw.com/f.jpg" },
      { id: "media-music-hash", originalUrl: "https://apiboxfiles.erweima.ai/bgm.mp3", type: "audio", category: "Music" },
    ];
    const scenes: HealableScene[] = [
      { _docId: DOC, video_url: GCS_VIDEO, first_frame_url: "https://storage.googleapis.com/voidspace-v1.appspot.com/f.jpg" },
    ];

    const healed = healStaleGeneratedMediaUrls(items, scenes, "https://storage.googleapis.com/voidspace-v1.appspot.com/bgm.mp3");

    expect(healed).toBe(3);
    expect(items[0].originalUrl).toBe(GCS_VIDEO);
    // image item: thumbnail follows the durable url (frame poster).
    expect(items[1].thumbnailUrl).toBe("https://storage.googleapis.com/voidspace-v1.appspot.com/f.jpg");
    expect(items[2].originalUrl).toBe("https://storage.googleapis.com/voidspace-v1.appspot.com/bgm.mp3");
  });

  it("leaves durable URLs and user imports untouched", () => {
    const items: HealableMediaItem[] = [
      { id: `media-narration-${DOC}-a`, originalUrl: GCS_VO, type: "audio" },
      { id: "user-import-1", originalUrl: "blob:https://voidspace.ai/xyz", type: "audio" },
    ];
    const scenes: HealableScene[] = [{ _docId: DOC, narration_url: GCS_VO }];

    const healed = healStaleGeneratedMediaUrls(items, scenes);

    expect(healed).toBe(0);
    expect(items[0].originalUrl).toBe(GCS_VO);
    expect(items[1].originalUrl).toBe("blob:https://voidspace.ai/xyz");
  });

  it("does NOT swap a temp URL for another still-ephemeral value (un-mirrored scene)", () => {
    // narration_url in Firestore is itself still a temp URL (mirror never
    // succeeded) — there is no durable copy, so the heal must leave it alone
    // rather than swap one dead link for another.
    const stillTemp = "https://tempfile.redpandaai.co/kieai/161727/voidspace-studio/vo-fresh.mp3";
    const items: HealableMediaItem[] = [
      { id: `media-narration-${DOC}-a`, originalUrl: KIE_VO, type: "audio" },
    ];
    const scenes: HealableScene[] = [{ _docId: DOC, narration_url: stillTemp }];

    const healed = healStaleGeneratedMediaUrls(items, scenes);

    expect(healed).toBe(0);
    expect(items[0].originalUrl).toBe(KIE_VO);
  });

  it("does not cross-wire scenes — each docId heals to its own URL", () => {
    const items: HealableMediaItem[] = [
      { id: "media-narration-sceneA-a", originalUrl: KIE_VO, type: "audio" },
      { id: "media-narration-sceneB-b", originalUrl: "https://tempfile.redpandaai.co/x/other.mp3", type: "audio" },
    ];
    const scenes: HealableScene[] = [
      { _docId: "sceneA", narration_url: "https://storage.googleapis.com/voidspace-v1.appspot.com/a.mp3" },
      { _docId: "sceneB", narration_url: "https://storage.googleapis.com/voidspace-v1.appspot.com/b.mp3" },
    ];

    const healed = healStaleGeneratedMediaUrls(items, scenes);

    expect(healed).toBe(2);
    expect(items[0].originalUrl).toBe("https://storage.googleapis.com/voidspace-v1.appspot.com/a.mp3");
    expect(items[1].originalUrl).toBe("https://storage.googleapis.com/voidspace-v1.appspot.com/b.mp3");
  });
});

/**
 * THE KEY THAT MEDIA AND CLIP IDS ARE BUILT FROM.
 *
 * Two places derive it: the per-scene rebuild that MINTS the ids, and the
 * stale-blob probe that reconstructs the same prefixes to ask "does the saved
 * timeline already cover this scene?".
 *
 * When those two disagree the probe matches nothing, every scene looks missing
 * from the blob, and the loader discards the user's saved arrangement and
 * rebuilds from storyboard order — on EVERY load. Nothing errors. The only
 * symptom is an edit that quietly undoes itself, which is close to the worst
 * possible way for a bug to present.
 *
 * That is not hypothetical: it happened the moment the rebuild moved to
 * `source_shot_id` and the probe was left on `_docId`. These tests exist so the
 * two can never drift apart again.
 */
describe("sceneIdKey", () => {
  it("prefers the board shot id, which survives a reorder", () => {
    // Insert a shot above this one and `_docId` changes; `source_shot_id` does
    // not. Keying on the shot is what stops every clip below an insertion
    // reading as brand new.
    expect(sceneIdKey({ _docId: "3", source_shot_id: "shot-abc" })).toBe("shot-abc");
  });

  it("falls back to the scene number for projects that never came from a board", () => {
    // A studio-generated project has no shot ids, and must keep exactly the ids
    // it has always had.
    expect(sceneIdKey({ _docId: "3" })).toBe("3");
    expect(sceneIdKey({ _docId: "3", source_shot_id: "" })).toBe("3");
  });

  it("is stable for one shot across different scene positions", () => {
    // THE PROPERTY THE WHOLE THING RESTS ON: the same shot at position 3 and at
    // position 4 produces the same key, so its clip is recognised as the same
    // clip after an insertion rather than merged in as a second copy.
    const before = sceneIdKey({ _docId: "3", source_shot_id: "shot-abc" });
    const after = sceneIdKey({ _docId: "4", source_shot_id: "shot-abc" });
    expect(after).toBe(before);
  });

  it("gives different shots different keys at the same position", () => {
    expect(sceneIdKey({ _docId: "3", source_shot_id: "shot-a" }))
      .not.toBe(sceneIdKey({ _docId: "3", source_shot_id: "shot-b" }));
  });
});

/**
 * KEEPING THE USER'S CUT WHEN NEW MATERIAL ARRIVES.
 *
 * The saved `project_state` blob is the user's arrangement. The loader used to
 * DISCARD it whenever Firestore held scene media the blob did not cover — so
 * adding one shot to the storyboard and recompiling reverted the timeline to
 * board order and threw away every trim and reorder. No crash, no warning; the
 * more work somebody had done, the more they lost.
 *
 * These pin the replacement: the saved arrangement wins for everything it
 * already has, and genuinely new clips are appended.
 */
function clip(id: string, startTime: number, duration = 5, trackId = "track-video") {
  return {
    id, mediaId: `m-${id}`, trackId, startTime, duration,
    inPoint: 0, outPoint: duration,
    effects: [], audioEffects: [],
    transform: {
      position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0,
      anchor: { x: 0.5, y: 0.5 }, opacity: 1,
    },
    volume: 1, keyframes: [],
  } as any;
}

function track(id: string, clips: any[], type = "video") {
  return {
    id, type, name: id, clips, transitions: [],
    locked: false, hidden: false, muted: false, solo: false,
  } as any;
}

function proj(tracks: any[], mediaIds: string[] = [], textClips: any[] = []) {
  return {
    id: "p", name: "p", createdAt: 0, modifiedAt: 0,
    settings: {} as any,
    mediaLibrary: { items: mediaIds.map((id) => ({ id })) as any },
    timeline: { tracks, subtitles: [], duration: 0, markers: [] },
    textClips,
  } as any;
}

describe("mergeSavedArrangement", () => {
  it("keeps the user's order and timings for clips it already had", () => {
    // The user moved shot 2 to the front. The rebuild says board order. The
    // saved arrangement wins — that IS the edit.
    const saved = proj([track("track-video", [clip("c2", 0), clip("c1", 5)])]);
    const rebuilt = proj([track("track-video", [clip("c1", 0), clip("c2", 5), clip("c3", 10)])]);

    const out = mergeSavedArrangement(rebuilt, saved);
    const ids = out.timeline.tracks[0]!.clips.map((c: any) => c.id);
    expect(ids.slice(0, 2)).toEqual(["c2", "c1"]);
    expect(out.timeline.tracks[0]!.clips.find((c: any) => c.id === "c2")!.startTime).toBe(0);
    expect(out.timeline.tracks[0]!.clips.find((c: any) => c.id === "c1")!.startTime).toBe(5);
  });

  it("appends the new clip exactly where the saved cut ENDS, not where the board put it", () => {
    // The user trimmed: their cut runs 0..7, while the board's layout would put
    // the new shot at 10. Leaving it at 10 opens three seconds of dead air that
    // nothing on screen explains.
    const saved = proj([track("track-video", [clip("c2", 0, 3), clip("c1", 3, 4)])]);
    const rebuilt = proj([track("track-video", [clip("c1", 0, 5), clip("c2", 5, 5), clip("c3", 10, 5)])]);

    const out = mergeSavedArrangement(rebuilt, saved);
    const c3 = out.timeline.tracks[0]!.clips.find((c: any) => c.id === "c3")!;
    expect(c3.startTime).toBe(7);
  });

  it("shifts every new clip by the SAME delta, so a scene stays in sync", () => {
    // THE SUBTLE ONE. A new shot is a video clip AND its narration at the same
    // instant. Appending each track independently would slide them apart and
    // the voiceover would drift off its picture.
    const saved = proj([
      track("track-video", [clip("v1", 0, 6)]),
      track("track-narration", [clip("n1", 0, 6, "track-narration")], "audio"),
    ]);
    const rebuilt = proj([
      track("track-video", [clip("v1", 0, 8), clip("v2", 8, 5)]),
      track("track-narration", [
        clip("n1", 0, 8, "track-narration"),
        clip("n2", 8, 5, "track-narration"),
      ], "audio"),
    ]);

    const out = mergeSavedArrangement(rebuilt, saved);
    const v2 = out.timeline.tracks.find((t: any) => t.id === "track-video")!
      .clips.find((c: any) => c.id === "v2")!;
    const n2 = out.timeline.tracks.find((t: any) => t.id === "track-narration")!
      .clips.find((c: any) => c.id === "n2")!;
    expect(v2.startTime).toBe(n2.startTime);
  });

  it("returns the saved project untouched when nothing is actually new", () => {
    // The staleness probe counts SCENES, which can disagree with what is on the
    // timeline — a clip the user deleted, say. Rebuilding then would undo their
    // work to add nothing.
    const saved = proj([track("track-video", [clip("c1", 3), clip("c2", 9)])]);
    const rebuilt = proj([track("track-video", [clip("c1", 0), clip("c2", 5)])]);

    expect(mergeSavedArrangement(rebuilt, saved)).toBe(saved);
  });

  it("never drops a clip the saved cut has and the rebuild does not", () => {
    // A clip the user added by hand in the editor exists in no scene doc. The
    // rebuild cannot know about it, and losing it would be the same class of
    // failure this whole function exists to prevent.
    const saved = proj([track("track-video", [clip("c1", 0), clip("hand-added", 5)])]);
    const rebuilt = proj([track("track-video", [clip("c1", 0), clip("c2", 5)])]);

    const ids = mergeSavedArrangement(rebuilt, saved).timeline.tracks[0]!.clips
      .map((c: any) => c.id);
    expect(ids).toContain("hand-added");
    expect(ids).toContain("c2");
  });

  it("adds a brand-new Take track ABOVE the video it is an alternate to", () => {
    // Array order is z-order: a lower index paints on top. Appending would put
    // the alternate underneath the footage it stands in for.
    const saved = proj([track("track-video", [clip("v1", 0)])]);
    const rebuilt = proj([
      track("track-take-2", [clip("t2", 0, 5, "track-take-2")]),
      track("track-video", [clip("v1", 0)]),
    ]);

    const out = mergeSavedArrangement(rebuilt, saved);
    const ids = out.timeline.tracks.map((t: any) => t.id);
    expect(ids.indexOf("track-take-2")).toBeLessThan(ids.indexOf("track-video"));
  });

  it("unions the media library, preferring the saved copy", () => {
    // The blob's urls may have been healed on a previous load; a rebuild copy
    // can be the stale one that healing replaced.
    const saved = proj([track("track-video", [clip("c1", 0)])], ["m-c1"]);
    const rebuilt = proj([track("track-video", [clip("c1", 0), clip("c2", 5)])], ["m-c1", "m-c2"]);

    const items = mergeSavedArrangement(rebuilt, saved).mediaLibrary.items.map((m: any) => m.id);
    expect(items).toEqual(["m-c1", "m-c2"]);
  });

  it("recomputes the timeline duration to cover what it appended", () => {
    const saved = proj([track("track-video", [clip("c1", 0, 5)])]);
    const rebuilt = proj([track("track-video", [clip("c1", 0, 5), clip("c2", 5, 7)])]);

    expect(mergeSavedArrangement(rebuilt, saved).timeline.duration).toBe(12);
  });

  /**
   * A NESTED SEQUENCE ARRIVES IN TWO PIECES, AND BOTH HAVE TO MAKE THE TRIP.
   *
   * The INSTANCE is an ordinary clip and merges with the rest. The CONTENT sits
   * on `compoundClips`, which is not a track — so it has to be carried
   * deliberately, and until this it was not. The result was an instance
   * referencing a sequence that did not exist: a hole in the picture and
   * silence under it, with nothing naming the cause.
   */
  const compound = (id: string, duration = 6) => ({
    id, name: id, createdAt: 0, modifiedAt: 0, color: "#8b5cf6",
    content: { clips: [], tracks: [], duration },
  }) as any;

  const instance = (id: string, compoundId: string, startTime: number) =>
    ({ ...clip(id, startTime), mediaId: `compound:${compoundId}` }) as any;

  it("carries the sequences the newly merged instances point at", () => {
    const saved = proj([track("track-video", [clip("c1", 0)])]);
    const rebuilt = proj([
      track("track-video", [clip("c1", 0), instance("i1", "seq-a", 5)]),
    ]);
    (rebuilt as any).compoundClips = [compound("seq-a")];

    const out = mergeSavedArrangement(rebuilt, saved);

    // The instance came across…
    const ids = out.timeline.tracks[0]!.clips.map((c: any) => c.id);
    expect(ids).toContain("i1");
    // …and so did the sequence it needs to render.
    expect((out as any).compoundClips?.map((c: any) => c.id)).toEqual(["seq-a"]);
  });

  it("does NOT overwrite a sequence the user has already edited", () => {
    // Same id on both sides means the user opened that sequence and changed it.
    // Their version is the true one — a rebuild copy replacing it would silently
    // undo an edit made INSIDE the container.
    const saved = proj([track("track-video", [clip("c1", 0)])]);
    (saved as any).compoundClips = [compound("seq-a", 99)];
    const rebuilt = proj([
      track("track-video", [clip("c1", 0), instance("i1", "seq-a", 5)]),
    ]);
    (rebuilt as any).compoundClips = [compound("seq-a", 6)];

    const out = mergeSavedArrangement(rebuilt, saved);
    expect((out as any).compoundClips).toHaveLength(1);
    expect((out as any).compoundClips[0].content.duration).toBe(99);
  });

  it("keeps a saved sequence the rebuild no longer knows about", () => {
    // Sending to the editor ADDS. A sequence the user built by hand in the
    // editor has no counterpart on the board and must survive a recompile.
    const saved = proj([track("track-video", [clip("c1", 0)])]);
    (saved as any).compoundClips = [compound("hand-made")];
    const rebuilt = proj([track("track-video", [clip("c1", 0), clip("c2", 5)])]);

    const out = mergeSavedArrangement(rebuilt, saved);
    expect((out as any).compoundClips?.map((c: any) => c.id)).toEqual(["hand-made"]);
  });

  it("attaches no compoundClips key at all when neither side has one", () => {
    // An ordinary film must stay byte-identical in shape to what it was before
    // nested sequences existed.
    const saved = proj([track("track-video", [clip("c1", 0)])]);
    const rebuilt = proj([track("track-video", [clip("c1", 0), clip("c2", 5)])]);

    expect("compoundClips" in mergeSavedArrangement(rebuilt, saved)).toBe(false);
  });
});

/**
 * THE ALTERNATE-TAKE TRACKS.
 *
 * Four takes of one shot arrive time-aligned and stacked, not one after
 * another — serial layout would make the film four times too long and turn
 * editing into deletion. These are the rules that make the stack behave, and
 * every one of them is invisible in the running product until it is wrong,
 * at which point it reads as the editor being broken rather than a track flag.
 */
describe("buildTakeTracks", () => {
  const clip = (id: string, trackId: string) => ({
    id, mediaId: `m-${id}`, trackId, startTime: 0, duration: 5,
    inPoint: 0, outPoint: 5, effects: [], audioEffects: [],
    transform: {} as any, volume: 1, keyframes: [],
  }) as any;

  it("is empty when nothing was generated twice", () => {
    // The overwhelmingly common shot has one take. No stack, no empty rows.
    expect(buildTakeTracks(new Map())).toEqual([]);
  });

  it("orders HIGHEST take first, so Take 3 sits above Take 2 above Video", () => {
    // Array order is z-order and a LOWER index paints on top. Getting this
    // backwards puts the alternates underneath the footage they stand in for,
    // where unhiding one appears to do nothing at all.
    const tracks = buildTakeTracks(new Map([
      [2, [clip("a", "track-take-2")]],
      [3, [clip("b", "track-take-3")]],
      [4, [clip("c", "track-take-4")]],
    ]));
    expect(tracks.map((t) => t.id)).toEqual([
      "track-take-4", "track-take-3", "track-take-2",
    ]);
  });

  it("is hidden AND muted — hidden alone means hearing every take at once", () => {
    // `hidden` appears nowhere in packages/core/src/audio: audibility is
    // mute/solo only, and getAudioTracksAtTime includes VIDEO tracks. So a
    // hidden-only take track is silent to the eye and fully audible.
    const [t] = buildTakeTracks(new Map([[2, [clip("a", "track-take-2")]]]));
    expect(t.hidden).toBe(true);
    expect(t.muted).toBe(true);
  });

  it("names tracks the way the user reads them", () => {
    const [t] = buildTakeTracks(new Map([[2, [clip("a", "track-take-2")]]]));
    expect(t.name).toBe("Take 2");
    expect(t.id).toBe("track-take-2");
    expect(t.type).toBe("video");
  });

  it("skips a slot with no clips rather than adding an empty row", () => {
    const tracks = buildTakeTracks(new Map([
      [2, [clip("a", "track-take-2")]],
      [3, []],
    ]));
    expect(tracks.map((t) => t.id)).toEqual(["track-take-2"]);
  });

  it("leaves the clips exactly as given — alignment is decided upstream", () => {
    // Each alternate starts at the same instant as the take that plays. This
    // function must not retime anything; doing so would slide a take off the
    // shot it belongs to.
    const clips = [clip("a", "track-take-2"), clip("b", "track-take-2")];
    const [t] = buildTakeTracks(new Map([[2, clips]]));
    expect(t.clips).toBe(clips);
  });

  it("is not locked and not soloed — the user can work with it immediately", () => {
    const [t] = buildTakeTracks(new Map([[2, [clip("a", "track-take-2")]]]));
    expect(t.locked).toBe(false);
    expect(t.solo).toBe(false);
  });
});

/**
 * THE GRAPHIC LAYER TRACKS.
 *
 * A rendered graphic is an ORDINARY VIDEO TRACK — that is the design, and it is
 * what makes trim, razor, opacity, transitions, save and load work on it with
 * nothing new taught to the editor. What is special is only where it sits in the
 * array, which is the z-order rule every pixel track already obeys.
 *
 * These rules are invisible in the running product until they are wrong, and
 * when they are wrong the graphic is not subtly misplaced — it is behind the
 * footage, which reads as "the overlay did nothing".
 */
describe("buildGraphicTracks", () => {
  const clip = (id: string, trackId: string) => ({
    id, mediaId: `m-${id}`, trackId, startTime: 0, duration: 3,
    inPoint: 0, outPoint: 3, effects: [], audioEffects: [],
    transform: {} as any, volume: 1, keyframes: [],
  }) as any;

  it("is empty when no shot has a graphic over it", () => {
    expect(buildGraphicTracks(new Map())).toEqual([]);
  });

  it("orders HIGHEST layer first, so Graphic 2 sits above Graphic 1", () => {
    // Array order is z-order and a LOWER index paints on top. The card lists
    // layers bottom-most first, so the last one there must be the first here —
    // otherwise the stack the user built is inverted in the film.
    const tracks = buildGraphicTracks(new Map([
      [1, [clip("a", "track-graphic-1")]],
      [2, [clip("b", "track-graphic-2")]],
    ]));
    expect(tracks.map((t) => t.id)).toEqual(["track-graphic-2", "track-graphic-1"]);
  });

  it("is VISIBLE and UNMUTED — the inverse of a take track, deliberately", () => {
    // A take is an alternate you audition; a graphic is part of the picture and
    // is supposed to be on screen. Shipping these hidden would mean every
    // overlay the user designed arrived switched off.
    const [t] = buildGraphicTracks(new Map([[1, [clip("a", "track-graphic-1")]]]));
    expect(t.hidden).toBe(false);
    expect(t.muted).toBe(false);
  });

  it("is an ORDINARY VIDEO TRACK, named so it can be recognised", () => {
    // Not a new track TYPE. Everything that saves, loads and renders a timeline
    // already handles `video`; a bespoke type would need all of it taught again
    // and would break saving a project that contains one.
    const [t] = buildGraphicTracks(new Map([[1, [clip("a", "track-graphic-1")]]]));
    expect(t.type).toBe("video");
    expect(t.name).toBe("Graphic 1");
    expect(t.id).toBe("track-graphic-1");
  });

  it("skips a layer position with no clips rather than adding an empty row", () => {
    const tracks = buildGraphicTracks(new Map([
      [1, [clip("a", "track-graphic-1")]],
      [2, []],
    ]));
    expect(tracks.map((t) => t.id)).toEqual(["track-graphic-1"]);
  });

  it("leaves the clips exactly as given — placement is decided upstream", () => {
    // Where a layer sits depends on the chosen take's measured length, which the
    // scene loop knows and this function does not. Retiming here would slide a
    // lower third off the shot it names.
    const clips = [clip("a", "track-graphic-1")];
    const [t] = buildGraphicTracks(new Map([[1, clips]]));
    expect(t.clips).toBe(clips);
  });

  it("is not locked and not soloed", () => {
    const [t] = buildGraphicTracks(new Map([[1, [clip("a", "track-graphic-1")]]]));
    expect(t.locked).toBe(false);
    expect(t.solo).toBe(false);
  });
});

/**
 * WHERE A GRAPHIC LAYER SITS INSIDE ITS SHOT.
 *
 * The board stores a RULE, never a position, because the shot's real length is
 * whatever take the user finally picks. These tests pin the resolution of that
 * rule against the code the timeline actually runs -- an earlier draft had a
 * twin of this on the board that nothing called, which tested a behaviour the
 * product did not have.
 */
describe("resolveGraphicWindow", () => {
  const layer = (over: Record<string, unknown> = {}) =>
    ({ offsetSec: 0, holdSec: 0, anchor: "start", ...over });

  it("runs the whole shot when the render is long enough to cover it", () => {
    expect(resolveGraphicWindow(layer(), 0, 8, 12))
      .toEqual({ startTime: 0, duration: 8 });
  });

  it("NEVER outlives the file it was rendered from", () => {
    // "For the whole shot" taken literally would stretch a 3s render across an
    // 8s shot -- five seconds frozen on its last frame, which reads as a stall
    // rather than a design. This is the case the deleted board twin got wrong.
    expect(resolveGraphicWindow(layer(), 0, 8, 3))
      .toEqual({ startTime: 0, duration: 3 });
  });

  it("an offset shortens what is left and never runs into the next shot", () => {
    expect(resolveGraphicWindow(layer({ offsetSec: 1.5, holdSec: 10 }), 0, 8, 10))
      .toEqual({ startTime: 1.5, duration: 6.5 });
  });

  it("places the layer against the SHOT, not against the timeline origin", () => {
    // Shot three starts 20s in. A layer that ignored the slot start would land
    // over the opening shot instead.
    expect(resolveGraphicWindow(layer({ offsetSec: 1 }), 20, 8, 3))
      .toEqual({ startTime: 21, duration: 3 });
  });

  it("a start-anchored layer stays put when a longer take arrives", () => {
    // THE take invariant. The user generates an 8s alternate to a 5s take and
    // picks it; the speaker's name still appears when the speaker does.
    const g = layer({ offsetSec: 0.5, holdSec: 3 });
    expect(resolveGraphicWindow(g, 0, 5, 3)).toEqual({ startTime: 0.5, duration: 3 });
    expect(resolveGraphicWindow(g, 0, 8, 3)).toEqual({ startTime: 0.5, duration: 3 });
  });

  it("an end-anchored layer FOLLOWS the new ending", () => {
    // The other half of the same invariant. An end card measured from the start
    // would land in the middle of a longer take, over live footage.
    const g = layer({ anchor: "end", holdSec: 2 });
    expect(resolveGraphicWindow(g, 0, 5, 2)).toEqual({ startTime: 3, duration: 2 });
    expect(resolveGraphicWindow(g, 0, 8, 2)).toEqual({ startTime: 6, duration: 2 });
  });

  it("an end-anchored layer with an offset holds off the end by that much", () => {
    expect(resolveGraphicWindow(layer({ anchor: "end", offsetSec: 1, holdSec: 2 }), 0, 10, 2))
      .toEqual({ startTime: 7, duration: 2 });
  });

  it("never produces a start before the shot or a negative length", () => {
    // A chosen take shorter than the layer asked for. Clamping here is what
    // stops a clip with a negative start reaching the timeline, where it is a
    // crash rather than a bad edit.
    expect(resolveGraphicWindow(layer({ anchor: "end", holdSec: 9 }), 0, 3, 9))
      .toEqual({ startTime: 0, duration: 3 });
    expect(resolveGraphicWindow(layer({ offsetSec: 12, holdSec: 4 }), 0, 3, 4))
      .toEqual({ startTime: 3, duration: 0 });
  });

  it("falls back to the shot when nothing knows the file length", () => {
    // A layer whose render never reported a duration. Better to hold for the
    // shot than to drop it.
    expect(resolveGraphicWindow(layer(), 0, 6, 0))
      .toEqual({ startTime: 0, duration: 6 });
  });
});

/**
 * A GRAPHIC CLIP'S BLEND SURVIVES THE ADDITIVE MERGE.
 *
 * The merge keeps the SAVED cut and only appends what is new — right for
 * position and trim, wrong for `blendMode`, which is not an arrangement the user
 * chose but a property of what a graphic clip IS. A transparent overlay without
 * `screen` covers the shot, and a project saved before the loader set it would
 * stay broken through every re-send.
 */
describe("graphic clips keep their blend through a merge", () => {
  const clip = (over: Record<string, unknown> = {}) => ({
    id: "clip-graphic-a", mediaId: "m1", trackId: "track-graphic-1",
    startTime: 0, duration: 4, inPoint: 0, outPoint: 4,
    effects: [], audioEffects: [], transform: {} as any, volume: 1, keyframes: [],
    ...over,
  }) as any;
  const track = (over: Record<string, unknown> = {}) => ({
    id: "track-graphic-1", type: "video", name: "Graphic 1",
    clips: [clip()], transitions: [], locked: false, hidden: false, muted: false, solo: false,
    ...over,
  }) as any;
  const project = (tracks: any[]) => ({
    id: "p", name: "p", createdAt: 0, modifiedAt: 0,
    settings: { width: 1080, height: 1920, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: { tracks, duration: 10 },
  }) as any;

  it("heals a saved graphic clip that predates the blend", () => {
    const saved = project([track()]);
    const merged = mergeSavedArrangement(project([track()]), saved);
    const gt = merged.timeline.tracks.find((t: any) => t.id === "track-graphic-1")!;
    expect(gt.clips[0].blendMode).toBe("screen");
  });

  it("NEVER overwrites a blend the user chose — including normal", () => {
    // Any actual value means somebody picked it in the inspector. Healing over
    // that would fight them every time the project opened.
    const saved = project([track({ clips: [clip({ blendMode: "normal" })] })]);
    const merged = mergeSavedArrangement(project([track()]), saved);
    const gt = merged.timeline.tracks.find((t: any) => t.id === "track-graphic-1")!;
    expect(gt.clips[0].blendMode).toBe("normal");
  });

  it("leaves clips on every OTHER track completely alone", () => {
    // Nothing else on the timeline has a blend it did not ask for.
    const video = track({ id: "track-video", name: "Video",
      clips: [clip({ id: "clip-video-a", trackId: "track-video" })] });
    const saved = project([video]);
    const merged = mergeSavedArrangement(project([video]), saved);
    const vt = merged.timeline.tracks.find((t: any) => t.id === "track-video")!;
    expect(vt.clips[0].blendMode).toBeUndefined();
  });
});

/**
 * A FRESHLY BUILT GRAPHIC CLIP CARRIES THE BLEND FROM BIRTH.
 *
 * The heal above is a safety net for blobs saved before this existed. The clip
 * construction itself lives inside the async scene loop, so it is pinned by
 * source rather than called: what matters is that the field is there at all,
 * because without it the very first send of a new overlay is already wrong and
 * the user is left setting it by hand in the inspector.
 */
describe("new graphic clips are born with the blend", () => {
  it("sets screen where the graphic clip is constructed", async () => {
    const [{ readFileSync }, { join }] = await Promise.all([
      import("node:fs"), import("node:path"),
    ]);
    const src = readFileSync(
      join(process.cwd(), "src/services/voidspace-loader.ts"), "utf8",
    );
    // The clip literal that carries a graphic render — identified by the
    // transform + blend pair the surrounding comment documents.
    expect(src).toContain('blendMode: "screen"');
    // And the heal must agree with it, or an old project and a new one would
    // composite differently.
    expect(src).toContain('c.blendMode === undefined ? { ...c, blendMode: "screen" as const } : c');
  });
});

/**
 * THE HEAL HAS TO RUN ON THE LOCALLY RECOVERED COPY TOO.
 *
 * This is the one that actually bit. Healing inside the loader looked complete
 * and was not: App.tsx recovers an IndexedDB auto-save FIRST and then installs
 * the Firestore load in additive-only mode, so the healed project loses to the
 * local copy that has been there all along — the console says it plainly,
 * "merged: no-op (already up-to-date)". The user's overlay stayed black until
 * they set `screen` by hand, and re-sending the board never reached it.
 *
 * Pinned by source because the branch is inside a long async boot effect, and
 * what has to stay true is simply that the recovery path calls the heal at all.
 */
describe("local auto-save recovery heals the blend as well", () => {
  it("App.tsx heals the recovered project, not just the loader's", async () => {
    const [{ readFileSync }, { join }] = await Promise.all([
      import("node:fs"), import("node:path"),
    ]);
    const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
    expect(app).toContain("healGraphicBlends");
    // And it must act on what is IN THE STORE after recovery — healing a
    // freshly loaded project here would be healing the copy that loses.
    const block = /healGraphicBlends[\s\S]{0,600}/.exec(app)![0];
    expect(block).toContain("useProjectStore.getState().project");
    expect(block).toContain("useProjectStore.setState");
  });
});
