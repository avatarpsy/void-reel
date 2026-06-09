import { describe, it, expect } from "vitest";
import {
  buildRelinkPlan,
  kindForItem,
  kindForFile,
  kindsCompatible,
  parseUrlHints,
  sceneFromFilename,
  baseNameOf,
  type RelinkableItem,
  type IndexedFile,
  type ParsedManifest,
} from "./media-relink";

// Minimal IndexedFile factory (handle/file are unused by the pure matcher).
const f = (relPath: string, size = 100): IndexedFile => {
  const name = relPath.split("/").pop()!.toLowerCase();
  const parentDir = (relPath.split("/").slice(0, -1).pop() || "").toLowerCase();
  return {
    name,
    relPath,
    parentDir,
    size,
    handle: {} as FileSystemFileHandle,
    file: { name, size } as File,
  };
};

describe("kind classification", () => {
  it("classifies items by type/role/category", () => {
    expect(kindForItem({ id: "1", name: "v", type: "video" })).toBe("video");
    expect(kindForItem({ id: "2", name: "i", type: "image" })).toBe("image");
    expect(kindForItem({ id: "3", name: "n", type: "audio", role: "narration" })).toBe("narration");
    expect(kindForItem({ id: "4", name: "m", type: "audio", category: "Music" })).toBe("music");
    expect(kindForItem({ id: "5", name: "a", type: "audio" })).toBe("audio");
  });

  it("classifies files by folder then extension", () => {
    expect(kindForFile(f("videos/x.mp4"))).toBe("video");
    expect(kindForFile(f("frames/x.jpg"))).toBe("image");
    expect(kindForFile(f("narrations/x.mp3"))).toBe("narration");
    expect(kindForFile(f("music/x.mp3"))).toBe("music");
    expect(kindForFile(f("loose.mp4"))).toBe("video");
    expect(kindForFile(f("loose.mp3"))).toBe("audio");
  });

  it("narration and music are not interchangeable, but audio bridges", () => {
    expect(kindsCompatible("narration", "audio")).toBe(true);
    expect(kindsCompatible("music", "audio")).toBe(true);
    expect(kindsCompatible("narration", "music")).toBe(false);
    expect(kindsCompatible("video", "image")).toBe(false);
  });
});

describe("url + filename helpers", () => {
  it("extracts filename + original from local-asset proxy urls", () => {
    const url = "/api/studio/local-asset?projectId=p&kind=video&filename=Scene-1-ABC.mp4&original=https://storage.googleapis.com/b/o.mp4";
    const h = parseUrlHints(url);
    expect(h.basename).toBe("scene-1-abc.mp4");
    expect(h.original).toBe("https://storage.googleapis.com/b/o.mp4");
  });
  it("falls back to path basename for plain urls", () => {
    expect(parseUrlHints("https://cdn.x/vo-abc.MP3").basename).toBe("vo-abc.mp3");
  });
  it("parses scene numbers and windows basenames", () => {
    expect(sceneFromFilename("scene-3-abc.mp4")).toBe(3);
    expect(sceneFromFilename("Scene_12-x.jpg")).toBe(12);
    expect(sceneFromFilename("random.mp4")).toBeNull();
    expect(baseNameOf("C:\\out\\voidspace-projects\\p\\videos\\scene-1.mp4")).toBe("scene-1.mp4");
  });
});

describe("buildRelinkPlan — manifest-driven (Voidspace scene media)", () => {
  // The exact shape that broke the old relink: scene items with NO
  // sourceFile, fileSize 0, only originalUrl/sceneNumber/role.
  const items: RelinkableItem[] = [
    { id: "media-video-doc1-asset111", name: "Scene 1 · Video", type: "video", sceneNumber: 1, role: "primary", category: "Scene Videos", originalUrl: "https://kie.tmp/expired-v1.mp4", fileSize: 0 },
    { id: "media-narration-doc1-asset222", name: "Scene 1 · Narration", type: "audio", sceneNumber: 1, role: "narration", category: "Narrations", originalUrl: "https://kie.tmp/expired-n1.mp3", fileSize: 0 },
    { id: "media-frame-doc1-asset333", name: "Scene 1 · Frame", type: "image", sceneNumber: 1, role: "first_frame", category: "Frames", originalUrl: "https://kie.tmp/expired-f1.jpg", fileSize: 0 },
  ];

  const files = [
    f("voidspace-projects/p/videos/scene-1-asset111.mp4"),
    f("voidspace-projects/p/narrations/scene-1-asset222.mp3"),
    f("voidspace-projects/p/frames/scene-1-first_frame-asset333.jpg"),
  ];

  it("matches via manifest scene+role even with expired urls and no sourceFile", () => {
    const manifests: ParsedManifest[] = [{
      project: "p",
      entries: [
        { kind: "video", sceneNumber: 1, role: "primary", assetId: "asset111", localPath: "x/videos/scene-1-asset111.mp4" },
        { kind: "narration", sceneNumber: 1, role: "narration", assetId: "asset222", localPath: "x/narrations/scene-1-asset222.mp3" },
        { kind: "image", sceneNumber: 1, role: "first_frame", assetId: "asset333", localPath: "x/frames/scene-1-first_frame-asset333.jpg" },
      ],
    }];
    const plan = buildRelinkPlan(items, files, manifests, { currentProjectId: "p" });
    expect(plan.unmatchedItemIds).toEqual([]);
    const byItem = new Map(plan.matches.map((m) => [m.itemId, m]));
    expect(byItem.get("media-video-doc1-asset111")!.file.name).toBe("scene-1-asset111.mp4");
    expect(byItem.get("media-narration-doc1-asset222")!.file.name).toBe("scene-1-asset222.mp3");
    expect(byItem.get("media-frame-doc1-asset333")!.file.name).toBe("scene-1-first_frame-asset333.jpg");
  });

  it("matches structurally WITHOUT a manifest (folder layout only)", () => {
    const plan = buildRelinkPlan(items, files, [], {});
    expect(plan.unmatchedItemIds).toEqual([]);
    const byItem = new Map(plan.matches.map((m) => [m.itemId, m]));
    // narration must land on the narrations file, not music
    expect(byItem.get("media-narration-doc1-asset222")!.file.parentDir).toBe("narrations");
  });

  it("does not cross narration onto a music track", () => {
    const narrOnly: RelinkableItem[] = [items[1]];
    const musicFiles = [f("voidspace-projects/p/music/bgm-x.mp3")];
    const plan = buildRelinkPlan(narrOnly, musicFiles, [], {});
    // narration vs music are incompatible → no false match
    expect(plan.matches).toEqual([]);
    expect(plan.unmatchedItemIds).toEqual(["media-narration-doc1-asset222"]);
  });
});

