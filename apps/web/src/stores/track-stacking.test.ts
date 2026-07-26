import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "./project-store";

/**
 * An overlay is just a video: an alpha WebM on its own video track, composited
 * over the picture below it.
 *
 * That only works if the new track lands ABOVE the existing one. Track order is
 * z-order — pixel tracks paint by DESCENDING index, so a LOWER index sits on
 * top — and new tracks used to be appended, which put every added video track
 * at the BOTTOM. A lower third added that way rendered behind the footage and
 * was simply invisible, with nothing to explain why.
 *
 * These tests pin the stacking rule, which is also the NLE convention: V2 over
 * V1.
 */
describe("new tracks stack in the right z-order", () => {
  beforeEach(() => {
    useProjectStore.getState().createNewProject("stacking");
  });

  const tracks = () => useProjectStore.getState().project.timeline.tracks;
  const typesOf = () => tracks().map((t) => t.type);

  it("puts a new video track ABOVE the existing one, so an overlay is visible", async () => {
    await useProjectStore.getState().addTrack("video");
    const firstVideoId = tracks().find((t) => t.type === "video")!.id;

    await useProjectStore.getState().addTrack("video");

    const videoTracks = tracks().filter((t) => t.type === "video");
    expect(videoTracks).toHaveLength(2);
    // The newest video track must come FIRST — lower index paints last, on top.
    expect(videoTracks[0].id).not.toBe(firstVideoId);
    expect(videoTracks[1].id).toBe(firstVideoId);
  });

  it("stacks a new image track above existing image tracks", async () => {
    await useProjectStore.getState().addTrack("image");
    const firstImageId = tracks().find((t) => t.type === "image")!.id;

    await useProjectStore.getState().addTrack("image");

    const imageTracks = tracks().filter((t) => t.type === "image");
    expect(imageTracks[0].id).not.toBe(firstImageId);
    expect(imageTracks[1].id).toBe(firstImageId);
  });

  it("still appends the FIRST track of a type", async () => {
    const before = tracks().length;

    await useProjectStore.getState().addTrack("video");

    expect(tracks()).toHaveLength(before + 1);
    expect(tracks()[before].type).toBe("video");
  });

  it("keeps appending audio — it has no z-order to get wrong", async () => {
    await useProjectStore.getState().addTrack("audio");
    const firstAudioId = tracks().find((t) => t.type === "audio")!.id;

    await useProjectStore.getState().addTrack("audio");

    const audioTracks = tracks().filter((t) => t.type === "audio");
    expect(audioTracks[0].id).toBe(firstAudioId);
  });

  it("honours an explicit position, overriding the stacking rule", async () => {
    await useProjectStore.getState().addTrack("video");
    const before = typesOf();

    await useProjectStore.getState().addTrack("video", before.length);

    expect(tracks()[before.length].type).toBe("video");
  });
});
