import { useEffect, useCallback, useRef, lazy, Suspense, useState } from "react";
import { ToastContainer } from "./components/Toast";
import { ScriptViewDialog } from "./components/editor/ScriptViewDialog";
import { SearchModal } from "./components/editor/SearchModal";
import { MobileBlocker } from "./components/MobileBlocker";
import { WelcomeScreen } from "./components/welcome";
import { SharePage } from "./pages/SharePage";
import { useUIStore } from "./stores/ui-store";
import { useProjectStore } from "./stores/project-store";
import { useEngineStore } from "./stores/engine-store";
import { useVoidspaceStore } from "./stores/voidspace-store";
import { useRouter } from "./hooks/use-router";
import { useKieAIPoller } from "./hooks/useKieAIPoller";
import { SOCIAL_MEDIA_PRESETS, type SocialMediaCategory } from "@openreel/core";
import { TooltipProvider } from "@openreel/ui";
import {
  waitForAuth,
  fetchSceneListContext,
  loadSceneListAsProject,
  subscribeSceneListAsProject,
} from "./services/voidspace-loader";
import { autoSaveManager } from "./services/auto-save";
import {
  buildLegacyVoidspaceProjectId,
  buildUserScopedVoidspaceProjectId,
  buildVoidspaceProjectId,
  parseVoidspaceProjectId,
} from "./services/voidspace-project-id";

const EditorInterface = lazy(() =>
  import("./components/editor/EditorInterface").then((m) => ({
    default: m.EditorInterface,
  }))
);

const LoadingSpinner: React.FC<{ message: string }> = ({ message }) => (
  <div className="h-screen w-screen bg-background flex flex-col items-center justify-center">
    <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3" />
    <p className="text-sm text-text-secondary">{message}</p>
  </div>
);

const PRESET_DIMENSIONS: Record<string, SocialMediaCategory> = {
  "1080x1920": "tiktok",
  "1920x1080": "youtube-video",
  "1080x1080": "instagram-post",
  "720x1280": "instagram-stories",
  "1280x720": "youtube-video",
};

/**
 * Single-flight wrapper around `loadSceneListAsProject`. The chat
 * fires `voidspace:reload` once per generated asset (coalesced behind
 * a 120 ms debounce on the chat side, but bursts can still arrive
 * here) AND the live Firestore subscription's debounced rebuild may
 * fire concurrently. Without single-flight, the editor would issue
 * 4-8 parallel `loadSceneListAsProject` calls per generated scene,
 * each fetching every blob over the network — wasteful and a source
 * of "everything works after a delay" stutters. We dedupe to the
 * latest in-flight promise so concurrent callers share the result.
 */
let _reloadInFlight: Promise<import("@openreel/core").Project> | null = null;
function reloadSingleFlight(
  userId: string,
  sceneListId: string,
): Promise<import("@openreel/core").Project> {
  if (_reloadInFlight) return _reloadInFlight;
  _reloadInFlight = loadSceneListAsProject(userId, sceneListId).finally(() => {
    _reloadInFlight = null;
  });
  return _reloadInFlight;
}

/**
 * Additive merge of a Firestore-derived `fresh` Project into the
 * editor's current store state. Single source of truth for every
 * chat → editor sync: the live subscription's tick callback AND the
 * `voidspace:reload` postMessage handler both go through this so the
 * two paths can never diverge.
 *
 * Semantics:
 *   - Append media items / track clips / text clips that the editor
 *     doesn't have yet (deduped by stable id from voidspace-loader).
 *   - Upgrade existing media items whose blob/originalUrl is missing
 *     by overlaying the fresh fields — this hydrates blob-less items
 *     surviving from autosave recovery without losing user edits.
 *   - Append entirely new tracks (e.g. captions track on first use).
 *   - Adopt fresh canvas settings only when the recovered/current
 *     dims drift from the chat's authoritative dims (the URL aspect
 *     param is the chat's contract).
 *   - Re-sync the title-engine on every dirty merge so caption
 *     repaints are guaranteed.
 *   - Invalidate cached audio buffers for upgraded media so the
 *     playback path re-decodes with the freshly-hydrated blob.
 *
 * Returns `{ dirty, newMedia, upgraded, newClips, newCaptions }` for
 * logging — every tick prints exactly what changed.
 */
