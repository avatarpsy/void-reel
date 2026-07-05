import { describe, it, expect } from "vitest";
import {
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