describe("native sourceFile hints (loader-stamped)", () => {
  // Mirrors the values voidspace-loader's deriveMirrorSourceFile stamps,
  // so the editor's native relink/restore treats scene media like imports.
  const items: RelinkableItem[] = [
    { id: "media-video-d-a", name: "Scene 1 · Video", type: "video", sceneNumber: 1, role: "primary", sourceFile: { name: "scene-1-primary.mp4", size: 3_000_000 } },
    { id: "media-narration-d-b", name: "Scene 1 · Narration", type: "audio", sceneNumber: 1, role: "narration", sourceFile: { name: "scene-1.mp3", size: 120_000 } },
    { id: "media-frame-d-c", name: "Scene 1 · Frame", type: "image", sceneNumber: 1, role: "first_frame", sourceFile: { name: "scene-1-first_frame.jpg", size: 50_000 } },
    { id: "media-music-d", name: "Background Music", type: "audio", role: "music", category: "Music", sourceFile: { name: "bgm.mp3", size: 900_000 } },
  ];

  it("matches the assetId-LESS disk form by name+size (re-mirror path)", () => {
    const files = [
      f("voidspace-projects/p/videos/scene-1-primary.mp4", 3_000_000),
      f("voidspace-projects/p/narrations/scene-1.mp3", 120_000),
      f("voidspace-projects/p/frames/scene-1-first_frame.jpg", 50_000),
      f("voidspace-projects/p/music/bgm.mp3", 900_000),
    ];
    const plan = buildRelinkPlan(items, files, [], {});
    expect(plan.unmatchedItemIds).toEqual([]);
    expect(plan.matches.every((m) => m.strategy === "sourceFile:nameSize")).toBe(true);
  });

  it("still matches the assetId disk form via structural scene fallback (generation path)", () => {
    const files = [
      f("voidspace-projects/p/videos/scene-1-primary-abc123.mp4", 9), // size differs
      f("voidspace-projects/p/narrations/scene-1-def456.mp3", 9),
      f("voidspace-projects/p/frames/scene-1-first_frame-ghi789.jpg", 9),
    ];
    const plan = buildRelinkPlan(items.slice(0, 3), files, [], {});
    expect(plan.unmatchedItemIds).toEqual([]);
    const byItem = new Map(plan.matches.map((m) => [m.itemId, m.file.parentDir]));
    expect(byItem.get("media-narration-d-b")).toBe("narrations");
    expect(byItem.get("media-frame-d-c")).toBe("frames");
  });
});

describe("buildRelinkPlan — user imports + contention", () => {
  it("matches user imports by name+size and prefers it over weaker signals", () => {
    const items: RelinkableItem[] = [
      { id: "u1", name: "clip.mp4", type: "video", sourceFile: { name: "clip.mp4", size: 2048 } },
    ];
    const files = [f("clip.mp4", 2048), f("videos/scene-1-clip.mp4", 999)];
    const plan = buildRelinkPlan(items, files, [], {});
    expect(plan.matches[0].file.size).toBe(2048);
    expect(plan.matches[0].strategy).toBe("sourceFile:nameSize");
  });

  it("never assigns one file to two items (greedy, highest confidence wins)", () => {
    const items: RelinkableItem[] = [
      { id: "a", name: "Scene 1 · Video", type: "video", sceneNumber: 1, originalUrl: "https://cdn/scene-1.mp4" },
      { id: "b", name: "Scene 1 · Video copy", type: "video", sceneNumber: 1 },
    ];
    const files = [f("videos/scene-1.mp4")];
    const plan = buildRelinkPlan(items, files, [], {});
    expect(plan.matches.length).toBe(1);
    // url-basename (a) outranks structural-scene (b)
    expect(plan.matches[0].itemId).toBe("a");
    expect(plan.unmatchedItemIds).toEqual(["b"]);
  });
});