function applyAdditiveMerge(fresh: import("@openreel/core").Project): {
  dirty: boolean;
  newMedia: number;
  upgraded: number;
  newClips: number;
  newCaptions: number;
} {
  const store = useProjectStore.getState();
  const current = store.project;

  const currentMediaById = new Map(
    current.mediaLibrary.items.map((m) => [m.id, m] as const),
  );
  const newMedia: import("@openreel/core").MediaItem[] = [];
  const upgradedMediaById = new Map<
    string,
    import("@openreel/core").MediaItem
  >();
  for (const fr of fresh.mediaLibrary.items) {
    const existing = currentMediaById.get(fr.id);
    if (!existing) {
      newMedia.push(fr);
      continue;
    }
    const existingHasBlob = existing.blob instanceof Blob;
    const freshHasBlob = fr.blob instanceof Blob;
    const existingHasUrl = Boolean(existing.originalUrl);
    const freshHasUrl = Boolean(fr.originalUrl);
    if (
      (!existingHasBlob && freshHasBlob) ||
      (!existingHasUrl && freshHasUrl)
    ) {
      upgradedMediaById.set(fr.id, {
        ...existing,
        blob: freshHasBlob ? fr.blob : existing.blob,
        originalUrl: freshHasUrl ? fr.originalUrl : existing.originalUrl,
        thumbnailUrl: existing.thumbnailUrl ?? fr.thumbnailUrl,
        metadata: existing.metadata ?? fr.metadata,
      });
    }
  }

  const knownTextClipIds = new Set(
    (current.textClips ?? []).map((t) => t.id),
  );
  const newTextClips = (fresh.textClips ?? []).filter(
    (t) => !knownTextClipIds.has(t.id),
  );

  const knownClipIds = new Set<string>();
  const currentClipById = new Map<string, import("@openreel/core").Clip>();
  for (const tr of current.timeline.tracks) {
    for (const c of tr.clips) {
      knownClipIds.add(c.id);
      currentClipById.set(c.id, c);
    }
  }
  const trackPatches = new Map<
    string,
    import("@openreel/core").Clip[]
  >();
  // Detect clips that already exist but now reference a different media item
  // (e.g. narration/video replaced on timeline after regen-approve). The
  // additive path only adds new clips — without this, the clip keeps pointing
  // at the old mediaId even though Firestore has a newer narration_url.
  const updatedClips = new Map<string, import("@openreel/core").Clip>();
  for (const tr of fresh.timeline.tracks) {
    const adds = tr.clips.filter((c) => !knownClipIds.has(c.id));
    if (adds.length > 0) trackPatches.set(tr.id, adds);
    for (const freshClip of tr.clips) {
      const existing = currentClipById.get(freshClip.id);
      if (existing && existing.mediaId !== freshClip.mediaId) {
        updatedClips.set(freshClip.id, freshClip);
      }
    }
  }

  const newClipsCount = [...trackPatches.values()].reduce(
    (n, a) => n + a.length,
    0,
  );
  const dirty =
    newMedia.length > 0 ||
    upgradedMediaById.size > 0 ||
    newTextClips.length > 0 ||
    trackPatches.size > 0 ||
    updatedClips.size > 0;

  if (!dirty) {
    return {
      dirty: false,
      newMedia: 0,
      upgraded: 0,
      newClips: 0,
      newCaptions: 0,
    };
  }

  const mergedTracks = current.timeline.tracks.map((tr) => {
    const adds = trackPatches.get(tr.id);
    const replaced = tr.clips.map((c) => updatedClips.get(c.id) ?? c);
    return adds ? { ...tr, clips: [...replaced, ...adds] } : { ...tr, clips: replaced };
  });
  const knownTrackIds = new Set(mergedTracks.map((t) => t.id));
  for (const tr of fresh.timeline.tracks) {
    if (!knownTrackIds.has(tr.id)) mergedTracks.push(tr);
  }

  const mergedMediaItems = current.mediaLibrary.items.map(
    (m) => upgradedMediaById.get(m.id) ?? m,
  );

  // Adopt fresh settings if dims drift. Voidspace-loader honors the
  // URL `aspect` param which is the chat's authoritative contract.
  const adoptFreshSettings =
    fresh.settings &&
    ((current.settings?.width ?? 0) !== fresh.settings.width ||
      (current.settings?.height ?? 0) !== fresh.settings.height);

  useProjectStore.setState({
    project: {
      ...current,
      settings: adoptFreshSettings
        ? { ...current.settings, ...fresh.settings }
        : current.settings,
      mediaLibrary: { items: [...mergedMediaItems, ...newMedia] },
      timeline: { ...current.timeline, tracks: mergedTracks },
      textClips: [...(current.textClips ?? []), ...newTextClips],
      modifiedAt: fresh.modifiedAt,
    },
  });

  if (upgradedMediaById.size > 0 || updatedClips.size > 0) {
    const playbackController = useEngineStore
      .getState()
      .getPlaybackController();
    // Invalidate upgraded media AND the OLD media IDs whose clips were
    // replaced — clearing the stale audio buffer forces the engine to
    // decode the new narration blob on next playback.
    const toInvalidate = [
      ...upgradedMediaById.keys(),
      ...[...updatedClips.keys()].map((clipId) => currentClipById.get(clipId)!.mediaId),
    ];
    playbackController?.invalidateAudioForMedia(toInvalidate[Symbol.iterator]());
  }

  const liveTitleEngine = useEngineStore.getState().getTitleEngine();
  if (liveTitleEngine) {
    liveTitleEngine.loadTextClips([
      ...(current.textClips ?? []),
      ...newTextClips,
    ]);
  }

  return {
    dirty: true,
    newMedia: newMedia.length,
    upgraded: upgradedMediaById.size,
    newClips: newClipsCount,
    newCaptions: newTextClips.length,
  };
}

function App() {
  const { activeModal, closeModal } = useUIStore();
  const { openModal: openSearchModal } = useUIStore();
  const createNewProject = useProjectStore((state) => state.createNewProject);
  const loadProject = useProjectStore((state) => state.loadProject);
  const importMedia = useProjectStore((state) => state.importMedia);
  const addClipToNewTrack = useProjectStore((state) => state.addClipToNewTrack);
  const forceSave = useProjectStore((state) => state.forceSave);
  const [voidspaceLoading, setVoidspaceLoading] = useState(() => {
    const sp = new URLSearchParams(window.location.search);
    return sp.has("sceneListId") || sp.has("import");
  });
  const [voidspaceError, setVoidspaceError] = useState<string | null>(null);
  const hasHandledImport = useRef(false);

  const { route, params, navigate, parsedDimensions, fps } = useRouter();
  const hasHandledInitialRoute = useRef(false);
  const hasHandledVoidspace = useRef(false);

  // ── Voidspace auto-load: detect sceneListId in parent URL search params ──
  useEffect(() => {
    if (hasHandledVoidspace.current) return;

    const searchParams = new URLSearchParams(window.location.search);
    const sceneListId = searchParams.get("sceneListId");

    if (!sceneListId) return;

    hasHandledVoidspace.current = true;
    setVoidspaceLoading(true);

    (async () => {
      // Marker flipped on once we've successfully restored a project
      // from IndexedDB. The Firestore subscription below uses it to
      // pick its merge strategy (additive vs wholesale-replace).
      let recoveredFromLocal = false;
      try {
        const userId = await waitForAuth(10000);
        if (!userId) {
          console.error("[Voidspace] No authenticated user");
          setVoidspaceError("Not signed in. Please sign in and try again.");
          setVoidspaceLoading(false);
          return;
        }

        // Refresh scene list metadata first so we can scope local cache by avatar.
        try {
          await fetchSceneListContext(userId, sceneListId);
        } catch (contextErr) {
          console.warn("[Voidspace] Failed to preload scene list context:", contextErr);
        }

        const avatarId = useVoidspaceStore.getState().sceneList?.avatarId;

        // Check for a locally saved copy first (edited in Studio previously).
        // New key is scoped by user + avatar + sceneList to avoid cross-avatar collisions.
        const localProjectId = buildVoidspaceProjectId(userId, sceneListId, avatarId);
        const userScopedLegacyProjectId = buildUserScopedVoidspaceProjectId(userId, sceneListId);
        const legacyLocalProjectId = buildLegacyVoidspaceProjectId(sceneListId);
        await autoSaveManager.initialize();

        const saveCandidates = (
          await Promise.all([
            autoSaveManager.getMostRecentSave(localProjectId),
            autoSaveManager.getMostRecentSave(userScopedLegacyProjectId),
            autoSaveManager.getMostRecentSave(legacyLocalProjectId),
          ])
        ).filter((s): s is NonNullable<typeof s> => Boolean(s));

        const localSave = saveCandidates
          .sort((a, b) => b.timestamp - a.timestamp)[0] || null;

        if (localSave) {
          console.log(`[Voidspace] Found local copy for ${sceneListId}, recovering...`);
          const recovered = await useProjectStore.getState().recoverFromAutoSave(localSave.id);
          if (recovered) {
            // Strip *broken* legacy caption TextClips from older saves
            // (transform.position {x:0,y:0} → ghost-rendered at the
            // canvas top-left corner). Voidspace now emits caption
            // TextClips with a proper bottom-center transform, so we
            // keep those and only filter out the stale corner ones.
            // Also drop `timeline.subtitles` left over from when
            // captions were drawn via the subtitle-canvas-renderer —
            // those are no longer used and would double-render on top
            // of the new TextClips if anything started honoring them.
            const titleEngine = useEngineStore.getState().getTitleEngine();
            try {
              const cur = useProjectStore.getState().project;
              const isBrokenCaption = (tc: import("@openreel/core").TextClip) =>
                tc.trackId === "track-captions" &&
                (tc.transform?.position?.y ?? 0) < 0.1;
              const cleanTextClips = (cur.textClips ?? []).filter(
                (tc) => !isBrokenCaption(tc),
              );
              const hadStaleSubtitles = (cur.timeline.subtitles ?? []).length > 0;
              if (
                cleanTextClips.length !== (cur.textClips?.length ?? 0) ||
                hadStaleSubtitles
              ) {
                useProjectStore.setState({
                  project: {
                    ...cur,
                    timeline: { ...cur.timeline, subtitles: [] },
                    textClips: cleanTextClips,
                  },
                });
              }
              if (titleEngine) {
                titleEngine.loadTextClips(cleanTextClips);
              }
            } catch {
              /* best-effort scrub */
            }

            // Belt-and-suspenders blob: scrub. Old autosaves written
            // before the dedicated sanitizer in auto-save.ts was added
            // can still carry stale `blob:http://localhost:.../<uuid>`
            // references that produce `net::ERR_FILE_NOT_FOUND` at
            // render time. Strip them here so the renderer's hydration
            // path picks up `originalUrl` instead, which is what the
            // user observes as "works after refresh."
            try {
              const cur = useProjectStore.getState().project;
              const isDeadBlob = (v: unknown): v is string =>
                typeof v === "string" && v.startsWith("blob:");
              let mutated = false;
              const cleanedItems = cur.mediaLibrary.items.map((item) => {
                const dirtyThumb = isDeadBlob(item.thumbnailUrl);
                const dirtyFilmstrip = Array.isArray(item.filmstripThumbnails)
                  && item.filmstripThumbnails.some(
                    (f: any) => isDeadBlob(f?.url),
                  );
                if (!dirtyThumb && !dirtyFilmstrip) return item;
                mutated = true;
                return {
                  ...item,
                  thumbnailUrl: dirtyThumb
                    ? item.originalUrl ?? null
                    : item.thumbnailUrl,
                  filmstripThumbnails: dirtyFilmstrip
                    ? undefined
                    : item.filmstripThumbnails,
                };
              });
              if (mutated) {
                useProjectStore.setState({
                  project: {
                    ...cur,
                    mediaLibrary: { ...cur.mediaLibrary, items: cleanedItems },
                  },
                });
                console.log(
                  "[Voidspace] Stripped stale blob: URLs from recovered project; renderer will hydrate from originalUrl.",
                );
              }
            } catch {
              /* best-effort scrub */
            }

            const recoveredProject = useProjectStore.getState().project;
            const recoveredMusicTrack = recoveredProject.timeline.tracks.find(
              (track) => track.id === "track-music",
            );
            const recoveredLooksStale =
              Boolean(recoveredMusicTrack) &&
              recoveredMusicTrack!.clips.length > 0 &&
              recoveredMusicTrack!.clips.every(
                (clip) => Math.abs(clip.inPoint ?? 0) < 0.0001,
              );

            // Two reasons to immediately re-fetch from Firestore here:
            //   1. The recovered music track has no per-scene offsets
            //      (legacy save predates the timing rewrite).
            //   2. ANY recovered media item is missing a blob — which
            //      is the common case after JSON-roundtrip recovery and
            //      causes the renderer to spend its first ~250ms (until
            //      the live-subscription tick) trying to play
            //      blob:/originalUrl pointers that may be dead. The
            //      live subscription will catch this eventually but
            //      "wait until then" is what the user observes as
            //      "doesn't work until I refresh."
            const recoveredHasMissingBlobs =
              recoveredProject.mediaLibrary.items.some(
                (m) => !(m.blob instanceof Blob) && Boolean(m.originalUrl),
              );
            if (recoveredLooksStale || recoveredHasMissingBlobs) {
              try {
                const refreshedProject = await loadSceneListAsProject(userId, sceneListId);
                const refreshedMusicTrack = refreshedProject.timeline.tracks.find(
                  (track) => track.id === "track-music",
                );
                const refreshedHasOffsets =
                  Boolean(refreshedMusicTrack) &&
                  refreshedMusicTrack!.clips.some(
                    (clip) => (clip.inPoint ?? 0) > 0.0001,
                  );

                if (recoveredLooksStale && refreshedHasOffsets) {
                  // Full replace — music timing was the issue, take
                  // the freshly-built project as the new baseline.
                  loadProject(refreshedProject);
                  await forceSave();
                  console.log(
                    "[Voidspace] Replaced stale local cache with refreshed scene timing.",
                  );
                } else if (recoveredHasMissingBlobs) {
                  // Surgical upgrade — preserve the user's recovered
                  // edits (selection, transforms, etc.) but overlay
                  // each item's freshly-fetched blob/originalUrl so
                  // the renderer can paint immediately. Mirrors the
                  // additive-merge upgrade path the live subscription
                  // runs, just executed eagerly here.
                  const cur = useProjectStore.getState().project;
                  const freshById = new Map(
                    refreshedProject.mediaLibrary.items.map((m) => [m.id, m]),
                  );
                  const upgraded = cur.mediaLibrary.items.map((existing) => {
                    const fresh = freshById.get(existing.id);
                    if (!fresh) return existing;
                    const existingHasBlob = existing.blob instanceof Blob;
                    const freshHasBlob = fresh.blob instanceof Blob;
                    if (existingHasBlob || !freshHasBlob) {
                      // Fresh-only fields that don't depend on blob.
                      return {
                        ...existing,
                        originalUrl: fresh.originalUrl ?? existing.originalUrl,
                      };
                    }
                    return {
                      ...existing,
                      blob: fresh.blob,
                      originalUrl: fresh.originalUrl ?? existing.originalUrl,
                      thumbnailUrl: existing.thumbnailUrl ?? fresh.thumbnailUrl,
                      metadata: existing.metadata ?? fresh.metadata,
                    };
                  });
                  useProjectStore.setState({
                    project: {
                      ...cur,
                      mediaLibrary: { ...cur.mediaLibrary, items: upgraded },
                    },
                  });
                  console.log(
                    `[Voidspace] Eager-hydrated ${upgraded.filter((m) => m.blob instanceof Blob).length}/${upgraded.length} media blobs after recovery.`,
                  );
                }
              } catch (refreshErr) {
                console.warn("[Voidspace] Failed to refresh stale local cache:", refreshErr);
              }
            }

            if (
              localSave.projectId === legacyLocalProjectId ||
              localSave.projectId === userScopedLegacyProjectId
            ) {
              const currentProject = useProjectStore.getState().project;
              if (
                currentProject.id === legacyLocalProjectId ||
                currentProject.id === userScopedLegacyProjectId
              ) {
                loadProject({
                  ...currentProject,
                  id: localProjectId,
                  modifiedAt: Date.now(),
                });
                await forceSave();
                console.log(
                  `[Voidspace] Migrated local project id to scoped key: ${localProjectId}`,
                );
              }
            }
            try {
              await fetchSceneListContext(userId, sceneListId);
            } catch (contextErr) {
              console.warn("[Voidspace] Failed to refresh scene list context:", contextErr);
            }

            // Force the canvas dimensions to honor the iframe URL's
            // `aspect=` param even when recovery loaded settings from
            // a stale local save. The studio-ai page mints the iframe
            // with the user's CURRENT aspect choice; recovered settings
            // come from whatever the project was when autosave last
            // fired. Without this override, the editor reverts to its
            // own default (1920x1080) on every reopen of a 9:16 / 1:1
            // project. The additive-merge path below preserves user
            // edits but doesn't touch `settings`, so we patch it here
            // once at recovery time.
            try {
              const sp = new URLSearchParams(window.location.search);
              const urlAspect = sp.get("aspect");
              const ASPECT_DIMS: Record<string, { width: number; height: number }> = {
                "16:9": { width: 1920, height: 1080 },
                "9:16": { width: 1080, height: 1920 },
                "1:1":  { width: 1080, height: 1080 },
                "4:3":  { width: 1440, height: 1080 },
                "3:4":  { width: 1080, height: 1440 },
                "21:9": { width: 2560, height: 1080 },
              };
              const dim = urlAspect ? ASPECT_DIMS[urlAspect] : null;
              if (dim) {
                const cur = useProjectStore.getState().project;
                const drift =
                  (cur.settings?.width ?? 0) !== dim.width ||
                  (cur.settings?.height ?? 0) !== dim.height;
                if (drift) {
                  useProjectStore.setState({
                    project: {
                      ...cur,
                      settings: {
                        ...cur.settings,
                        width: dim.width,
                        height: dim.height,
                      },
                    },
                  });
                  console.log(
                    `[Voidspace] Aspect override from URL: ${urlAspect} → ${dim.width}x${dim.height} (was ${cur.settings?.width}x${cur.settings?.height})`,
                  );
                }
              }
            } catch (aspectErr) {
              console.warn("[Voidspace] Aspect override failed:", aspectErr);
            }

            navigate("editor");
            console.log(`[Voidspace] Restored local project: ${localSave.projectName}`);
            setVoidspaceLoading(false);
            // ⚠️  DO NOT return — fall through and install the live
            // Firestore subscription below in additive-only mode. The
            // chat keeps writing assets to Firestore after this iframe
            // mounts; without a subscription the editor would freeze on
            // the IndexedDB snapshot and new clips would never land,
            // which is exactly what produced the "Timeline is empty"
            // export error. `recoveredFromLocal` flips the snapshot
            // callback into additive-merge mode so the recovered project
            // (and any user edits already in flight) survive the merge.
            recoveredFromLocal = true;
          } else {
            console.warn("[Voidspace] Local recovery failed, falling back to Firestore import");
          }
        }

        // Always install the Firestore live subscription. Studio chat
        // upserts assets one-by-one as the user approves each step
        // (frame → voiceover → clip → render); without the subscription
        // the editor would only see the snapshot at mount time, so the
        // timeline would never refresh and users would have to reload
        // to see the next clip land. The subscription coalesces bursts
        // and re-runs `loadSceneListAsProject` on every Firestore write
        // so tracks fill in real time.
        //
        //   - On a clean mount: `firstLoad=true` → first snapshot wins,
        //     subsequent ticks merge or replace based on user edits.
        //   - After a local-save recovery: `firstLoad=false` from the
        //     start so the recovered project is the baseline; every
        //     snapshot tick goes through the additive merge path below.
        console.log(
          `[Voidspace] Loading scene list: ${sceneListId} (live${recoveredFromLocal ? ", post-recovery additive" : ""})`,
        );
        let firstLoad = !recoveredFromLocal;
        let tickCount = 0;
        const unsubscribe = subscribeSceneListAsProject(
          userId,
          sceneListId,
          (project) => {
            tickCount++;
            // Always-on summary so chat → editor coupling is observable
            // from the DevTools console without needing to attach to
            // each Firestore listener manually. Format mirrors the
            // merge-result line below so a "tick fired but no merge"
            // case is visually distinct.
            console.log(
              `[Voidspace tick #${tickCount}] fresh: ${project.mediaLibrary.items.length} media, ${(project.textClips ?? []).length} captions, ${project.timeline.tracks.reduce((n, t) => n + t.clips.length, 0)} clips`,
            );
            if (firstLoad) {
              firstLoad = false;
              loadProject(project);
              navigate("editor");
              console.log(
                `[Voidspace] Loaded project: ${project.name} (${project.mediaLibrary.items.length} media items)`,
              );
              return;
            }
            // Subsequent live update — single path: additive merge.
            // The previous wholesale-replace branch (when canUndo()
            // was false AND no recovery) raced against any user
            // mid-edit and against the chat's `pingEditor` which also
            // reloaded. One code path here means the editor's
            // behaviour for chat-driven assets is deterministic:
            // append what's new, upgrade what's blob-less, never
            // wipe what already exists. User-edit preservation comes
            // for free because we never overwrite existing items.
            const result = applyAdditiveMerge(project);
            if (result.dirty) {
              console.log(
                `[Voidspace tick #${tickCount}] merged: +${result.newMedia} media, ↑${result.upgraded} hydrated, +${result.newCaptions} captions, +${result.newClips} clips`,
              );
            } else {
              // Quiet no-op — useful to confirm the subscription is
              // actually firing even when nothing changed.
              console.log(`[Voidspace tick #${tickCount}] merged: no-op (already up-to-date)`);
            }
          },
          (err) => {
            console.warn("[Voidspace] Live subscription error:", err);
          },
        );
        // Tear down the subscription when the iframe unloads. Only
        // attached to the outer cleanup path, not the early returns,
        // because each early return already exits without registering.
        if (typeof window !== "undefined") {
          window.addEventListener("beforeunload", unsubscribe, { once: true });
        }
      } catch (err) {
        console.error("[Voidspace] Failed to load scene list:", err);
        setVoidspaceError(
          err instanceof Error ? err.message : "Failed to load project",
        );
      } finally {
        setVoidspaceLoading(false);
      }
    })();
  }, [forceSave, loadProject, navigate]);

  useKieAIPoller();

  // ── Theme sync from parent (Voidspace website top-bar toggle) ──
  //
  // When the editor is embedded in the studio-ai page, the website's
  // light/dark toggle is the single source of truth. Two channels:
  //   1. ?theme=light|dark URL param on initial mount
  //   2. window.postMessage({type:'voidspace:theme', mode}) on changes
  // Both feed useThemeStore.setMode so the editor flips in lockstep
  // with the parent. The internal Sun/Moon toggle was removed in the
  // toolbar, leaving the parent as the only knob.
  useEffect(() => {
    const applyMode = (mode: string | null | undefined) => {
      if (mode !== "light" && mode !== "dark" && mode !== "system") return;
      try {
        // Lazy-import to keep the theme store out of the boot critical
        // path; the app already mounts ThemeProvider elsewhere.
        import("./stores/theme-store").then(({ useThemeStore }) => {
          useThemeStore.getState().setMode(mode as any);
        }).catch(() => { /* ignore */ });
      } catch { /* ignore */ }
    };
    try {
      const params = new URLSearchParams(window.location.search);
      applyMode(params.get("theme"));
    } catch { /* ignore */ }
    const onMessage = (e: MessageEvent) => {
      const msg: any = e?.data;
      if (!msg || msg.type !== "voidspace:theme") return;
      applyMode(msg.mode);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // ── Voidspace chat ↔ editor RPC bridge (postMessage) ──
  //
  // The chat parent window can read and minimally control the editor
  // through window.postMessage. This is the only programmatic surface
  // the studio agent has for inspecting timeline state ("what's on the
  // narration track?") and triggering a reload after a Firestore write
  // it knows the live subscription will eventually catch up to (kept
  // for redundancy).
  //
  // Inbound message shapes (from chat parent):
  //   { type: 'voidspace:get-state',  requestId }
  //   { type: 'voidspace:reload',     requestId? }
  //   { type: 'voidspace:play',       requestId? }
  //   { type: 'voidspace:pause',      requestId? }
  //   { type: 'voidspace:seek',       sec, requestId? }
  //
  // Outbound replies post back to event.source as:
  //   { type: 'voidspace:state',      requestId, state }
  //   { type: 'voidspace:ack',        requestId, op }
  //   { type: 'voidspace:error',      requestId, error }
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const msg = e?.data;
      if (!msg || typeof msg !== "object") return;
      const t = String(msg.type || "");
      if (!t.startsWith("voidspace:")) return;
      const reply = (payload: any) => {
        try { (e.source as Window | null)?.postMessage(payload, "*"); }
        catch { /* parent window gone */ }
      };
      try {
        switch (t) {
          case "voidspace:get-state": {
            const proj = useProjectStore.getState().project;
            // Read text clips from the LIVE title engine when populated;
            // fall back to the Zustand `proj.textClips` snapshot when the
            // engine is initialized-but-empty (Firestore data has loaded
            // into the project doc but `loadTextClips()` hasn't fired yet,
            // which happens during the first few hundred ms after page
            // mount). `??` doesn't help here because `[]` is non-nullish —
            // we have to length-check explicitly.
            const titleEng = useEngineStore.getState().getTitleEngine();
            const engineClips = titleEng?.getAllTextClips() ?? [];
            const liveTextClips = engineClips.length > 0
              ? engineClips
              : (proj.textClips ?? []);
            // Permanent diagnostic — surfaces the source-of-truth discrepancy
            // when text clips visibly render on the timeline but the agent
            // gets 0. Grep `[Voidspace get-state]` in the editor console.
            console.log('[Voidspace get-state]', {
              projectId: proj.id,
              mediaTracksCount: (proj.timeline?.tracks ?? []).length,
              mediaTrackIds: (proj.timeline?.tracks ?? []).map((t: any) => t.id),
              engineClipsCount: engineClips.length,
              snapshotTextClipsCount: (proj.textClips ?? []).length,
              engineRef: titleEng ? 'present' : 'NULL',
            });

            const trackInfer = (tr: any): string => {
              const id = String(tr?.id || '').toLowerCase();
              const name = String(tr?.name || '').toLowerCase();
              const haystack = `${id} ${name}`;
              if (/captions?|subtitle|text/.test(haystack)) return 'captions';
              if (/music|bgm|score/.test(haystack)) return 'music';
              if (/narration|voice|vo|dialogue/.test(haystack)) return 'narration';
              if (/sfx|sound[\s_-]?effect/.test(haystack)) return 'sfx';
              return 'video';
            };
            // Media tracks: video, narration, music. The "track-captions"
            // entry in timeline.tracks has empty clips[] (text clips live
            // in the title engine, not here) — skip it so we don't emit
            // an empty captions track on top of the real one below.
            const mediaTracks = (proj.timeline?.tracks ?? [])
              .filter((tr) => trackInfer(tr) !== 'captions')
              .map((tr) => ({
                id: tr.id,
                name: tr.name,
                kind: trackInfer(tr),
                clips: (tr.clips ?? []).map((c: any) => ({
                  id: c.id, mediaId: c.mediaId, startTime: c.startTime, duration: c.duration,
                  inPoint: c.inPoint, outPoint: c.outPoint,
                  volume: c.volume, muted: c.muted,
                })),
              }));
            // Bucket live text clips into a single captions track.
            // All Voidspace caption clips share trackId "track-captions".
            const captionClips = liveTextClips.map((tc: any) => ({
              id: tc.id,
              kind: 'text' as const,
              trackId: tc.trackId ?? 'track-captions',
              startTime: tc.startTime,
              duration: tc.duration,
              endTime: tc.startTime + tc.duration,
              text: typeof tc.text === 'string' ? tc.text.slice(0, 200) : '',
            }));
            const captionTracks = captionClips.length > 0
              ? [{ id: 'track-captions', name: 'Captions', kind: 'captions' as const, clips: captionClips }]
              : [];
            reply({
              type: "voidspace:state",
              requestId: msg.requestId,
              state: {
                id: proj.id,
                name: proj.name,
                settings: proj.settings,
                duration: proj.timeline?.duration ?? 0,
                tracks: [...mediaTracks, ...captionTracks],
                mediaCount: proj.mediaLibrary?.items?.length ?? 0,
                textClipCount: captionClips.length,
              },
            });
            break;
          }
          case "voidspace:set-aspect": {
            // Live aspect change from the chat — resize the canvas
            // in-place without an iframe navigation. The chat's
            // settings popup updates `currentAspect` and pushes the
            // new value here; we patch `project.settings.{width,height}`
            // and let the renderer pick up the new dims on the next
            // frame. Avoids the recovery-branch round-trip that would
            // otherwise lose in-flight chat-generated assets.
            const aspect = String(msg.aspect || "").trim();
            const ASPECT_DIMS: Record<string, { width: number; height: number }> = {
              "16:9": { width: 1920, height: 1080 },
              "9:16": { width: 1080, height: 1920 },
              "1:1":  { width: 1080, height: 1080 },
              "4:3":  { width: 1440, height: 1080 },
              "3:4":  { width: 1080, height: 1440 },
              "21:9": { width: 2560, height: 1080 },
            };
            const dim = ASPECT_DIMS[aspect];
            if (!dim) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: `unknown aspect: ${aspect}` });
              break;
            }
            const cur = useProjectStore.getState().project;
            if (
              (cur.settings?.width ?? 0) !== dim.width ||
              (cur.settings?.height ?? 0) !== dim.height
            ) {
              useProjectStore.setState({
                project: {
                  ...cur,
                  settings: { ...cur.settings, width: dim.width, height: dim.height },
                },
              });
              console.log(
                `[Voidspace set-aspect] ${aspect} → ${dim.width}x${dim.height} (was ${cur.settings?.width}x${cur.settings?.height})`,
              );
            }
            reply({ type: "voidspace:ack", requestId: msg.requestId, op: "set-aspect" });
            break;
          }
          case "voidspace:reload": {
            // Chat's "I just wrote a new asset, please refresh" nudge.
            // Coalesced + single-flight — concurrent reload requests
            // (chat may burst-fire one per write) reuse the in-flight
            // loadSceneListAsProject promise and re-merge against the
            // same fresh data, eliminating duplicate network traffic.
            //
            // CRITICAL: this used to call `loadProject(fresh)` which
            // wholesale-replaced `mediaLibrary` / `timeline` /
            // `textClips`. That raced against any user mid-edit AND
            // against the live subscription which was also firing
            // for the same write — sometimes wiping fresh content
            // the subscription had just merged in. Now both paths
            // funnel through `applyAdditiveMerge` so the chat nudge
            // can never destroy editor state, only add to it.
            const sp = new URLSearchParams(window.location.search);
            const sceneListId = sp.get("sceneListId");
            const projectId = useProjectStore.getState().project?.id;
            const parsed = projectId ? parseVoidspaceProjectId(projectId) : null;
            const userId = parsed?.userId ?? null;
            if (!sceneListId || !userId) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "no sceneListId in URL" });
              break;
            }
            try {
              const fresh = await reloadSingleFlight(userId, sceneListId);
              const result = applyAdditiveMerge(fresh);
              console.log(
                `[Voidspace reload-ping] merged: +${result.newMedia} media, ↑${result.upgraded} hydrated, +${result.newCaptions} captions, +${result.newClips} clips`,
              );
              reply({ type: "voidspace:ack", requestId: msg.requestId, op: "reload" });
            } catch (err) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: String((err as any)?.message ?? err) });
            }
            break;
          }
          // ── Voidspace agent — clip & media RPCs ──
          // The studio agent uses these to read the media library and
          // surgically mutate clips on tracks (crop in/out, move, swap
          // duration, change volume, mute, add/remove). All four hook
          // into the project store's existing action executor or do a
          // direct property update + project re-set so undo/redo and the
          // canvas renderer pick up the change in the same tick.
          case "voidspace:list-media": {
            const proj = useProjectStore.getState().project;
            const items = (proj.mediaLibrary?.items ?? []).map((m: any) => ({
              id: m.id,
              name: m.name ?? null,
              kind: m.type ?? m.kind ?? null,
              url: m.url ?? m.src ?? null,
              duration: m.duration ?? null,
              width: m.width ?? null,
              height: m.height ?? null,
              hasAudio: m.hasAudio ?? null,
            }));
            reply({ type: "voidspace:media", requestId: msg.requestId, items });
            break;
          }
          case "voidspace:patch-clip": {
            const { clipId, patch } = msg as any;
            if (!clipId || !patch || typeof patch !== "object") {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "clipId + patch required" });
              break;
            }
            const store = useProjectStore.getState();
            const proj = store.project;

            // Check if this is a text clip (caption). Text clips live in
            // the title engine, not in timeline.tracks — they need a
            // different update path.
            const titleEngPatch = useEngineStore.getState().getTitleEngine();
            const textClip = titleEngPatch?.getTextClip(clipId);
            if (textClip) {
              const updates: Record<string, unknown> = {};
              if (typeof patch.startTime === "number") updates.startTime = patch.startTime;
              if (typeof patch.duration === "number") updates.duration = Math.max(0.05, patch.duration);
              const updated = titleEngPatch!.updateTextClip(clipId, updates);
              useProjectStore.setState({ project: { ...proj, modifiedAt: Date.now() } });
              reply({
                type: "voidspace:clip-patched",
                requestId: msg.requestId,
                clip: updated ?? null,
                ok: !!updated,
              });
              break;
            }

            // Media clip path: locate clip + track by walking the timeline.
            let foundClip: any = null;
            let foundTrackId: string | null = null;
            for (const tr of proj.timeline?.tracks ?? []) {
              const c = (tr.clips ?? []).find((cc: any) => cc.id === clipId);
              if (c) { foundClip = c; foundTrackId = tr.id; break; }
            }
            if (!foundClip) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: `no clip with id ${clipId}` });
              break;
            }
            const errors: string[] = [];
            if (typeof patch.startTime === "number") {
              const r = await store.moveClip(clipId, patch.startTime, foundTrackId ?? undefined);
              if (!r.success) errors.push(`moveClip: ${r.error ?? "failed"}`);
            }
            if (typeof patch.inPoint === "number" || typeof patch.outPoint === "number") {
              const r = await store.trimClip(
                clipId,
                typeof patch.inPoint === "number" ? patch.inPoint : undefined,
                typeof patch.outPoint === "number" ? patch.outPoint : undefined,
              );
              if (!r.success) errors.push(`trimClip: ${r.error ?? "failed"}`);
            }
            if (typeof patch.duration === "number") {
              const inP = typeof patch.inPoint === "number" ? patch.inPoint : (foundClip.inPoint ?? 0);
              const r = await store.trimClip(clipId, inP, inP + patch.duration);
              if (!r.success) errors.push(`trimClip(duration): ${r.error ?? "failed"}`);
            }
            if (typeof patch.volume === "number") {
              const volStore = useProjectStore.getState() as any;
              const volAction = {
                type: "audio/setVolume" as const,
                id: `vol-${Date.now().toString(36)}`,
                timestamp: Date.now(),
                params: { clipId, volume: Math.max(0, Math.min(4, patch.volume)) },
              };
              const vr = await volStore.actionExecutor.execute(volAction, volStore.project);
              if (vr.success) {
                useProjectStore.setState({ project: { ...volStore.project, modifiedAt: Date.now() } });
              } else {
                errors.push(`setVolume: ${vr.error?.message ?? "failed"}`);
              }
            }
            if (typeof patch.muted === "boolean") {
              const mutStore = useProjectStore.getState() as any;
              const mutAction = {
                type: "audio/setMuted" as const,
                id: `mute-${Date.now().toString(36)}`,
                timestamp: Date.now(),
                params: { clipId, muted: patch.muted },
              };
              const mr = await mutStore.actionExecutor.execute(mutAction, mutStore.project);
              if (mr.success) {
                useProjectStore.setState({ project: { ...mutStore.project, modifiedAt: Date.now() } });
              } else {
                errors.push(`setMuted: ${mr.error?.message ?? "failed"}`);
              }
            }
            let finalClip: any = null;
            for (const tr of useProjectStore.getState().project.timeline?.tracks ?? []) {
              const c = (tr.clips ?? []).find((cc: any) => cc.id === clipId);
              if (c) { finalClip = c; break; }
            }
            reply({
              type: "voidspace:clip-patched",
              requestId: msg.requestId,
              clip: finalClip,
              errors: errors.length ? errors : undefined,
              ok: errors.length === 0,
            });
            break;
          }
          case "voidspace:add-clip": {
            const { trackId, mediaId, startTime } = msg as any;
            if (!trackId || !mediaId || typeof startTime !== "number") {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "trackId, mediaId, startTime required" });
              break;
            }
            const r = await useProjectStore.getState().addClip(trackId, mediaId, startTime);
            if (!r.success) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: r.error ?? "addClip failed" });
              break;
            }
            // Look up the just-created clip — it's the newest one on
            // the track at the requested startTime.
            const tr = useProjectStore.getState().project.timeline?.tracks?.find((t: any) => t.id === trackId);
            const newClip = (tr?.clips ?? []).find((c: any) => c.startTime === startTime && c.mediaId === mediaId);
            reply({ type: "voidspace:clip-added", requestId: msg.requestId, clip: newClip ?? null, ok: true });
            break;
          }
          case "voidspace:remove-clip": {
            const { clipId } = msg as any;
            if (!clipId) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "clipId required" });
              break;
            }
            const r = await useProjectStore.getState().removeClip(clipId);
            if (!r.success) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: r.error ?? "removeClip failed" });
              break;
            }
            reply({ type: "voidspace:clip-removed", requestId: msg.requestId, clipId, ok: true });
            break;
          }
          case "voidspace:move-clip": {
            const { clipId, startTime, trackId } = msg as any;
            if (!clipId || typeof startTime !== "number") {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "clipId + startTime required" });
              break;
            }
            // Text clip path — move via title engine.
            const titleEngMove = useEngineStore.getState().getTitleEngine();
            const textClipMove = titleEngMove?.getTextClip(clipId);
            if (textClipMove) {
              titleEngMove!.updateTextClip(clipId, { startTime });
              const proj = useProjectStore.getState().project;
              useProjectStore.setState({ project: { ...proj, modifiedAt: Date.now() } });
              reply({ type: "voidspace:clip-moved", requestId: msg.requestId, clipId, ok: true });
              break;
            }
            // Media clip path.
            const r = await useProjectStore.getState().moveClip(clipId, startTime, trackId);
            if (!r.success) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: r.error ?? "moveClip failed" });
              break;
            }
            reply({ type: "voidspace:clip-moved", requestId: msg.requestId, clipId, ok: true });
            break;
          }
          case "voidspace:snapshot": {
            // Create a named snapshot in the editor's ActionHistory.
            // The chat uses this to bookmark the state before an agent
            // turn so the user can revert via the HistoryPanel.
            const snapStore = useProjectStore.getState() as any;
            const snapName = typeof msg.name === "string" && msg.name ? msg.name : `Agent checkpoint ${new Date().toLocaleTimeString()}`;
            const snap = snapStore.actionHistory.createSnapshot(snapName);
            reply({ type: "voidspace:snapshot", requestId: msg.requestId, ok: true, snapshot: snap });
            break;
          }
          case "voidspace:restore-snapshot": {
            // Undo back to a previously created snapshot. This reverts
            // all actions that happened after the snapshot was created.
            const restStore = useProjectStore.getState() as any;
            const targetSnap = msg.snapshot as { id: string; stackIndex: number } | undefined;
            if (!targetSnap?.id) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "snapshot required" });
              break;
            }
            const allSnaps = restStore.actionHistory.getSnapshots();
            const found = allSnaps.find((s: any) => s.id === targetSnap.id);
            const targetIdx = found?.stackIndex ?? targetSnap.stackIndex;
            if (typeof targetIdx !== "number") {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "snapshot not found" });
              break;
            }
            let undone = 0;
            while (restStore.actionHistory.getUndoStackSize() > targetIdx) {
              const ok = await restStore.undo();
              if (!ok?.success) break;
              undone++;
            }
            reply({ type: "voidspace:restore-snapshot", requestId: msg.requestId, ok: true, undone });
            break;
          }
          case "voidspace:export": {
            // Run the openreel editor's NATIVE export engine (the same
            // path the toolbar's "Export" button uses). The engine
            // requires a `FileSystemWritableFileStream`-shaped target
            // (it calls `.seek(position)` to jump around the MP4 mux);
            // a plain `WritableStream` lacks `seek()` and produces
            // "Cannot close a ERRORED writable stream" near 100%.
            // We mirror the toolbar's `createMemoryWritable` shim so
            // the engine writes into a growable buffer and we hand
            // back the assembled Blob.
            const proj = useProjectStore.getState().project;
            if (!proj) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "no project loaded" });
              break;
            }
            try {
              const core = await import("@openreel/core");
              const engine = core.getExportEngine();
              await engine.initialize();

              const w = proj.settings?.width ?? 1920;
              const h = proj.settings?.height ?? 1080;
              const settings: any = {
                width: w,
                height: h,
                frameRate: proj.settings?.frameRate ?? 30,
                format: "mp4",
                codec: "h264",
                bitrate: 12000,
                quality: 85,
                ...(msg.settings || {}),
              };
              const mimeType = settings.format === "webm" ? "video/webm"
                : settings.format === "mov"  ? "video/quicktime"
                : "video/mp4";

              // FileSystemWritableFileStream-shaped in-memory shim.
              // Mirrors `createMemoryWritable` from Toolbar.tsx — must
              // implement seek/write/close/abort/truncate so the
              // mediabunny mux can patch headers near the end.
              let buffer = new Uint8Array(16 * 1024 * 1024);
              let length = 0;
              let cursor = 0;
              // Use `unknown` so the close() handler's narrowing path
              // doesn't compile down to `never` for the callsite below.
              let closedBlob: Blob | null = null as Blob | null;
              const ensureCapacity = (needed: number) => {
                if (needed <= buffer.length) return;
                let nextSize = buffer.length;
                while (nextSize < needed) nextSize *= 2;
                const next = new Uint8Array(nextSize);
                next.set(buffer.subarray(0, length));
                buffer = next;
              };
              const writeBytes = (bytes: Uint8Array, position: number) => {
                const end = position + bytes.byteLength;
                ensureCapacity(end);
                buffer.set(bytes, position);
                if (end > length) length = end;
              };
              const toBytes = (data: unknown): Uint8Array | null => {
                if (data instanceof ArrayBuffer) return new Uint8Array(data);
                if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                return null;
              };
              const writable = {
                seek(position: number) { cursor = position; return Promise.resolve(); },
                write(data: unknown) {
                  // Some writers pass `{ type: 'write', data, position }`;
                  // others pass raw ArrayBuffer / TypedArray. Handle both.
                  if (data && typeof data === "object" && (data as any).type === "write") {
                    const d = data as any;
                    if (typeof d.position === "number") cursor = d.position;
                    const bytes = toBytes(d.data);
                    if (bytes) {
                      writeBytes(bytes, cursor);
                      cursor += bytes.byteLength;
                    }
                  } else {
                    const bytes = toBytes(data);
                    if (bytes) {
                      writeBytes(bytes, cursor);
                      cursor += bytes.byteLength;
                    }
                  }
                  return Promise.resolve();
                },
                close() {
                  closedBlob = new Blob([buffer.slice(0, length) as BlobPart], { type: mimeType });
                  return Promise.resolve();
                },
                abort() { return Promise.resolve(); },
                truncate(size: number) {
                  if (size < length) length = size;
                  return Promise.resolve();
                },
              } as unknown as FileSystemWritableFileStream;

              const progress = (frac: number, phase: string) => {
                try {
                  (e.source as Window | null)?.postMessage({
                    type: "voidspace:export-progress",
                    requestId: msg.requestId,
                    fraction: Math.max(0, Math.min(1, frac)),
                    phase,
                  }, "*");
                } catch { /* ignore */ }
              };

              const generator = engine.exportVideo(proj, settings, writable);
              let result: any;
              while (true) {
                const { value, done } = await generator.next();
                if (done) { result = value; break; }
                progress(value?.progress ?? 0, value?.phase ?? "Encoding");
              }

              if (!result?.success) {
                throw new Error(result?.error?.message || "Export failed");
              }
              if (!closedBlob) {
                throw new Error("Export finished but no MP4 bytes were captured.");
              }
              const url = URL.createObjectURL(closedBlob);
              reply({
                type: "voidspace:export-done",
                requestId: msg.requestId,
                blobUrl: url,
                durationSec: proj.timeline?.duration ?? 0,
                width: settings.width,
                height: settings.height,
                bytes: closedBlob.size,
                mimeType,
              });
            } catch (err) {
              reply({
                type: "voidspace:error",
                requestId: msg.requestId,
                error: String((err as any)?.message ?? err),
              });
            }
            break;
          }
          case "voidspace:play":
          case "voidspace:pause":
          case "voidspace:seek": {
            // Playback controls live on the player ref inside
            // EditorInterface; surface a CustomEvent the player wires
            // listens to. The editor handles unknown events as no-ops
            // so this is safe even when the player isn't mounted.
            const detail = t === "voidspace:seek" ? { sec: Number(msg.sec) || 0 } : {};
            try {
              window.dispatchEvent(new CustomEvent(t.replace(":", "."), { detail }));
              reply({ type: "voidspace:ack", requestId: msg.requestId, op: t.split(":")[1] });
            } catch (err) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: String((err as any)?.message ?? err) });
            }
            break;
          }
          default:
            // Unknown voidspace:* messages are silently ignored to avoid
            // polluting the chat ↔ editor channel with errors during
            // version skew between the two surfaces.
            break;
        }
      } catch (err) {
        reply({ type: "voidspace:error", requestId: msg?.requestId, error: String((err as any)?.message ?? err) });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [loadProject]);

  // ── ?import=<videoUrl> auto-import: drop a remote MP4 into a fresh project ──
  useEffect(() => {
    if (hasHandledImport.current) return;
    const sp = new URLSearchParams(window.location.search);
    const importUrl = sp.get("import");
    if (!importUrl) return;
    if (sp.has("sceneListId")) return; // sceneListId path takes precedence
    hasHandledImport.current = true;

    const importTitle = sp.get("title") || "Imported Reel";
    setVoidspaceLoading(true);

    (async () => {
      try {
        const res = await fetch(importUrl, { mode: "cors", cache: "no-store" });
        if (!res.ok) throw new Error(`Import fetch failed: ${res.status}`);
        const blob = await res.blob();
        const filename = importTitle.replace(/[^\w.-]+/g, "_") + ".mp4";
        const file = new File([blob], filename, { type: blob.type || "video/mp4" });

        // Start a new project and add this clip to its media library + timeline.
        createNewProject(importTitle, { width: 1920, height: 1080, frameRate: 30 });
        const result = await importMedia(file);
        if (!result.success) {
          throw new Error(result.error?.message || "Failed to import video");
        }
        // Place the imported clip on a fresh track so the editor opens with
        // the reel ready to edit, not just an empty timeline + library item.
        const justImported = useProjectStore
          .getState()
          .project.mediaLibrary.items.slice(-1)[0];
        if (justImported) {
          await addClipToNewTrack(justImported.id, 0);
        }
        navigate("editor");
      } catch (err) {
        console.error("[Voidspace] import failed:", err);
        setVoidspaceError(
          err instanceof Error ? err.message : "Failed to import video",
        );
      } finally {
        setVoidspaceLoading(false);
      }
    })();
  }, [createNewProject, importMedia, addClipToNewTrack, navigate]);

  useEffect(() => {
    if (hasHandledInitialRoute.current) return;

    if (route === "new") {
      hasHandledInitialRoute.current = true;

      let projectName = "New Project";
      let width = 1920;
      let height = 1080;
      let frameRate = fps;

      if (params.preset) {
        const presetKey = params.preset as SocialMediaCategory;
        const preset = SOCIAL_MEDIA_PRESETS[presetKey];
        if (preset) {
          width = preset.width;
          height = preset.height;
          frameRate = preset.frameRate || fps;
          projectName = `New ${presetKey.charAt(0).toUpperCase() + presetKey.slice(1).replace(/-/g, " ")} Project`;
        }
      } else if (parsedDimensions) {
        width = parsedDimensions.width;
        height = parsedDimensions.height;

        const dimensionKey = `${width}x${height}`;
        const matchingPreset = PRESET_DIMENSIONS[dimensionKey];
        if (matchingPreset) {
          const preset = SOCIAL_MEDIA_PRESETS[matchingPreset];
          frameRate = preset.frameRate || fps;
        }

        const aspectRatio = width / height;
        if (aspectRatio < 1) {
          projectName = "New Vertical Video";
        } else if (aspectRatio > 1) {
          projectName = "New Horizontal Video";
        } else {
          projectName = "New Square Video";
        }
      }

      createNewProject(projectName, { width, height, frameRate });
      navigate("editor");
    } else if (["welcome", "templates", "editor"].includes(route)) {
      hasHandledInitialRoute.current = true;
    }
  }, [
    route,
    params,
    parsedDimensions,
    fps,
    createNewProject,
    navigate,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && route !== "editor") {
        navigate("editor");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openSearchModal("search");
      }
    },
    [route, navigate, openSearchModal],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const forceWelcome =
    params.forceWelcome === "1" ||
    new URLSearchParams(window.location.search).get("forceWelcome") === "1";
  const showWelcome =
    ["welcome", "templates"].includes(route) || forceWelcome;
  const initialTab =
    route === "templates"
      ? "templates"
      : undefined;
  const isSharePage = route === "share" && params.shareId;

  return (
    <TooltipProvider>
      <div className="h-screen w-screen bg-background text-text-primary overflow-hidden">
        <MobileBlocker />
        {voidspaceLoading ? (
          <LoadingSpinner message="Loading your Voidspace project..." />
        ) : voidspaceError ? (
          <div className="h-screen w-screen bg-background flex flex-col items-center justify-center gap-3">
            <p className="text-sm text-destructive">{voidspaceError}</p>
            <button
              onClick={() => window.location.reload()}
              className="text-sm text-primary hover:underline"
            >
              Retry
            </button>
          </div>
        ) : isSharePage ? (
          <SharePage shareId={params.shareId!} />
        ) : showWelcome ? (
          <WelcomeScreen initialTab={initialTab} />
        ) : (
          <Suspense fallback={<LoadingSpinner message="Loading editor..." />}>
            <EditorInterface />
          </Suspense>
        )}
        <ToastContainer />
        <ScriptViewDialog
          isOpen={activeModal === "scriptView"}
          onClose={closeModal}
        />
        <SearchModal isOpen={activeModal === "search"} onClose={closeModal} />
      </div>
    </TooltipProvider>
  );
}

export default App;
