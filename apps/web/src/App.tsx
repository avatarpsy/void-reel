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
import { ensureWhisperModel } from "./services/teleprompter-asr";
import { SOCIAL_MEDIA_PRESETS, getSpeedEngine, getMediaEngine, type MediaMetadata, type SocialMediaCategory } from "@openreel/core";
import { readClipLooks, readTrackTransitions, readbackSourcesFrom } from "./agent/clip-readback";
import { TooltipProvider } from "@openreel/ui";
import {
  waitForAuth,
  fetchSceneListContext,
  loadSceneListAsProject,
  subscribeSceneListAsProject,
} from "./services/voidspace-loader";
import { resolveBootTheme, watchSiteTheme } from "@openreel/ui";
import { autoSaveManager } from "./services/auto-save";
import { freshTrackInsertIndex } from "./services/track-order";
import { loadMediaBlobForProject, saveMediaBlob } from "./services/media-storage";
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

// ── Live-swap authority (URL-keyed) ─────────────────────────────────────
//
// When the chat replaces a clip's media live (replace-clip-media for
// narration/video, add-bgm-clip for music), we mutate the in-memory project
// store immediately and the editor's autosave commits the swap into the
// Firestore project_state blob a beat later. BUT the live subscription
// rebuilds the WHOLE project from Firestore on every scene-list write, and
// until the durable source catches up the rebuilt ("fresh") clip still points
// at the OLD media. applyAdditiveMerge's updatedClips logic — which exists to
// propagate genuine Firestore-driven url changes — would then adopt that stale
// clip and REVERT the swap the user just made (BGM snaps back to the previous
// track; narration/video flip to the old take).
//
// CRITICAL — why this is keyed on the resolved media URL, NOT the mediaId:
// the replace-clip-media RPC mints `media-audio-<hash(url)>` while the loader's
// per-scene rebuild mints `media-narration-<docId>-<id>`. Those schemes can
// NEVER be equal, so a mediaId-based guard silently fails the moment a rebuild
// takes the per-scene path (stale/missing blob), and the narration reverts.
// We instead record the URL the user swapped to and compare each rebuilt
// clip's RESOLVED media originalUrl against it: while the authority is live we
// suppress any rebuild that would point the clip at a DIFFERENT url; the
// instant any durable source (blob OR the per-scene narration_url/video_url/
// music_url field) resolves back to the chosen url, the authority retires so
// genuine later changes flow through. A generous TTL (120s) outlives slow GCS
// mirror uploads that would otherwise leave a late rebuild unguarded.
const liveSwapAuthority = new Map<string, { url: string; at: number }>();
const LIVE_SWAP_AUTHORITY_TTL_MS = 120_000;
const normSwapUrl = (u: unknown): string => String(u || "").split(/[?#]/)[0];
function recordLiveSwap(clipId: string, url: string): void {
  if (!clipId || !url) return;
  liveSwapAuthority.set(clipId, { url: normSwapUrl(url), at: Date.now() });
}

const isCaptionTextClip = (tc: import("@openreel/core").TextClip): boolean =>
  tc.trackId === "track-captions" || tc.id.startsWith("caption-");

/**
 * Pick which fresh (Firestore-rebuilt) text clips to ADD on a live merge.
 *
 * Excludes clips already in the engine (by id) AND — crucially — fresh CAPTION
 * clips that overlap a caption already in the engine. The avatar pipeline
 * regenerates caption-* clips from wordTimestamps on EVERY tick; once the user
 * has captions for a region (auto-loaded, inspector-"Generate Captions", or
 * edited), re-adding the pipeline caption stacks it on top → the overlapping
 * caption clips. A fresh caption in a region with NO existing caption (a newly
 * generated scene) still passes through, so streaming generation still works.
 */
export function pickNewTextClips(
  existingTextClips: readonly import("@openreel/core").TextClip[],
  freshTextClips: readonly import("@openreel/core").TextClip[],
): import("@openreel/core").TextClip[] {
  const knownIds = new Set(existingTextClips.map((t) => t.id));
  const existingCaptions = existingTextClips.filter(isCaptionTextClip);
  return freshTextClips.filter((t) => {
    if (knownIds.has(t.id)) return false;
    if (isCaptionTextClip(t)) {
      const tEnd = t.startTime + t.duration;
      const overlapsExisting = existingCaptions.some(
        (x) => t.startTime < x.startTime + x.duration && tEnd > x.startTime,
      );
      if (overlapsExisting) return false;
    }
    return true;
  });
}

export interface CaptionConsolidation {
  clips: import("@openreel/core").TextClip[];
  /** Every text track that held a caption — empty ones can then be dropped. */
  captionSourceTrackIds: Set<string>;
}

/**
 * One-time cleanup for projects mangled by OLDER builds that re-ran "Generate
 * Captions" without clearing — leaving the canonical `track-captions` plus a
 * pile of DUPLICATE / ORPHANED text tracks all carrying the same stale captions.
 *
 * Rule: `track-captions` (and any caption-* clip) is the single source of truth.
 * A text clip on ANOTHER track is stale caption junk when it BOTH (a) overlaps a
 * canonical caption's time span and (b) is part of a duplicate group (the same
 * text+start appears 2+ times) — that combination is unmistakably a leftover
 * regenerate, never a deliberate title (which is unique and rarely overlaps a
 * caption). Such clips are dropped and their source tracks reported so the empty
 * ones can be removed; everything else is left untouched. Anchor captions are
 * collapsed onto `track-captions`. Returns null when already clean (idempotent).
 */
export function consolidateCaptionTextClips(
  clips: readonly import("@openreel/core").TextClip[],
  namedCaptionTrackIds: ReadonlySet<string>,
): CaptionConsolidation | null {
  const norm = (t: string | undefined) => (t || "").trim().toUpperCase();
  const dupKey = (c: import("@openreel/core").TextClip) =>
    `${norm(c.text)}|${Math.round(c.startTime * 10)}`;
  const isAnchor = (c: import("@openreel/core").TextClip) =>
    namedCaptionTrackIds.has(c.trackId) || c.id.startsWith("caption-");

  // Canonical caption time spans + how often each (text,start) repeats.
  const anchorSpans = clips
    .filter(isAnchor)
    .map((c) => ({ start: c.startTime, end: c.startTime + c.duration }));
  const counts = new Map<string, number>();
  for (const c of clips) counts.set(dupKey(c), (counts.get(dupKey(c)) ?? 0) + 1);
  const isDuplicated = (c: import("@openreel/core").TextClip) =>
    (counts.get(dupKey(c)) ?? 0) >= 2;

  const out: import("@openreel/core").TextClip[] = [];
  const captionSourceTrackIds = new Set<string>();
  const keptSpans: Array<{ start: number; end: number }> = [];
  let changed = false;
  for (const c of clips) {
    const end = c.startTime + c.duration;
    if (isAnchor(c)) {
      captionSourceTrackIds.add(c.trackId);
      // Collapse onto track-captions. An overlapping anchor is only junk
      // when it's ALSO a duplicate (same text+start seen twice — the
      // regenerate-leftover signature). UNIQUE overlapping captions are
      // legitimate content: AE template titles routinely show two lines
      // in the same window ("SPACE" + "SLIDESHOW") — dropping them ate
      // 29 of 38 imported titles.
      const overlapsKept = keptSpans.some(
        (s) => c.startTime < s.end - 0.05 && end > s.start + 0.05,
      );
      if (overlapsKept && isDuplicated(c)) {
        changed = true;
        continue;
      }
      keptSpans.push({ start: c.startTime, end });
      if (c.trackId !== "track-captions") {
        out.push({ ...c, trackId: "track-captions" });
        changed = true;
      } else {
        out.push(c);
      }
      continue;
    }
    const overlapsAnchor = anchorSpans.some(
      (a) => c.startTime < a.end - 0.05 && end > a.start + 0.05,
    );
    if (overlapsAnchor && isDuplicated(c)) {
      captionSourceTrackIds.add(c.trackId); // stale duplicate caption -> drop
      changed = true;
      continue;
    }
    out.push(c); // genuine non-caption text (unique title) survives untouched
  }
  return changed ? { clips: out, captionSourceTrackIds } : null;
}

function applyAdditiveMerge(fresh: import("@openreel/core").Project): {
  dirty: boolean;
  newMedia: number;
  upgraded: number;
  newClips: number;
  newCaptions: number;
} {
  const store = useProjectStore.getState();
  const current = store.project;

  // Deletion tombstones (see Project.deletedTracks): an additive union can
  // only ADD, so a user's track deletion — an absence in the saved project —
  // would be resurrected by every scene-list re-derivation without these.
  // Skip re-adding tombstoned tracks and the exact clip ids that existed at
  // deletion time; clips generated AFTER the deletion still stream in.
  const tombById = new Map(
    (current.deletedTracks ?? []).map((d) => [d.id, d] as const),
  );
  const tombClipIds = new Set(
    (current.deletedTracks ?? []).flatMap((d) => [...d.clipIds]),
  );

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
        // Carry the native relink hint onto pre-existing items that
        // predate sourceFile stamping. Prefer the existing one — a prior
        // relink stored the REAL file name/size there.
        sourceFile: existing.sourceFile ?? fr.sourceFile,
      });
    }
  }

  // Seed the text-clip merge from the LIVE title engine, not the possibly-stale
  // project.textClips snapshot. Caption/title edits made via the inspector or
  // canvas land in the engine map but don't write back to project.textClips, so
  // seeding from the snapshot here would clobber them on the next generation
  // tick (e.g. while remaining scenes stream in). The save path already reads
  // the engine via getAllTextClips, so this keeps live + saved in agreement.
  const liveTitleEngine = useEngineStore.getState().getTitleEngine();
  const engineTextClips = liveTitleEngine?.getAllTextClips() ?? [];
  // Prefer the live engine (it holds in-session caption/title edits that never
  // write back to project.textClips). Fall back to the project snapshot ONLY
  // when the engine is initialized-but-EMPTY (Firestore loaded but
  // loadTextClips hasn't fired yet) — `[]` is non-nullish, so this needs an
  // explicit length check, mirroring the get-state read elsewhere in this file.
  const existingTextClips =
    engineTextClips.length > 0 ? engineTextClips : current.textClips ?? [];
  const newTextClips = pickNewTextClips(
    existingTextClips,
    fresh.textClips ?? [],
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
  // Resolve each rebuilt clip's media URL so the live-swap guard can compare by
  // URL (scheme-independent) — see liveSwapAuthority. The editor RPC and the
  // loader mint DIFFERENT mediaId schemes for the same take, so only the
  // resolved originalUrl is a reliable cross-rebuild identity.
  const freshUrlByMediaId = new Map<string, string>();
  for (const m of fresh.mediaLibrary?.items ?? []) {
    if (m.id && m.originalUrl) freshUrlByMediaId.set(m.id, normSwapUrl(m.originalUrl));
  }
  const updatedClips = new Map<string, import("@openreel/core").Clip>();
  for (const tr of fresh.timeline.tracks) {
    const adds = tr.clips.filter(
      (c) => !knownClipIds.has(c.id) && !tombClipIds.has(c.id),
    );
    if (adds.length > 0) trackPatches.set(tr.id, adds);
    for (const freshClip of tr.clips) {
      const existing = currentClipById.get(freshClip.id);
      if (!existing) continue;
      const auth = liveSwapAuthority.get(freshClip.id);
      const authLive = auth && (Date.now() - auth.at < LIVE_SWAP_AUTHORITY_TTL_MS);
      const freshUrl = freshUrlByMediaId.get(freshClip.mediaId) || "";
      // Retire the authority the moment ANY durable source (the autosaved blob
      // OR the per-scene narration_url/video_url/music_url field) resolves this
      // clip back to the chosen url — regardless of mediaId scheme — so genuine
      // LATER changes propagate instead of being shadow-suppressed until TTL.
      if (auth && freshUrl && freshUrl === auth.url) liveSwapAuthority.delete(freshClip.id);
      if (existing.mediaId !== freshClip.mediaId) {
        // Suppress the stale-rebuild revert: while the user's live swap is
        // authoritative, never let a rebuild repoint this clip at media whose
        // URL differs from the swapped-to URL (the actual symptom — narration
        // flipping back to the old take). If the fresh URL already IS the chosen
        // url, fall through: that's a benign mediaId-scheme reconciliation (same
        // take, loader's media item) and the authority was just retired above.
        if (authLive && freshUrl !== auth!.url) {
          continue; // stale rebuild → would revert to a different take; keep swap
        }
        updatedClips.set(freshClip.id, freshClip);
      }
    }
  }

  const newClipsCount = [...trackPatches.values()].reduce(
    (n, a) => n + a.length,
    0,
  );
  const adoptFreshName = (!current.name || current.name === "Voidspace Project")
    && !!fresh.name && fresh.name !== "Voidspace Project";
  const dirty =
    adoptFreshName ||
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
    if (knownTrackIds.has(tr.id)) continue;
    let incoming = tr;
    if (tombById.has(tr.id)) {
      // The user deleted this track. Only re-materialize it if the rebuild
      // carries clips that did NOT exist at deletion time (fresh
      // generations) — and even then, without the deleted clips.
      const survivors = tr.clips.filter((c) => !tombClipIds.has(c.id));
      if (survivors.length === 0) continue;
      incoming = { ...tr, clips: survivors };
    }
    // Insert where the FRESH project intends, not at the end — track order is
    // z-order, and appending would drop an overlay behind the footage on every
    // project that already has a saved timeline. See freshTrackInsertIndex.
    const at = freshTrackInsertIndex(
      mergedTracks.map((t) => t.id),
      fresh.timeline.tracks.map((t) => t.id),
      tr.id,
    );
    mergedTracks.splice(at, 0, incoming);
    knownTrackIds.add(tr.id);
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
      name: adoptFreshName ? fresh.name : current.name,
      settings: adoptFreshSettings
        ? { ...current.settings, ...fresh.settings }
        : current.settings,
      mediaLibrary: { items: [...mergedMediaItems, ...newMedia] },
      timeline: { ...current.timeline, tracks: mergedTracks },
      textClips: [...existingTextClips, ...newTextClips],
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
      // Also the NEW media ids the clips now point at — a stale decoded
      // buffer under the new id (e.g. re-selected earlier take) would
      // otherwise keep playing the old audio.
      ...[...updatedClips.values()].map((c) => c.mediaId),
    ];
    playbackController?.invalidateAudioForMedia(toInvalidate[Symbol.iterator]());
  }

  if (liveTitleEngine) {
    liveTitleEngine.loadTextClips([...existingTextClips, ...newTextClips]);
  }

  return {
    dirty: true,
    newMedia: newMedia.length,
    upgraded: upgradedMediaById.size,
    newClips: newClipsCount,
    newCaptions: newTextClips.length,
  };
}

/**
 * Re-attach blobs to media-library items after a project loads. A
 * JSON-round-tripped project (local autosave OR the Firestore project_state
 * blob) carries item metadata + `originalUrl` but NEVER the Blob. Library-only
 * items (e.g. a webcam/audio RECORDING the user hasn't dropped on the timeline
 * yet) were previously only hydrated lazily on drag — so after a reload they
 * showed a broken thumbnail and felt "lost," and if IndexedDB had been evicted
 * they truly were.
 *
 * This restores every blob-less item, in priority order:
 *   1. IndexedDB (`loadMediaBlob` by id) — the fast local cache.
 *   2. `originalUrl` (recordings carry the durable /api/studio/local-asset DISK
 *      url — see Toolbar.handleRecordingComplete) fetched via the auth-stamped
 *      fetcher, then re-cached to IndexedDB so the next reload is instant.
 * Idempotent, best-effort, non-blocking; only fills gaps, never overwrites a
 * live blob or a user edit.
 */
async function hydrateLibraryMediaBlobs(): Promise<void> {
  try {
    const proj = useProjectStore.getState().project;
    const items = proj.mediaLibrary?.items ?? [];
    const isDataUrl = (v: unknown): v is string =>
      typeof v === "string" && v.startsWith("data:");
    // An item needs work if its blob is gone (can't render/drag) OR — for a
    // video/image — its thumbnail isn't a persistable data: URL (a dead blob:
    // from the prior session or an auth-gated local-asset url shows as a broken
    // image in Assets). We regenerate a data: thumbnail from the blob either way.
    const needsWork = items.filter(
      (m) =>
        !(m.blob instanceof Blob) ||
        (m.type !== "audio" && !isDataUrl(m.thumbnailUrl)),
    );
    if (needsWork.length === 0) return;

    let fetchMediaBlob: ((url: string) => Promise<Blob | null>) | null = null;
    let bridge: any = null;
    const newBlobs = new Map<string, Blob>();
    const freshThumbs = new Map<string, string>();
    const sourceMetadata = new Map<string, MediaMetadata>();
    let blobHits = 0;

    for (const item of needsWork) {
      // 1. Ensure we have the bytes: existing blob → IndexedDB → disk originalUrl.
      let blob: Blob | null = item.blob instanceof Blob ? item.blob : null;
      if (!blob) {
        // Project-scoped load: a blob cached under this mediaId by ANOTHER
        // project (scene ids collide) is rejected so we refetch our own.
        try { blob = await loadMediaBlobForProject(proj.id, item.id); } catch { /* miss */ }
      }
      if (!blob && item.originalUrl) {
        try {
          if (!fetchMediaBlob) ({ fetchMediaBlob } = await import("./services/voidspace-loader"));
          blob = await fetchMediaBlob(item.originalUrl);
          if (blob) saveMediaBlob(proj.id, item.id, blob, item.metadata).catch(() => {});
        } catch { /* disk unreachable */ }
      }
      if (!blob) continue; // truly unavailable — item still lists, just inert
      if (!(item.blob instanceof Blob)) { newBlobs.set(item.id, blob); blobHits++; }
      // Source properties are independent of the output canvas and clip trim.
      // Legacy generated items used the canvas dimensions as source metadata.
      if (item.type === "video") {
        try {
          const engine = getMediaEngine();
          await engine.initialize();
          sourceMetadata.set(item.id, await engine.extractMetadata(blob));
        } catch { /* keep the existing metadata if the source cannot be probed */ }
      }

      // 2. Regenerate a persistable data: thumbnail when the current one won't
      //    survive (video/image only; audio renders a waveform, no frame).
      if (item.type !== "audio" && !isDataUrl(item.thumbnailUrl)) {
        try {
          if (!bridge) {
            const m = await import("./bridges");
            bridge = m.getMediaBridge();
            if (!bridge.isInitialized()) await m.initializeMediaBridge();
          }
          const thumbs = await bridge.generateThumbnailsForMedia(
            blob,
            item.type === "image" ? "image" : "video",
          );
          if (thumbs[0]?.dataUrl) freshThumbs.set(item.id, thumbs[0].dataUrl);
        } catch { /* best-effort thumbnail */ }
      }
    }

    if (newBlobs.size === 0 && freshThumbs.size === 0 && sourceMetadata.size === 0) {
      console.log(`[Voidspace] library hydration: nothing to restore (${needsWork.length} candidates, none recoverable)`);
      return;
    }
    const cur = useProjectStore.getState().project;
    if (cur.id !== proj.id) return;
    const originalSources = new Map(items.map((m) => [m.id, m.originalUrl]));
    useProjectStore.setState({
      project: {
        ...cur,
        mediaLibrary: {
          ...cur.mediaLibrary,
          items: cur.mediaLibrary.items.map((m) => {
            if (!originalSources.has(m.id) || originalSources.get(m.id) !== m.originalUrl) return m;
            const nb = newBlobs.get(m.id);
            const nt = freshThumbs.get(m.id);
            const metadata = sourceMetadata.get(m.id);
            if (!nb && !nt && !metadata) return m;
            return {
              ...m,
              blob: nb && !(m.blob instanceof Blob) ? nb : m.blob,
              thumbnailUrl: nt ?? m.thumbnailUrl,
              metadata: metadata ? { ...m.metadata, ...metadata } : m.metadata,
            };
          }),
        },
      },
    });
    console.log(
      `[Voidspace] library hydration: +${blobHits} blob(s), +${freshThumbs.size} data-thumbnail(s) restored from IndexedDB/disk.`,
    );
  } catch (e) {
    console.warn("[Voidspace] library blob hydration failed:", e);
  }
}

function App() {
  const { activeModal, closeModal } = useUIStore();
  const { openModal: openSearchModal } = useUIStore();

  // Landing in the editor IS landing on voidspace.ai — kick the silent, one-time
  // background download of the on-device Whisper model (teleprompter auto-scroll)
  // during idle. Idempotent + shares the site-wide browser cache, so if another
  // page already fetched it this is a no-op; it never re-downloads.
  useEffect(() => {
    ensureWhisperModel();
  }, []);
  const createNewProject = useProjectStore((state) => state.createNewProject);
  const loadProject = useProjectStore((state) => state.loadProject);
  const importMedia = useProjectStore((state) => state.importMedia);
  const addClipToNewTrack = useProjectStore((state) => state.addClipToNewTrack);
  const forceSave = useProjectStore((state) => state.forceSave);

  // Auto-clean projects saved by OLDER builds that left DUPLICATE caption tracks
  // ("Captions" x2 / "Text N") with stacked clips: collapse every caption onto
  // the one canonical track-captions and drop the now-empty duplicate tracks.
  // Idempotent — no-ops once the project is clean — so it's safe to run on each
  // project change (load + live ticks).
  const projectModifiedAt = useProjectStore((s) => s.project.modifiedAt);
  useEffect(() => {
    const titleEngine = useEngineStore.getState().getTitleEngine();
    if (!titleEngine) return;
    const tracks = useProjectStore.getState().project.timeline.tracks;
    const captionTrackIds = new Set(
      tracks
        .filter(
          (t) =>
            t.type === "text" && (t.id === "track-captions" || t.name === "Captions"),
        )
        .map((t) => t.id),
    );
    if (captionTrackIds.size === 0) return;
    const consolidated = consolidateCaptionTextClips(
      titleEngine.getAllTextClips(),
      captionTrackIds,
    );
    if (!consolidated) return; // already clean
    titleEngine.loadTextClips(consolidated.clips);
    const usedTrackIds = new Set(consolidated.clips.map((c) => c.trackId));
    useProjectStore.setState((s) => {
      const cleanedTracks = s.project.timeline.tracks.filter(
        (t) =>
          // Drop a TEXT track that HELD a caption and is now empty (the legacy
          // duplicate "Captions" + mis-named "Text N" tracks). Keep the
          // canonical track-captions and any track still holding clips.
          !(
            t.type === "text" &&
            t.id !== "track-captions" &&
            consolidated.captionSourceTrackIds.has(t.id) &&
            !usedTrackIds.has(t.id)
          ),
      );
      return {
        project: {
          ...s.project,
          timeline: { ...s.project.timeline, tracks: cleanedTracks },
          modifiedAt: Date.now(),
        },
      };
    });
  }, [projectModifiedAt]);

  /**
   * The storyboard this project was compiled from, if any.
   *
   * A ref, not state: nothing on screen here depends on it. It exists so
   * `get-state` can answer "where did this film come from?", which is what lets
   * the host page offer a way back without searching every board for one that
   * claims this project.
   */
  const sourceBoardIdRef = useRef<string>("");

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
      // When the live subscription is installed, the loading spinner must
      // stay up until the FIRST project tick actually lands (that tick can
      // take seconds while scene media resolves). The `finally` below then
      // skips its early clear — previously the spinner vanished the moment
      // the subscription was merely INSTALLED, leaving a blank timeline
      // with no loading indication for the whole resolve.
      let spinnerClearedByFirstTick = false;
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

        // Voidspace remote sync. Every time IndexedDB save succeeds,
        // postMessage the same Project blob to the parent so it can
        // mirror to Firestore. The parent owns the auth + endpoint
        // call; we just hand over the bytes. If no parent listens
        // (running standalone), the postMessage is a no-op — the
        // local IndexedDB save is the durable copy.
        // Latch that flips ON the first time we see a non-empty project
        // for this scene list. Once flipped, we refuse to write an empty
        // project to the remote blob — that's the path that historically
        // wiped users' data: an early autosave (before per-scene rebuild
        // populated) or a wholesale loadProject of an empty project state
        // would race ahead of the rebuild and persist the empty state,
        // permanently masking the per-scene Firestore docs from the
        // loader (which prefers the blob). The latch is per-iframe and
        // resets on reload — by which time the loader's empty-blob
        // safety net has rebuilt from per-scene anyway.
        let sawNonEmptyProject = false;
        autoSaveManager.setRemoteSync(async (project, historyData) => {
          // Round-trip via requestId so the parent can ack/error.
          // Skip when there's no parent (running detached) — sending
          // to ourselves would silently never resolve.
          if (window.parent === window) return;
          // Empty-write firewall. See `sawNonEmptyProject` comment above.
          const tracksCount = project.timeline?.tracks?.length ?? 0;
          const totalClips = (project.timeline?.tracks ?? []).reduce(
            (n: number, t: any) => n + ((t?.clips?.length) ?? 0), 0,
          );
          const mediaCount = project.mediaLibrary?.items?.length ?? 0;
          const textClipsCount = (project as any).textClips?.length ?? 0;
          const isEmpty = tracksCount === 0 && totalClips === 0 && mediaCount === 0 && textClipsCount === 0;
          if (!isEmpty) {
            sawNonEmptyProject = true;
          } else if (sawNonEmptyProject) {
            console.warn(
              "[Voidspace] BLOCKED remote sync of empty project — would have wiped non-empty server state. Use the snapshot panel to recover, or manually save once a non-empty state is restored.",
            );
            return;
          }
          const requestId = `sync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const ack = new Promise<{ ok: boolean; error?: string }>((resolve) => {
            const onMsg = (e: MessageEvent) => {
              if (e.data?.type === "voidspace:save-project:ack" && e.data.requestId === requestId) {
                window.removeEventListener("message", onMsg);
                resolve({ ok: !!e.data.ok, error: e.data.error });
              }
            };
            window.addEventListener("message", onMsg);
            // 15s ceiling — Firestore writes complete in well under
            // a second; anything longer means the parent is gone and
            // we should let the next save try fresh instead of
            // hanging the inflight queue.
            setTimeout(() => {
              window.removeEventListener("message", onMsg);
              resolve({ ok: false, error: "timeout" });
            }, 15000);
          });
          // NO SIZE GUARD — and that is the point.
          //
          // This used to trim (and then drop) the user's undo history whenever
          // project + history approached 830 KB, because the parent's
          // timeline-state endpoint returned 413 above 900 KB. That cap existed
          // only because the blob was stored in a FIRESTORE DOCUMENT FIELD,
          // which is capped at ~1 MiB. It cost real work: a survey of 311
          // projects found six already past the threshold, their histories cut
          // to 0.1–4.7 KB against 500–856 KB timelines — undo, redo and
          // chat-message rollback silently dead on exactly the big projects
          // where they matter most.
          //
          // The blob now goes to Cloud Storage (see the website's
          // `project-state-store.ts`), which has no such ceiling, so the full
          // history is sent every time. The server keeps a 40 MB sanity bound
          // for genuinely pathological payloads; nothing legitimate approaches
          // it, and a project that did should surface as an error rather than
          // as quietly amputated undo state.
          const historyPayload: string | null = historyData;
          window.parent.postMessage({
            type: "voidspace:save-project",
            requestId,
            sceneListId,
            project,
            history: historyPayload,
          }, "*");
          const r = await ack;
          if (!r.ok) {
            throw new Error(`remote sync failed: ${r.error || "unknown"}`);
          }
          // Fire-and-forget: upload any blob-only media the timeline uses so
          // the project renders on OTHER machines too (bytes otherwise live
          // only in this browser's IndexedDB → placeholder everywhere else).
          import("./services/media-materialize")
            .then((m) => m.sweepMaterializeTimelineMedia())
            .catch(() => { /* best-effort */ });
        });
        // Capture ActionHistory state on every save so undo/redo +
        // chat-message snapshots survive page reload via the blob.
        // Without this, restoreSnapshot would silently no-op (the
        // post-reload undoStack is empty, and restore expects to
        // walk back to a stackIndex from the prior session).
        autoSaveManager.setHistoryProvider(() => {
          try {
            const h = useProjectStore.getState().actionHistory as any;
            if (h && typeof h.serialize === "function") {
              return JSON.stringify(h.serialize());
            }
          } catch (e) {
            console.warn("[Voidspace] history serialize failed:", e);
          }
          return null;
        });

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
            // Recovered IndexedDB saves can carry legacy '-fallback' media
            // ids whose blobs COLLIDE across projects in IndexedDB (scene
            // numbers repeat in every automation project) — the "wrong
            // video plays in every project" corruption. Re-key them before
            // anything hydrates blobs by id.
            try {
              const { migrateLegacyFallbackMediaIds } = await import("./services/voidspace-loader");
              const beforeMig = useProjectStore.getState().project;
              const migrated = migrateLegacyFallbackMediaIds(beforeMig);
              if (migrated !== beforeMig) {
                useProjectStore.setState({ project: migrated });
              }
            } catch (e) {
              console.warn("[Voidspace] media-id migration on recovery failed:", e);
            }
            /**
             * AND THE SAME TREATMENT FOR A GRAPHIC OVERLAY'S BLEND.
             *
             * The loader heals this too, but healing it THERE is not enough and
             * the reason is this branch: a local copy is recovered FIRST, and
             * the Firestore load that follows is additive-only — so the healed
             * clip loses to the IndexedDB one that has been here all along
             * ("merged: no-op (already up-to-date)"). The user's symptom was
             * exact: a lower third that stayed black over the shot until they
             * opened the inspector and set `screen` by hand, and re-sending the
             * board never fixed it.
             *
             * Undefined only, never an explicit value — see `healGraphicBlend`.
             */
            try {
              const { healGraphicBlends } = await import("./services/voidspace-loader");
              const beforeBlend = useProjectStore.getState().project;
              const blended = healGraphicBlends(beforeBlend);
              if (blended !== beforeBlend) {
                useProjectStore.setState({ project: blended });
              }
            } catch (e) {
              console.warn("[Voidspace] graphic-blend heal on recovery failed:", e);
            }
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
            // Re-attach recording / imported-media blobs after local recovery
            // too (autosave nulls blobs on JSON round-trip).
            void hydrateLibraryMediaBlobs();
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
        // A local recovery already painted tracks — the spinner can drop at
        // install time (the finally). Otherwise the first tick clears it.
        spinnerClearedByFirstTick = !recoveredFromLocal;
        if (spinnerClearedByFirstTick) {
          // Safety net: never wedge the spinner if the first tick never
          // fires (Firestore outage / permission error only in console).
          setTimeout(() => setVoidspaceLoading(false), 45000);
        }
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
              // Peel the persisted ActionHistory blob off the project
              // before loadProject (which mints a fresh history). We
              // re-hydrate it onto the just-installed history below.
              // Without this, undo/redo + named snapshots from the
              // prior session are silently lost on every reload —
              // breaking chat-message rollback (the snapshot's
              // stackIndex is for the OLD history, the new one is
              // empty, and restoreSnapshot quietly no-ops).
              const persistedHistory = (project as any).__historyData as string | undefined;
              if ((project as any).__historyData) delete (project as any).__historyData;
              /**
               * WHICH STORYBOARD THIS FILM CAME FROM.
               *
               * Peeled off exactly like the history above, and for the same
               * reason: `Project` is openreel's own type and Voidspace
               * provenance does not belong in it. Kept in a module ref rather
               * than state because nothing re-renders on it — it is answered
               * on demand through `get-state`, so the host page can offer a way
               * back to the board without having to look one up.
               */
              const boardId = (project as any).__sourceBoardId as string | undefined;
              if ((project as any).__sourceBoardId) delete (project as any).__sourceBoardId;
              if (boardId) sourceBoardIdRef.current = boardId;
              loadProject(project);
              if (persistedHistory) {
                try {
                  const h = useProjectStore.getState().actionHistory as any;
                  if (h && typeof h.restore === "function") {
                    h.restore(JSON.parse(persistedHistory));
                    console.log(`[Voidspace] Restored ActionHistory (${persistedHistory.length}b)`);
                  }
                } catch (e) {
                  console.warn("[Voidspace] history restore failed, starting fresh:", e);
                }
              }
              navigate("editor");
              // The project is actually on screen now — drop the spinner
              // (deferred from the finally for the subscription path).
              setVoidspaceLoading(false);
              console.log(
                `[Voidspace] Loaded project: ${project.name} (${project.mediaLibrary.items.length} media items)`,
              );
              // Re-attach recording / imported-media blobs (library items
              // carry only metadata + originalUrl after a JSON round-trip).
              void hydrateLibraryMediaBlobs();
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
              // New library media arrived via the live subscription (e.g. a
              // recording whose project_state landed after the initial load)
              // carries originalUrl but no blob. Re-attach blobs from
              // IndexedDB/disk so it isn't a broken, contentless asset card.
              if (result.newMedia > 0) void hydrateLibraryMediaBlobs();
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

        // Save-on-leave. Autosave runs on a 30s interval + 2s debounce, so
        // edits made in the last couple of seconds before the user closes
        // the tab (or switches away on mobile) were lost remotely — they
        // survived only in this device's IndexedDB. `visibilitychange →
        // hidden` is the RELIABLE hook: it fires while the page is still
        // alive (tab switch, app background), so the postMessage→parent→
        // Firestore round-trip completes. `pagehide` is the best-effort
        // last-gasp on actual close. We only flush when genuinely dirty so
        // a tab switch doesn't write to Firestore needlessly.
        if (typeof document !== "undefined") {
          const flushOnLeave = () => {
            try {
              if (!autoSaveManager.hasUnsavedChanges) return;
              const proj = useProjectStore.getState().project;
              if (proj) void autoSaveManager.forceSave(proj);
            } catch {
              /* best-effort — never block unload */
            }
          };
          const onVisibility = () => {
            if (document.visibilityState === "hidden") flushOnLeave();
          };
          document.addEventListener("visibilitychange", onVisibility);
          window.addEventListener("pagehide", flushOnLeave);
          // Fold the listener teardown into the same beforeunload cleanup.
          window.addEventListener(
            "beforeunload",
            () => {
              document.removeEventListener("visibilitychange", onVisibility);
              window.removeEventListener("pagehide", flushOnLeave);
            },
            { once: true },
          );
        }
      } catch (err) {
        console.error("[Voidspace] Failed to load scene list:", err);
        setVoidspaceError(
          err instanceof Error ? err.message : "Failed to load project",
        );
        setVoidspaceLoading(false);
      } finally {
        // Subscription path: the first tick (or the 45s safety net) clears
        // the spinner once tracks are actually visible — not install time.
        if (!spinnerClearedByFirstTick) setVoidspaceLoading(false);
      }
    })();
  }, [forceSave, loadProject, navigate]);

  useKieAIPoller();

  // ── Theme sync with the Voidspace site ──
  //
  // The site's light/dark toggle is the single source of truth — the editor's
  // own Sun/Moon control was removed. Three channels, in order of authority:
  //   1. ?theme=light|dark — an embedding host stating it outright
  //   2. the site's saved preference in localStorage (SAME ORIGIN as /studio/)
  //   3. window.postMessage({type:'voidspace:theme', mode}) on later changes
  //
  // (2) is what makes the LANDING pages behave. "Create a video project" opens
  // /studio/?forceWelcome=1 as a top-level navigation — no host, no message, no
  // ?theme — so the welcome screen used to render dark on a light site. It
  // never needed a message: the preference is readable right there.
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
    let stopWatching = () => {};
    try {
      const params = new URLSearchParams(window.location.search);
      applyMode(resolveBootTheme(params.get("theme")));
      // Follow the site if the user flips the toggle in another tab.
      stopWatching = watchSiteTheme(applyMode);
    } catch { /* ignore */ }
    const onMessage = (e: MessageEvent) => {
      const msg: any = e?.data;
      if (!msg || msg.type !== "voidspace:theme") return;
      applyMode(msg.mode);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      stopWatching();
    };
  }, []);

  // ── Editor surface mode (mode=music boots the audio-first skin) ──
  //
  // Read once on mount from the same query the host freezes into the
  // iframe src (/studio/index.html?...&mode=music). The project model is
  // identical in both modes — a music project and a video project are
  // one cross-compatible Project — so this only flips the editor's
  // layout/emphasis: in music mode we promote the audio mixer to a
  // first-class surface. Not persisted (see ui-store).
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const ui = useUIStore.getState();
      if (params.get("mode") === "music") {
        ui.setAppMode("music");
        // Show the audio mixer in the centre column instead of the video
        // player — the video canvas is not what a music project is about.
        //
        // But do NOT collapse the preview row to do it. That is what this used
        // to do, reasoning that "the timeline owns the screen"; collapsing sets
        // timelineHeight to `innerHeight - MIN_CHROME_ABOVE_TIMELINE` (see
        // EditorInterface), which squeezes the mixer, the assets panel and the
        // inspector into a strip and hands the rest of the window to an EMPTY
        // timeline. The editor opened looking broken — everything crushed
        // against the top edge, acres of nothing below.
        //
        // A music project opens with something to look at instead: mixer at a
        // usable height, assets and inspector at full size, timeline at its
        // normal 320. Minimising is still one click away on the grip for anyone
        // who does want the timeline full-height.
        ui.setPreviewCollapsed(false);
        ui.setCenterView("mixer");
      } else {
        ui.setAppMode("video");
        ui.setPreviewCollapsed(false);
        ui.setCenterView("preview");
      }
    } catch {
      /* ignore */
    }
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
          case "voidspace:force-save": {
            // Parent (Voidspace chat page) triggers an immediate save —
            // typically from Ctrl+S. We run autoSaveManager.forceSave
            // which writes IndexedDB AND fires the remote-sync hook
            // (configured in the Voidspace mount path above) to
            // postMessage back voidspace:save-project, completing the
            // round-trip to Firestore.
            try {
              const proj = useProjectStore.getState().project;
              await autoSaveManager.forceSave(proj);
              reply({ type: "voidspace:force-save:done", requestId: msg.requestId, ok: true });
            } catch (err: any) {
              reply({ type: "voidspace:force-save:done", requestId: msg.requestId, ok: false, error: err?.message ?? String(err) });
            }
            break;
          }
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
              // The timeline's own track type is authoritative for the
              // remaining kinds — without this, IMAGE tracks (where stills
              // now land) read back as "video" and the agent can't tell
              // them apart; bare "audio" tracks similarly reported wrong.
              if (tr?.type === 'image') return 'image';
              if (tr?.type === 'audio') return 'music';
              return 'video';
            };
            // Build a mediaId → originalUrl index so the get-state reply
            // includes resolvable URLs on every clip. Without this the
            // page-side merge that mirrors editor state to scene_lists
            // drops SFX clips (which require `clip.url` to bucket into
            // scenes) on Ctrl+S — same gap the iframe Save button used
            // to have before Toolbar.tsx started passing url through.
            const mediaIndex = new Map<string, string>();
            const mediaNameIndex = new Map<string, string>();
            const mediaTypeIndex = new Map<string, string>();
            // Suno lineage per media item. Without this on the wire the agent
            // can never run the Suno-NATIVE ops (stem separation on a Suno
            // track, WAV, timestamped lyrics, persona, native extend) — they
            // all key off taskId+audioId, and read_tracks was the only place
            // the agent could have learned them.
            const mediaSunoIndex = new Map<string, { taskId: string; audioId: string }>();
            /** Which media files are rendered blocks. Read for clips placed
             *  before the clip-level copy existed — the identity has always
             *  been on the file. */
            const mediaGraphicIndex = new Map<string, unknown>();
            for (const m of (proj.mediaLibrary?.items ?? [])) {
              if (m.id && m.originalUrl) mediaIndex.set(m.id, m.originalUrl);
              if (m.id && (m.metadata as any)?.graphic) mediaGraphicIndex.set(m.id, (m.metadata as any).graphic);
              if (m.id && (m as any).name) mediaNameIndex.set(m.id, String((m as any).name));
              if (m.id && (m as any).type) mediaTypeIndex.set(m.id, String((m as any).type));
              const st = (m as any).sunoTaskId, sa = (m as any).sunoAudioId;
              if (m.id && st && sa) mediaSunoIndex.set(m.id, { taskId: String(st), audioId: String(sa) });
            }
            /**
             * Readback sources, built ONCE for the whole reply.
             *
             * The effects live in the EffectsBridge and the retime in the
             * SpeedEngine, so answering "what is on this clip" is a lookup per
             * clip against two singletons. Resolving those singletons once and
             * handing the closures down costs one lookup instead of two per
             * clip on a timeline that can hold hundreds.
             */
            const readbackSrc = readbackSourcesFrom(
              useProjectStore.getState() as unknown as Record<string, unknown>,
              getSpeedEngine(),
            );
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
                /**
                 * TRACK STATE, so the agent can see what the user sees.
                 *
                 * Alternate takes arrive on tracks that are hidden AND muted
                 * (see `voidspace-loader`), which is most of what "there are
                 * three other takes of this shot, off" means. Without these the
                 * agent reads a timeline full of clips with no way to tell which
                 * ones are actually playing — so it would describe a take stack
                 * as duplicate footage, and "unhide Take 2" is not a request it
                 * could even confirm it had carried out.
                 */
                hidden: tr.hidden === true,
                muted: tr.muted === true,
                locked: tr.locked === true,
                clips: (tr.clips ?? []).map((c: any) => ({
                  id: c.id, mediaId: c.mediaId,
                  url: mediaIndex.get(c.mediaId) || '',
                  /**
                   * WHICH SHOT, AND WHICH TAKE OF IT.
                   *
                   * Stamped by the loader from the storyboard's own ids. This is
                   * what turns "recut scene 3 using more of take 2" from a guess
                   * about positions into a lookup — position is exactly what an
                   * edit changes, so an agent inferring from it is wrong the
                   * moment the user moves anything.
                   *
                   * Absent on clips the user dragged in themselves, which is
                   * itself the answer to "where did this come from".
                   */
                  shotId: c.shotId, takeId: c.takeId,
                  // Human-readable identity so the agent can describe what's
                  // on the timeline ("your image d3b5f115….webp") and tell
                  // an IMAGE clip apart from a video on the same track.
                  name: mediaNameIndex.get(c.mediaId) || undefined,
                  kind: mediaTypeIndex.get(c.mediaId) || undefined,
                  startTime: c.startTime, duration: c.duration,
                  inPoint: c.inPoint, outPoint: c.outPoint,
                  volume: c.volume, muted: c.muted,
                  /**
                   * HOW THIS CLIP MEETS THE ONE BELOW IT.
                   *
                   * A graphic overlay arrives on `screen` — its transparent
                   * background reaches the compositor as black, and screen is
                   * what makes that black disappear instead of covering the
                   * shot. An agent that cannot SEE the blend cannot answer "why
                   * is my overlay hiding the video", and would set it a second
                   * time or talk the user out of a clip that is already right.
                   *
                   * Omitted when normal, so an ordinary clip stays the shape it
                   * has always been in this payload.
                   */
                  ...(c.blendMode && c.blendMode !== "normal"
                    ? { blendMode: c.blendMode }
                    : {}),
                  /**
                   * WHICH DESIGNED BLOCK THIS IS, AND WHAT IS IN IT.
                   *
                   * A rendered graphic is an ordinary video file, so without
                   * this the agent reads "a 4.8s clip called lt-clean-bar.webm"
                   * and has no way to answer "change that name to Priya" except
                   * by rendering a new one from scratch and leaving the old one
                   * on the timeline. With it, editing a graphic is a lookup: the
                   * block is named and its current values are right here.
                   */
                  ...(c.metadata?.graphic
                    ? { graphic: c.metadata.graphic }
                    : mediaGraphicIndex.get(c.mediaId)
                      ? { graphic: mediaGraphicIndex.get(c.mediaId) }
                      : {}),
                  // Expose fades + volume automation so the agent can
                  // read current values before adjusting them.
                  fade: c.fade ?? null,
                  automation: c.automation ?? null,
                  // Suno lineage (present only on Suno-generated audio) —
                  // unlocks the native-only transform ops for the agent.
                  sunoTaskId: mediaSunoIndex.get(c.mediaId)?.taskId,
                  sunoAudioId: mediaSunoIndex.get(c.mediaId)?.audioId,
                  /**
                   * WHAT HAS BEEN DONE TO THIS CLIP.
                   *
                   * Effects (with their ids), the grade, the retime, the crop,
                   * what is keyframed. Until this existed every Inspector
                   * surface the agent could drive was WRITE-ONLY: it could
                   * apply a blur and then had no way to see it, remove it
                   * (removal needs the effect id), confirm it landed, or notice
                   * it had already applied the same thing last turn.
                   *
                   * Absent on an untouched clip — `readClipLooks` returns `{}`
                   * and the spread contributes nothing — so a plain timeline
                   * costs exactly what it did before.
                   */
                  ...(() => {
                    const looks = readClipLooks(c as any, readbackSrc);
                    return Object.keys(looks).length > 0 ? { looks } : {};
                  })(),
                })),
                // How the cuts on this track are made. Same rule: omitted
                // entirely when the track has no transitions.
                ...(() => {
                  const trs = readTrackTransitions(tr as any);
                  return trs ? { transitions: trs } : {};
                })(),
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
            // Graphics (shapes / SVGs / stickers) + STT subtitles — the agent
            // must be able to READ everything it can EDIT (the inspector
            // surfaces already target these), so expose them as synthetic
            // tracks alongside media + captions.
            const graphicClips = [
              ...((proj as any).shapeClips ?? []),
              ...((proj as any).svgClips ?? []),
              ...((proj as any).stickerClips ?? []),
            ].map((g: any) => ({
              id: g.id,
              kind: String(g.type || 'graphic'),
              startTime: g.startTime ?? 0,
              duration: g.duration ?? 0,
              endTime: (g.startTime ?? 0) + (g.duration ?? 0),
            }));
            const graphicsTracks = graphicClips.length > 0
              ? [{ id: 'track-graphics', name: 'Graphics', kind: 'graphics' as const, clips: graphicClips }]
              : [];
            const subtitleClips = ((proj as any).subtitles ?? []).map((s: any) => ({
              id: s.id,
              kind: 'subtitle' as const,
              startTime: s.startTime ?? 0,
              duration: Math.max(0, (s.endTime ?? 0) - (s.startTime ?? 0)),
              endTime: s.endTime ?? 0,
              text: typeof s.text === 'string' ? s.text.slice(0, 200) : '',
            }));
            const subtitleTracks = subtitleClips.length > 0
              ? [{ id: 'track-subtitles', name: 'Subtitles', kind: 'subtitles' as const, clips: subtitleClips }]
              : [];
            const allTracksForState = [
              ...mediaTracks, ...captionTracks, ...graphicsTracks, ...subtitleTracks,
            ];
            /**
             * THE DURATION IS DERIVED, NOT REPORTED.
             *
             * ── WHY NOT `timeline.duration` ─────────────────────────────────
             * That field is a stored scalar, written when a clip is ADDED and
             * repaired on load only when it is zero. Nothing recomputes it when
             * a clip is trimmed, retimed, split or deleted — so a project the
             * agent just shortened still claims its old length. Measured: three
             * shots joined to 7.00s, the last retimed to 1.5x (a real 6.00s),
             * and `read_timeline` kept saying 7.00s.
             *
             * The agent does arithmetic with this number — "put the outro at the
             * end", "the cut is 30s over" — so a stale one is not a cosmetic
             * bug, it is wrong placement and a wrong report to the user. The
             * exporter has always computed the real thing (max clip end, see
             * `ExportEngine.calculateTimelineDuration`); this is the same rule
             * over the very clips being handed back in this reply, so what the
             * agent is TOLD and what it is SHOWN can never disagree.
             */
            const derivedDuration = allTracksForState.reduce((max, tk: any) => {
              for (const c of tk.clips ?? []) {
                const end = typeof c.endTime === 'number'
                  ? c.endTime
                  : (Number(c.startTime) || 0) + (Number(c.duration) || 0);
                if (Number.isFinite(end) && end > max) max = end;
              }
              return max;
            }, 0);
            reply({
              type: "voidspace:state",
              requestId: msg.requestId,
              state: {
                id: proj.id,
                name: proj.name,
                settings: proj.settings,
                duration: derivedDuration,
                tracks: allTracksForState,
                /**
                 * NESTED SEQUENCES ON THIS PROJECT.
                 *
                 * A board-compiled film gets one sequence per screenplay
                 * SEQUENCE ("The chase"), holding that stretch's shots, their
                 * narration and their alternate takes — so the structure the
                 * writer intended is on the timeline, not just implied by the
                 * order of the clips.
                 *
                 * The agent could not see any of it. A clip whose picture is a
                 * whole sub-timeline read as an ordinary clip with an
                 * unresolvable mediaId, so "what is in the chase sequence?" was
                 * unanswerable and "trim the chase" meant trimming one shot.
                 * With this plus each clip's `looks.sequenceId`, an instance on
                 * the timeline can be matched to what it contains.
                 *
                 * Names and durations only — the contents are a whole timeline
                 * each, and putting them here would put the film in the payload
                 * twice.
                 */
                ...(() => {
                  const compounds = (proj as any).compoundClips ?? [];
                  if (!Array.isArray(compounds) || compounds.length === 0) return {};
                  return {
                    sequences: compounds.map((c: any) => ({
                      id: c.id,
                      name: c.name,
                      durationSec: c.content?.duration ?? 0,
                      clipCount: (c.content?.clips ?? []).length,
                      trackCount: (c.content?.tracks ?? []).length,
                    })),
                  };
                })(),
                mediaCount: proj.mediaLibrary?.items?.length ?? 0,
                textClipCount: captionClips.length,
                // WHERE THIS FILM CAME FROM. Empty for a project that was not
                // compiled from a storyboard, which is how the host page knows
                // whether a way back exists at all.
                sourceBoardId: sourceBoardIdRef.current || undefined,
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
              // Durable cloud URL for imported/generated assets — `url`/`src`
              // is a local blob: URL that's useless to remote models (Kie),
              // so callers that need a fetchable reference use this instead.
              originalUrl: m.originalUrl ?? null,
              duration: m.duration ?? null,
              width: m.width ?? null,
              height: m.height ?? null,
              hasAudio: m.hasAudio ?? null,
            }));
            reply({ type: "voidspace:media", requestId: msg.requestId, items });
            break;
          }
          case "voidspace:add-media-from-url": {
            // Parent's Add-Media popup (StudioMediaPickerModal) picked/
            // generated/uploaded a media URL and handed it back here.
            // Import it into the asset library via the SAME native path a
            // local upload uses (importMedia decodes the blob → real
            // duration/dimensions/thumbnails/waveform), then tag
            // originalUrl so the item rehydrates from the cloud on reload
            // (the embedded project_state blob can't carry the raw blob).
            // Library-only: we do NOT auto-place it on the timeline — the
            // user drags it in, exactly like an uploaded file.
            /**
             * `graphic` — this URL is a rendered HyperFrames block.
             *
             * Stamped onto the media item below, and that single tag is what
             * makes an agent-placed graphic behave exactly like a dragged one:
             * `clip/add` reads it and gives every clip made from this file its
             * `screen` blend, and the inspector reads it to offer the block's
             * slots for editing. Without it the agent's overlay would arrive as
             * an anonymous video that covers the picture and can never be
             * edited — which is what it used to do.
             */
            const { url, name, graphic } = msg as {
              url?: string;
              name?: string;
              graphic?: { block?: string; slots?: Record<string, string>; mode?: string; aspect?: string };
            };
            if (!url || typeof url !== "string") {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "url required" });
              break;
            }
            const graphicTag =
              graphic && typeof graphic.block === "string" && graphic.block
                ? {
                    block: graphic.block,
                    slots: graphic.slots && typeof graphic.slots === "object" ? graphic.slots : {},
                    mode: graphic.mode === "bake" ? ("bake" as const) : ("overlay" as const),
                    ...(graphic.aspect ? { aspect: String(graphic.aspect) } : {}),
                  }
                : null;
            try {
              const { fetchMediaBlob } = await import("./services/voidspace-loader");
              const blob = await fetchMediaBlob(url);
              if (!blob) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: "could not fetch media" });
                break;
              }
              const fname =
                (typeof name === "string" && name) ||
                url.split("/").pop()?.split("?")[0] ||
                "imported-media";
              const file = new File([blob], fname, { type: blob.type || "application/octet-stream" });
              const result = await importMedia(file);
              if (result.success && result.actionId) {
                // Tag originalUrl on the freshly-imported item so a reload
                // rehydrates it from the cloud URL instead of a dropped blob.
                useProjectStore.setState((s: any) => ({
                  project: {
                    ...s.project,
                    mediaLibrary: {
                      ...s.project.mediaLibrary,
                      items: (s.project.mediaLibrary?.items ?? []).map((m: any) =>
                        m.id === result.actionId
                          ? {
                              ...m,
                              originalUrl: m.originalUrl ?? url,
                              category: m.category ?? (graphicTag ? "Graphics" : "Imported"),
                              ...(graphicTag
                                ? { metadata: { ...m.metadata, graphic: graphicTag } }
                                : {}),
                            }
                          : m,
                      ),
                    },
                    modifiedAt: Date.now(),
                  },
                }));
                reply({ type: "voidspace:media-added", requestId: msg.requestId, ok: true, mediaId: result.actionId });
              } else {
                const e: any = result.error;
                reply({ type: "voidspace:error", requestId: msg.requestId, error: e?.message ?? "import failed" });
              }
            } catch (err: any) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: err?.message ?? String(err) });
            }
            break;
          }
          case "voidspace:add-text-clip": {
            // Agent-authored text/captions. Routes through the store's
            // addSubtitle — the SAME primitive the pipeline captions use:
            // find-or-creates the canonical `track-captions` track, styles
            // virally, and supports per-word karaoke timing (words[] with
            // ABSOLUTE start/end seconds → kinetic word-highlight), which is
            // exactly what lyric-timed music-video captions need.
            const { text, startTime, durationSec, words, animationStyle } = msg as {
              text?: string; startTime?: number; durationSec?: number;
              words?: Array<{ text: string; start: number; end: number }>;
              animationStyle?: string;
            };
            if (typeof text !== "string" || !text.trim() || typeof startTime !== "number") {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "text and startTime required" });
              break;
            }
            try {
              const endTime = startTime + (typeof durationSec === "number" && durationSec > 0 ? durationSec : 3);
              await useProjectStore.getState().addSubtitle({
                id: `agent-text-${Date.now().toString(36)}`,
                text: text.trim(),
                startTime,
                endTime,
                ...(Array.isArray(words) && words.length > 0
                  ? {
                      words: words
                        .filter((w) => w && typeof w.text === "string")
                        .map((w) => ({ text: w.text, startTime: Number(w.start) || 0, endTime: Number(w.end) || 0 })),
                    }
                  : {}),
                ...(typeof animationStyle === "string" ? { animationStyle } : {}),
              } as any);
              // addSubtitle doesn't return the clip — resolve it for the agent
              // so follow-up styling (apply_inspector_tool) can target it.
              const titleEng = useEngineStore.getState().getTitleEngine();
              const createdClip = (titleEng?.getAllTextClips() ?? [])
                .filter((tc: any) => Math.abs((tc.startTime ?? 0) - startTime) < 0.05 && tc.text === text.trim())
                .pop();
              reply({
                type: "voidspace:text-clip-added",
                requestId: msg.requestId,
                ok: true,
                clipId: createdClip?.id ?? null,
                trackId: "track-captions",
              });
            } catch (err: any) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: err?.message ?? String(err) });
            }
            break;
          }
          case "voidspace:materialize-media": {
            // Turn a LOCAL-ONLY media item (a webcam clip the user recorded or
            // dragged in — bytes live only as a Blob in IndexedDB, no server
            // URL) into a durable /api/studio/local-asset URL that server-side
            // agent tools (transcribe / build_scenes_from_recording / Seedance
            // reference) can actually read. Idempotent: if the item already has
            // a reachable originalUrl we return it and never re-upload.
            const { mediaId } = msg as { mediaId?: string };
            if (!mediaId || typeof mediaId !== "string") {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "mediaId required" });
              break;
            }
            try {
              const proj = useProjectStore.getState().project;
              const item: any = (proj.mediaLibrary?.items ?? []).find((m: any) => m.id === mediaId);
              if (!item) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: "no media found for that id" });
                break;
              }
              // Already server-reachable (durable disk/cloud URL)? Reuse it.
              const existing = typeof item.originalUrl === "string" ? item.originalUrl : "";
              const reachable = !!existing && (/^https?:\/\//i.test(existing) || existing.includes("/api/studio/local-asset"));
              if (reachable) {
                reply({ type: "voidspace:media-materialized", requestId: msg.requestId, ok: true, url: existing, durationSec: item.duration ?? null, alreadyUploaded: true });
                break;
              }
              const blob = await loadMediaBlobForProject(useProjectStore.getState().project.id, mediaId);
              if (!blob) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: "media bytes not found in local storage" });
                break;
              }
              // Pick a sane file extension from the item name / blob mime.
              const guessExt = (): string => {
                const fromName = String(item.name || "").split(".").pop() || "";
                if (fromName && fromName !== item.name && /^[a-z0-9]{2,5}$/i.test(fromName)) return fromName.toLowerCase();
                const t = String(blob.type || item.mimeType || "").toLowerCase();
                if (t.includes("webm")) return "webm";
                if (t.includes("mp4")) return "mp4";
                if (t.includes("quicktime") || t.includes("mov")) return "mov";
                if (t.includes("wav")) return "wav";
                if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
                if (t.includes("ogg")) return "ogg";
                return "webm"; // webcam/screen MediaRecorder default
              };
              const { saveMediaToDisk } = await import("./services/recording-save");
              const saved = await saveMediaToDisk(blob, item.name || "recording", guessExt(), "recordings");
              if (!saved?.url) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: "Could not save the clip. Open and save the project first, then try again." });
                break;
              }
              // Tag originalUrl so a reload rehydrates from disk, not the blob.
              useProjectStore.setState((s: any) => ({
                project: {
                  ...s.project,
                  mediaLibrary: {
                    ...s.project.mediaLibrary,
                    items: (s.project.mediaLibrary?.items ?? []).map((m: any) =>
                      m.id === mediaId ? { ...m, originalUrl: m.originalUrl ?? saved.url } : m,
                    ),
                  },
                  modifiedAt: Date.now(),
                },
              }));
              reply({ type: "voidspace:media-materialized", requestId: msg.requestId, ok: true, url: saved.url, durationSec: item.duration ?? null, alreadyUploaded: false });
            } catch (err: any) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: err?.message ?? String(err) });
            }
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

            // Text-clip (caption) path. Routes through the project-
            // store wrapper so the change enters ActionHistory and is
            // both manually undoable AND covered by the chat's named
            // snapshot revert. Bypassing the wrapper (calling
            // titleEngine.updateTextClip directly, as we used to)
            // skipped history entirely — caption changes were
            // unrecoverable via undo OR snapshot restore.
            const titleEngPatch = useEngineStore.getState().getTitleEngine();
            const textClip = titleEngPatch?.getTextClip(clipId);
            if (textClip) {
              const updates: Record<string, unknown> = {};
              if (typeof patch.startTime === "number") updates.startTime = patch.startTime;
              if (typeof patch.duration === "number") updates.duration = Math.max(0.05, patch.duration);
              if (Object.keys(updates).length === 0) {
                reply({ type: "voidspace:clip-patched", requestId: msg.requestId, clip: textClip, ok: true });
                break;
              }
              const r = await (useProjectStore.getState() as any).updateTextClip(clipId, updates);
              const updated = useEngineStore.getState().getTitleEngine()?.getTextClip(clipId) ?? null;
              if (!r?.success) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: r?.error?.message ?? "updateTextClip failed" });
                break;
              }
              reply({
                type: "voidspace:clip-patched",
                requestId: msg.requestId,
                clip: updated,
                ok: true,
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
          // voidspace:apply-transition removed (2026-05-09).
          // Transitions are now reachable through the generic
          // voidspace:apply-inspector-tool RPC with surface =
          // "entry-exit-transitions". The chat agent migrated to the
          // discovery triplet (list/get-schema/apply); the old single-
          // purpose tool is gone with its bridge-coupled implementation.
          case "voidspace:add-clip": {
            const { trackId, mediaId, duration } = msg as any;
            /**
             * `startTime: "end"` — APPEND, and let the editor do the arithmetic.
             *
             * ── WHY THIS IS NOT THE CALLER'S JOB ──────────────────────────────
             * "Merge these three clips" is the single most ordinary request a
             * video tool gets, and as a numeric API it is three calls where each
             * one's position depends on the PREVIOUS clip's real decoded
             * duration — which the caller only learns from the reply it has not
             * received yet. So the agent either reads the timeline between every
             * placement, or it guesses and lands clips on top of one another.
             * Overlapping clips do not look like an error; they look like the
             * second shot never imported.
             *
             * This is the same reasoning that made `trim_silence` a macro rather
             * than exposing the out-point arithmetic: the editor already knows
             * the answer, so it should be the one to compute it.
             *
             * Appends after the last clip ON THE TRACK IT CHOOSES, so a video
             * and a music bed appended in the same breath do not stack.
             */
            const rawStart = (msg as any).startTime;
            const isAppend = rawStart === "end" || (msg as any).append === true;
            if (!mediaId || (!isAppend && typeof rawStart !== "number")) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "mediaId, and startTime (a number, or \"end\" to append) required" });
              break;
            }
            const store = useProjectStore.getState();
            /**
             * The tool's vocabulary, mapped onto UPSTREAM's `Track.role` union
             * and the name a person reads. Two columns because they answer
             * different questions: `role` is what code matches on (auto-duck
             * looks for dialogue), the name is what the timeline shows.
             *
             * `voice` → `dialogue` and `sfx` → `effects` are the only renames;
             * the tool's enum shipped first and stays as it is, because a
             * caller should not have to learn our storage names.
             */
            const ROLE_TRACK_NAME: Record<string, string> = {
              voice: "Dialogue",
              music: "Music",
              sfx: "SFX",
              ambience: "Ambience",  // an sfx bed that runs under a whole scene
              video: "Video",
              image: "Images",
              text: "Captions",
              graphics: "Graphics",
            };
            const ROLE_TRACK_ROLE: Record<string, string> = {
              voice: "dialogue",
              music: "music",
              sfx: "effects",
              ambience: "ambience",
              text: "captions",
              video: "general",
              image: "general",
              graphics: "general",
            };
            const role = typeof (msg as any).role === "string"
              ? (msg as any).role.trim().toLowerCase() : "";
            let startTime: number = isAppend ? 0 : (rawStart as number);
            // Resolve the target track. Explicit trackId wins; otherwise
            // auto-pick a type-compatible track with a free slot at
            // [startTime, startTime+duration), creating one when none
            // exists — so agents can place media without knowing track ids.
            let targetTrackId: string = typeof trackId === "string" ? trackId : "";
            /**
             * `track-music` IS THE PROJECT'S BACKGROUND MUSIC, NOT A SPARE TRACK.
             *
             * It is rebuilt from `slData.music_url` on every load and rewritten
             * whenever the BGM is swapped, so a foley hit placed here does not
             * merely sit in an odd place — it gets its media repointed at the
             * song, or vanishes on the next load. Both look like the sound
             * failing to generate.
             *
             * A caller cannot be expected to know that from the track list,
             * where it looks like any other audio track. So say it here, name
             * the fix, and let the role router pick a real track instead.
             */
            if (targetTrackId === "track-music") {
              reply({
                type: "voidspace:error",
                requestId: msg.requestId,
                error: "\"track-music\" is the project BACKGROUND MUSIC track and has a single owner: "
                  + "it is rebuilt from the project music on every load, and swapping the music rewrites "
                  + "the clips on it. Any other media placed there loses its own audio or disappears. "
                  + "Omit trackId and pass a role (voice / ambience / sfx / music) — the right track is "
                  + "chosen, and created if needed. Background music itself arrives through create_media, "
                  + "not through this call.",
              });
              break;
            }
            /**
             * For an append we must choose the track BEFORE computing the time,
             * because "the end" means the end OF THAT TRACK. Doing it the other
             * way round (the free-slot probe below, run at t=0) would pick the
             * first track that happens to be empty at zero and append there —
             * so a second video would land on a fresh track instead of after
             * the first, and the two would play on top of each other.
             */
            if (isAppend && !targetTrackId) {
              const media: any = store.getMediaItem(mediaId);
              if (!media) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: "no media found for that id" });
                break;
              }
              const wantTypes: string[] = media.type === "audio" ? ["audio"]
                : media.type === "image" ? ["image"] : ["video"];
              const tracks = store.project.timeline?.tracks ?? [];
              // The track of the right kind that already holds the most work is
              // the one a person means by "after that". A brand-new empty track
              // of the right type is the fallback.
              const candidates = tracks.filter((t: any) => wantTypes.includes(t.type));
              const withClips = candidates.filter((t: any) => (t.clips ?? []).length > 0);
              const chosen = withClips.length > 0
                ? withClips.reduce((a: any, b: any) => {
                    const endOf = (t: any) => Math.max(0, ...(t.clips ?? []).map((c: any) => c.startTime + c.duration));
                    return endOf(b) > endOf(a) ? b : a;
                  })
                : candidates[0];
              if (chosen) {
                targetTrackId = chosen.id;
                startTime = Math.max(0, ...(chosen.clips ?? []).map((c: any) => c.startTime + c.duration), 0);
              }
              // No compatible track at all → fall through to the creation path
              // below with startTime 0, which is the correct end of an empty
              // timeline anyway.
            }
            if (!targetTrackId) {
              const media: any = store.getMediaItem(mediaId);
              if (!media) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: "no media found for that id" });
                break;
              }
              const mType = media.type;
              // Images go on IMAGE tracks only (never video tracks) — same
              // routing the timeline drop handler enforces.
              const wantTypes: string[] = mType === "audio" ? ["audio"] : mType === "image" ? ["image"] : ["video"];
              const estDur = (typeof duration === "number" && duration > 0)
                ? duration
                : (Number(media.metadata?.duration) || Number(media.duration) || 5);
              const tracks = store.project.timeline?.tracks ?? [];
              const vacant = (t: any) => !(t.clips ?? []).some(
                (c: any) => c.startTime < startTime + estDur && c.startTime + c.duration > startTime);
              /**
               * ── A ROLE ROUTES, IT DOES NOT ONLY LABEL ────────────────────
               *
               * Naming a track was not enough. The picker below takes the first
               * type-compatible track with a free slot, so a foley hit dropped
               * into the gap between two ambience beds and landed on the
               * Ambience track — correct by type, wrong by kind, and it breaks
               * the one rule that makes the rest work: every later decision is
               * PER TRACK. You duck a track, reverb a track, ride a track. Four
               * kinds sharing one can only be changed together.
               *
               * So a clip that says what it IS goes to the track for that kind,
               * and gets a new one when that track is busy rather than
               * borrowing a neighbour's. Falls through to the ordinary picker
               * when no role was given, which is every existing caller.
               */
              const roleName = ROLE_TRACK_NAME[role] ?? "";
              if (roleName) {
                const sameRole = tracks.filter(
                  (t: any) => wantTypes.includes(t.type) && t.name === roleName);
                const freeSameRole = sameRole.find(vacant);
                if (freeSameRole) {
                  targetTrackId = freeSameRole.id;
                } else {
                  // A track of this kind exists but is busy here, or there is
                  // none yet. Either way this clip needs its own.
                  const trackType = (mType === "audio" ? "audio" : mType === "image" ? "image" : "video") as any;
                  /**
                   * TAKE THE TRACK WE JUST MADE, NOT THE FIRST EMPTY ONE.
                   *
                   * This searched for any empty track of the right type, which is
                   * a different track whenever the project already had one — and
                   * an audio project always does ("Background Music" starts empty).
                   * So the clip went onto THAT, the pre-existing track got RENAMED
                   * to the role, and the track this branch had just created was
                   * left behind empty. Measured: placing four roled clips answered
                   * `trackName: "SFX"` with `trackId: "track-music"`, renamed the
                   * music track, and littered the timeline with empty "Audio 6",
                   * "Audio 7", "Audio 8", "Audio 9".
                   *
                   * Diffing the ids is the only way to be sure which one is ours:
                   * "empty and of the right type" describes the new track and an
                   * unknown number of innocent bystanders.
                   */
                  const beforeIds = new Set(
                    (useProjectStore.getState().project.timeline?.tracks ?? []).map((t: any) => t.id));
                  const tRes = await store.addTrack(trackType);
                  if (tRes.success) {
                    const fresh = (useProjectStore.getState().project.timeline?.tracks ?? [])
                      .find((t: any) => !beforeIds.has(t.id));
                    if (fresh) {
                      targetTrackId = fresh.id;
                      try { useProjectStore.getState().renameTrack(fresh.id, roleName, ROLE_TRACK_ROLE[role] as never); }
                      catch { /* non-fatal */ }
                    }
                  }
                }
              }
              const free = targetTrackId ? null : tracks.find((t: any) =>
                wantTypes.includes(t.type) && vacant(t));
              if (free) {
                targetTrackId = free.id;
              } else {
                const trackType = (mType === "audio" ? "audio" : mType === "image" ? "image" : "video") as any;
                // Same id-diff as the role branch above, for the same reason: the
                // first EMPTY track of a type is very often not the one we made.
                const beforeIds2 = new Set(
                  (useProjectStore.getState().project.timeline?.tracks ?? []).map((t: any) => t.id));
                const tRes = await store.addTrack(trackType);
                if (!tRes.success) {
                  reply({ type: "voidspace:error", requestId: msg.requestId, error: "could not create a track for that media type" });
                  break;
                }
                const fresh = (useProjectStore.getState().project.timeline?.tracks ?? [])
                  .find((t: any) => !beforeIds2.has(t.id));
                if (!fresh) {
                  reply({ type: "voidspace:error", requestId: msg.requestId, error: "track created but not found" });
                  break;
                }
                targetTrackId = fresh.id;
              }
            }
            /**
             * ── NAME THE TRACK FROM WHAT IT HOLDS ────────────────────────────
             *
             * `addTrack` names by type and ordinal — "Audio 1", "Audio 2" —
             * which is the only thing it CAN do, because it is told a TYPE and
             * a type is not a role: dialogue, an ambience bed and a score are
             * all `audio`. The caller knows which, and had nowhere to say so.
             *
             * Not cosmetic. `auto-duck` finds speech BY TRACK NAME, so a voice
             * sitting on "Audio 1" is invisible to it and the music never ducks
             * — no error anywhere, just a mix that is quietly wrong. And a
             * person opening a four-track episode has to solo each one to learn
             * what it is.
             *
             * The ROLE is the product's existing media vocabulary — the same
             * `voice | music | sfx | video | image` the library filters by — so
             * nothing new is invented and every track ends up with the same
             * name for the same kind of content, across every project. A free
             * text field would have given three agents three spellings of
             * "Dialogue" and left `auto-duck` matching some of them.
             *
             * ONLY RENAMES A DEFAULT. A track the user has already named is
             * theirs, and an agent placing a clip must not relabel their work.
             */
            const wantName = ROLE_TRACK_NAME[role] ?? "";
            if (wantName) {
              const cur = useProjectStore.getState().project.timeline?.tracks
                ?.find((t: any) => t.id === targetTrackId);
              const isDefaultName = !cur?.name
                || /^(audio|video|image|text|graphics)\s*\d*$/i.test(String(cur.name).trim());
              if (cur && isDefaultName && cur.name !== wantName) {
                try { useProjectStore.getState().renameTrack(targetTrackId, wantName, ROLE_TRACK_ROLE[role] as never); }
                catch { /* non-fatal: the clip still belongs there */ }
              }
            }

            const r = await useProjectStore.getState().addClip(targetTrackId, mediaId, startTime, typeof duration === "number" && duration > 0 ? duration : undefined);
            if (!r.success) {
              const e: any = r.error;
              const errStr = e && typeof e === "object" ? `${e.code ?? "ERROR"}: ${e.message ?? "addClip failed"}` : (typeof e === "string" ? e : "addClip failed");
              reply({ type: "voidspace:error", requestId: msg.requestId, error: errStr });
              break;
            }
            // Look up the just-created clip — it's the newest one on
            // the track at the requested startTime.
            const tr = useProjectStore.getState().project.timeline?.tracks?.find((t: any) => t.id === targetTrackId);
            const newClip = (tr?.clips ?? []).find((c: any) => c.startTime === startTime && c.mediaId === mediaId);
            // Optional blend mode (AE decorative overlays composite via
            // screen/add so black is transparent) — set it on the fresh clip.
            const { blendMode } = msg as { blendMode?: string };
            if (newClip?.id && typeof blendMode === "string" && blendMode && blendMode !== "normal") {
              try { useProjectStore.getState().updateClipBlendMode(newClip.id, blendMode as any); } catch { /* non-fatal */ }
            }
            reply({
              type: "voidspace:clip-added", requestId: msg.requestId,
              clip: newClip ?? null, ok: true, trackId: targetTrackId,
              // What the track is CALLED, so the caller can say where it put
              // things and can point `auto-duck` at the right one by id.
              trackName: useProjectStore.getState().project.timeline?.tracks
                ?.find((t: any) => t.id === targetTrackId)?.name ?? "",
              // Where it landed and how long it is. The caller of an append did
              // not choose the position, so echoing it back is what lets the
              // next append (or a transition on the join) be reasoned about
              // without a second round trip to read the timeline.
              startTime: newClip?.startTime ?? startTime,
              endTime: (newClip?.startTime ?? startTime) + (newClip?.duration ?? 0),
              appended: isAppend,
            });
            break;
          }
          case "voidspace:add-slide": {
            // Thin convenience alias for NORMAL image-clip placement — a
            // "slideshow" is just image clips. Places one image on a reused (or
            // new-on-overlap) image track, atomically, with an optional gentle
            // Ken-Burns zoom + cover fit. For crossfades, overlap clips and use
            // the normal transition tools.
            const { mediaId, url, name, startTime, durationSec, zoom, fadeInSec, fitMode } = msg as any;
            if (!mediaId && !url) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "add-slide needs a mediaId or url" });
              break;
            }
            try {
              const { addSlide } = await import("./services/image-slide");
              const res = await addSlide({ mediaId, url, name, startTime, durationSec, zoom, fadeInSec, fitMode });
              if (!res.ok) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: res.error || "add-slide failed" });
                break;
              }
              reply({ type: "voidspace:slide-added", requestId: msg.requestId, ...res });
            } catch (err) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: String((err as any)?.message ?? err) });
            }
            break;
          }
          case "voidspace:add-sfx-clip": {
            // Agent-side SFX placement: fetch the URL, register it as a
            // MediaItem if not already present, then dispatch the
            // ActionExecutor's addClip so the placement enters
            // ActionHistory (= user-undoable + chat-snapshot-captured).
            // No bypass paths: the editor's own action loop is the
            // single source of truth, autosave commits the blob.
            const { url, startTime, duration, volume, label } = msg as any;
            if (!url || typeof startTime !== "number" || typeof duration !== "number") {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "url + startTime + duration required" });
              break;
            }
            try {
              const proj = useProjectStore.getState().project;
              // Hash the URL to a stable mediaId so the same SFX file
              // reused across multiple scenes doesn't multiply media-
              // library entries (matches voidspace-loader's pattern).
              const stableHashFn = (s: string) => {
                let h = 0;
                for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
                return Math.abs(h).toString(36);
              };
              const sfxMediaId = `media-sfx-${stableHashFn(url)}`;
              let item = proj.mediaLibrary?.items?.find((m: any) => m.id === sfxMediaId);
              if (!item) {
                // Fetch the audio blob so the export-time engine can
                // decode it; without a blob the renderer silently drops
                // the clip (verified bug from earlier in this project).
                // Kie temp URLs (tempfile.redpandaai.co) serve NO CORS header,
                // so a direct cross-origin fetch from this iframe throws and
                // we'd never get the bytes to persist. Route through the
                // same-origin media-proxy (allow-lists the Kie hosts) so the
                // fetch succeeds and we can save it to IndexedDB + disk.
                let sfxBlob: Blob | null = null;
                const fetchUrl = /^https?:\/\//i.test(url) && !url.startsWith(window.location.origin)
                  ? `/api/studio/media-proxy?url=${encodeURIComponent(url)}`
                  : url;
                try {
                  const r = await fetch(fetchUrl);
                  if (r.ok) sfxBlob = await r.blob();
                } catch { /* network blip; clip will still mount, blob hydrates later */ }
                // Persist the SFX so it survives reload + Kie's 3-day TTL,
                // DISK-ONLY (zero Firebase — SFX is small and only matters for
                // the creator + a buyer's re-render, which publish materializes
                // from the timeline). Two local layers, mirroring how an
                // imported file is saved (openreel native save):
                //   1. IndexedDB blob (saveMediaBlob) — the openreel media store
                //      keyed by mediaId; hydrateLibraryMediaBlobs restores it.
                //   2. The user's disk folder via save-render?kind=sfx (sfx/),
                //      and we repoint originalUrl at that durable local-asset URL
                //      so a reload after the Kie link dies still resolves.
                let durableUrl = url;
                if (sfxBlob) {
                  try {
                    const { saveMediaBlob } = await import("./services/media-storage");
                    await saveMediaBlob(proj.id, sfxMediaId, sfxBlob, {
                      duration, fileSize: sfxBlob.size, sampleRate: 44100, channels: 2,
                    } as any);
                  } catch (e) { console.warn("[sfx] IndexedDB save failed:", e); }
                  try {
                    const { saveMediaToDisk } = await import("./services/recording-save");
                    const ext = (sfxBlob.type || "").includes("wav") ? "wav" : "mp3";
                    const saved = await saveMediaToDisk(
                      sfxBlob,
                      typeof label === "string" && label ? label : "sfx",
                      ext,
                      "sfx",
                    );
                    if (saved?.url) durableUrl = saved.url; // /api/studio/local-asset?...&kind=sfx
                  } catch (e) { console.warn("[sfx] disk save failed:", e); }
                }
                const newItem: any = {
                  id: sfxMediaId,
                  name: typeof label === "string" && label ? label : "SFX",
                  type: "audio",
                  fileHandle: null,
                  blob: sfxBlob,
                  metadata: { duration, fileSize: sfxBlob?.size ?? 0, sampleRate: 44100, channels: 2 },
                  thumbnailUrl: null,
                  waveformData: null,
                  originalUrl: durableUrl,
                  category: "SFX",
                  role: "sfx",
                };
                useProjectStore.setState((s: any) => ({
                  project: {
                    ...s.project,
                    mediaLibrary: {
                      ...s.project.mediaLibrary,
                      items: [...(s.project.mediaLibrary?.items ?? []), newItem],
                    },
                    modifiedAt: Date.now(),
                  },
                }));
                item = newItem;
              }
              // Ensure the dedicated SFX track exists. voidspace-loader only
              // creates `track-sfx` when the project ALREADY had SFX clips, so
              // the first SFX added to a fresh project would fail addClip with
              // "Track with ID track-sfx not found" (the generated SFX would be
              // saved but never placed). addTrack() mints a random id, so we
              // push the fixed-id track directly, matching the loader's shape.
              {
                const cur = useProjectStore.getState().project;
                const hasSfxTrack = (cur.timeline?.tracks ?? []).some((t: any) => t.id === "track-sfx");
                if (!hasSfxTrack) {
                  useProjectStore.setState({
                    project: {
                      ...cur,
                      timeline: {
                        ...cur.timeline,
                        tracks: [
                          ...(cur.timeline?.tracks ?? []),
                          { id: "track-sfx", type: "audio", name: "SFX", clips: [], transitions: [], locked: false, hidden: false, muted: false, solo: false } as any,
                        ],
                      },
                      modifiedAt: Date.now(),
                    },
                  });
                }
              }
              const ar = await useProjectStore.getState().addClip("track-sfx", sfxMediaId, startTime);
              if (!ar.success) {
                const e: any = ar.error;
                const errStr = e && typeof e === "object" ? `${e.code ?? "ERROR"}: ${e.message ?? "addClip failed"}` : (typeof e === "string" ? e : "addClip failed");
                reply({ type: "voidspace:error", requestId: msg.requestId, error: errStr });
                break;
              }
              // Locate the new clip + apply duration/volume via the
              // executor so they're part of the same ActionHistory
              // entry (one undo step covers the full placement).
              const tr = useProjectStore.getState().project.timeline?.tracks?.find((t: any) => t.id === "track-sfx");
              const newClip = (tr?.clips ?? []).find((c: any) => c.mediaId === sfxMediaId && c.startTime === startTime && c.id);
              if (newClip && typeof duration === "number") {
                await useProjectStore.getState().trimClip(newClip.id, 0, duration);
              }
              if (newClip && typeof volume === "number") {
                const volStore = useProjectStore.getState() as any;
                await volStore.actionExecutor.execute({
                  type: "audio/setVolume" as const,
                  id: `vol-${Date.now().toString(36)}`,
                  timestamp: Date.now(),
                  params: { clipId: newClip.id, volume: Math.max(0, Math.min(4, volume)) },
                }, volStore.project);
                useProjectStore.setState({ project: { ...volStore.project, modifiedAt: Date.now() } });
              }
              reply({ type: "voidspace:sfx-clip-added", requestId: msg.requestId, ok: true, clipId: newClip?.id ?? null, mediaId: sfxMediaId });
            } catch (err: any) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: err?.message ?? String(err) });
            }
            break;
          }
          case "voidspace:replace-clip-media": {
            // Used by the chat's "replace on timeline" / regenerate flows
            // (regenerateClip, regenerateVoiceover, replaceOnTimeline).
            // The chat side has a NEW asset URL for an existing clip
            // and needs the editor's project to swap the clip's mediaId
            // to point at the new asset. Without this, the chat writes
            // scene_lists.scene.{video|narration}_url, but the editor's
            // project_state blob still references the old mediaId, so
            // the regen doesn't surface in the timeline.
            //
            // Flow: import the new URL into mediaLibrary (or reuse if
            // already present), then patch the clip's mediaId via the
            // ActionExecutor (so it's undoable). Autosave commits the
            // updated project_state blob. Old media item stays in the
            // library — cheap, and lets undo restore the prior version.
            const { clipId, url, name, posterUrl, durationSec } = msg as any;
            if (!clipId || !url) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "clipId + url required" });
              break;
            }
            try {
              const proj = useProjectStore.getState().project;
              // Locate the clip + infer media kind from its current track.
              let foundClip: any = null;
              let foundTrack: any = null;
              for (const tr of proj.timeline?.tracks ?? []) {
                const c = (tr.clips ?? []).find((cc: any) => cc.id === clipId);
                if (c) { foundClip = c; foundTrack = tr; break; }
              }
              if (!foundClip) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: `no clip with id ${clipId}` });
                break;
              }
              const trackKind = String(foundTrack?.type || foundTrack?.kind || "").toLowerCase();
              const mediaType = trackKind === "video" ? "video" : "audio";
              // Import / reuse media item.
              const stableHashFn = (s: string) => {
                let h = 0;
                for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
                return Math.abs(h).toString(36);
              };
              // Probe a blob's real playable length (so the swap reconciles the
              // clip's trim against the NEW media instead of keeping the old
              // outPoint — which left a black tail / decode-past-EOF when the
              // regen was shorter). Caller may also pass durationSec (the chat
              // already knows it) to skip the probe.
              const probeDuration = (blob: Blob | null): Promise<number> => new Promise((resolve) => {
                if (!blob) return resolve(0);
                let settled = false;
                const el = document.createElement(mediaType === "video" ? "video" : "audio");
                const obj = URL.createObjectURL(blob);
                const done = (d: number) => { if (settled) return; settled = true; try { URL.revokeObjectURL(obj); } catch {} resolve(Number.isFinite(d) && d > 0 ? d : 0); };
                el.preload = "metadata";
                el.onloadedmetadata = () => done(el.duration);
                el.onerror = () => done(0);
                setTimeout(() => done(0), 5000);
                el.src = obj;
              });
              const newMediaId = `media-${trackKind || "asset"}-${stableHashFn(url)}`;
              let item = proj.mediaLibrary?.items?.find((m: any) => m.id === newMediaId);
              // Real length of the swapped-in media (passed value wins, else probe,
              // else fall back to the old clip's duration so nothing breaks).
              let newMediaDuration = (typeof durationSec === "number" && durationSec > 0) ? durationSec : 0;
              if (!item) {
                let blob: Blob | null = null;
                try {
                  const r = await fetch(url);
                  if (r.ok) blob = await r.blob();
                } catch { /* hydrate later */ }
                if (!newMediaDuration) newMediaDuration = await probeDuration(blob);
                const resolvedDur = newMediaDuration || foundClip.duration || 0;
                const newItem: any = {
                  id: newMediaId,
                  name: typeof name === "string" && name ? name : `Replaced ${trackKind || "asset"}`,
                  type: mediaType,
                  fileHandle: null,
                  blob,
                  metadata: { duration: resolvedDur, fileSize: blob?.size ?? 0, sampleRate: 44100, channels: 2 },
                  // Carry the scene's poster (first frame) so the Assets panel
                  // shows a real thumbnail for the regen instead of a blank
                  // placeholder. Falls back to null → placeholder icon.
                  thumbnailUrl: (typeof posterUrl === "string" && posterUrl) ? posterUrl : null,
                  waveformData: null,
                  originalUrl: url,
                  category: trackKind === "video" ? "Scene Videos" : trackKind === "narration" ? "Narration" : "Audio",
                  role: trackKind || "asset",
                };
                useProjectStore.setState((s: any) => ({
                  project: {
                    ...s.project,
                    mediaLibrary: { ...s.project.mediaLibrary, items: [...(s.project.mediaLibrary?.items ?? []), newItem] },
                    modifiedAt: Date.now(),
                  },
                }));
                item = newItem;
              } else if (!newMediaDuration) {
                newMediaDuration = Number(item.metadata?.duration) || 0;
              }
              // KNOWN LIMITATION: this swap bypasses ActionExecutor /
              // ActionHistory because the openreel core doesn't ship a
              // `clip/setMediaId` action type. Consequence: the user
              // can't Ctrl+Z a regen swap (the inverse isn't in
              // history). The agent's regen flow is destructive intent
              // anyway — the user clicked Approve on a regenerated
              // variation, not "tweak this clip". The OLD media item
              // stays in mediaLibrary so a future "revert this regen"
              // tool could swap back without re-fetching. If history
              // round-trip becomes a requirement, add `clip/setMediaId`
              // to packages/core/src/actions and route through
              // actionExecutor.execute here.
              useProjectStore.setState((s: any) => {
                const tracks = (s.project.timeline?.tracks ?? []).map((tr: any) => {
                  if (!(tr.clips ?? []).some((c: any) => c.id === clipId)) return tr;
                  // Free room on THIS track: the clip may grow until the next
                  // clip starts (never overlap, never ripple).
                  const target = (tr.clips ?? []).find((c: any) => c.id === clipId);
                  const nextStart = (tr.clips ?? [])
                    .filter((c: any) => c.id !== clipId && c.startTime > (target?.startTime ?? 0) + 1e-6)
                    .reduce((min: number, c: any) => Math.min(min, c.startTime), Infinity);
                  return {
                    ...tr,
                    clips: (tr.clips ?? []).map((c: any) => {
                      if (c.id !== clipId) return c;
                      // CLEAN SWAP: spread `c` so every prior edit is kept —
                      // effects, audioEffects, transform, volume, fades,
                      // keyframes, startTime — only the media + trim change.
                      const md = newMediaDuration > 0 ? newMediaDuration : (c.outPoint ?? c.duration ?? 0);
                      let inPoint = c.inPoint ?? 0;
                      let outPoint = c.outPoint ?? md;
                      let duration = c.duration;
                      if (md > 0) {
                        inPoint = Math.max(0, Math.min(inPoint, Math.max(0, md - 0.05)));
                        // Was the OLD clip showing its media in full (the
                        // normal scene-take shape), or a deliberate trim?
                        const oldMd = (s.project.mediaLibrary?.items ?? [])
                          .find((m: any) => m.id === c.mediaId)?.metadata?.duration ?? 0;
                        const wasFullTake = oldMd > 0
                          ? inPoint <= 0.05 && (c.outPoint ?? oldMd) >= oldMd - 0.1
                          : true;
                        const room = Number.isFinite(nextStart)
                          ? Math.max(0.05, nextStart - (c.startTime ?? 0))
                          : Infinity;
                        if (wasFullTake) {
                          // Full-take clip stays a full take: a LONGER regen
                          // extends into the free gap (the old min() clamp
                          // silently CUT the tail off longer narrations); a
                          // shorter regen shrinks (no EOF black tail).
                          duration = Math.max(0.05, Math.min(md - inPoint, room));
                          outPoint = inPoint + duration;
                        } else {
                          // User trimmed this clip deliberately — preserve
                          // the window, only clamp to the new media length.
                          outPoint = Math.min(outPoint, md);
                          if (outPoint <= inPoint) outPoint = md;
                          duration = Math.max(0.05, Math.min(outPoint - inPoint, room));
                          outPoint = inPoint + duration;
                        }
                      }
                      return { ...c, mediaId: newMediaId, inPoint, outPoint, duration };
                    }),
                  };
                });
                return { project: { ...s.project, timeline: { ...s.project.timeline, tracks }, modifiedAt: Date.now() } };
              });
              // Record the authoritative swap (keyed on the swapped-to URL, not
              // the mediaId, since a per-scene rebuild mints a different mediaId
              // scheme for the same take) so a stale rebuild can't revert it
              // before the durable source catches up — see liveSwapAuthority.
              recordLiveSwap(clipId, url);
              reply({ type: "voidspace:clip-media-replaced", requestId: msg.requestId, ok: true, clipId, mediaId: newMediaId });
            } catch (err: any) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: err?.message ?? String(err) });
            }
            break;
          }
          case "voidspace:add-bgm-clip": {
            // Chat-side BGM approve / pill audition → add or replace
            // the single BGM clip on track-music. Mirrors the
            // voidspace-loader's bootstrap path so cold load + live
            // commit converge on the same on-timeline shape (one
            // music clip, mediaId stable-hashed from URL, spanning
            // the full video duration, category 'Music' so the
            // Assets panel surfaces it).
            //
            // Idempotent: if the URL has already been registered in
            // the media library, the existing item is reused. If a
            // music clip already exists on the track, its mediaId
            // (and volume) are swapped in place rather than adding
            // a duplicate clip — keeps the timeline shape "one BGM
            // clip per project" that the renderer + voidspace-loader
            // expect. If no clip exists yet, a fresh one is added
            // covering the full timeline duration.
            //
            // Failure mode the chat used to hit: it patched
            // scene_lists.music_url, called pingReload, and counted
            // on the loader to materialise the BGM clip from the
            // scene-list field. But the loader prefers the editor's
            // project_state blob on every reload after the first
            // save — and that blob was captured BEFORE the music_url
            // patch, so the pingReload simply re-rendered the
            // pre-music timeline. This handler is the missing path:
            // the chat now drives the music clip into the live
            // project, and the editor's autosave commits a blob
            // that includes it.
            const { url, volume, label, durationSec, startOffsetSec, mediaDurationSec } = msg as any;
            if (!url) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "url required" });
              break;
            }
            try {
              const proj = useProjectStore.getState().project;
              // Total timeline duration = max end across every
              // non-music, non-sfx track. Music spans the whole
              // video; trimming to that length keeps the loader's
              // collapse-contiguous logic happy and matches the
              // editor's stored shape.
              let totalDur = 0;
              for (const t of (proj.timeline?.tracks ?? []) as any[]) {
                if (t?.id === "track-music" || t?.id === "track-sfx") continue;
                for (const c of (t.clips ?? []) as any[]) {
                  const end = (c.startTime ?? 0) + (c.duration ?? 0);
                  if (end > totalDur) totalDur = end;
                }
              }
              // Tiny fallback so BGM still mounts on a fresh project
              // that has no scene clips yet (rare — the gate fires
              // after scenes are approved). 30s avoids zero-duration
              // clips which break some renderers.
              if (totalDur <= 0) totalDur = 30;
              // Standalone music (mode=music) has no video clips to span —
              // an explicit durationSec (the song's real length) is
              // authoritative so the music clip renders at full width
              // instead of the 30s video fallback.
              if (typeof durationSec === "number" && durationSec > 0) totalDur = durationSec;

              // ── Music-video segment offset ──────────────────────────────
              // For a music video the chosen segment may start mid-song. We
              // place the clip spanning the video on the timeline (startTime 0,
              // length totalDur) but offset its SOURCE window so it plays the
              // song from `offset`. The media item's duration must be the SONG's
              // real length (not the video length) so the source window can be
              // pushed forward — otherwise trimClip rejects an in-point past the
              // (too-short) media. offset=0 + no mediaDurationSec → unchanged
              // behaviour for ordinary BGM.
              const offset = typeof startOffsetSec === "number" && startOffsetSec > 0 ? startOffsetSec : 0;
              const mediaDur = typeof mediaDurationSec === "number" && mediaDurationSec > 0
                ? mediaDurationSec
                : (offset > 0 ? offset + totalDur : totalDur);
              // Source window: [offset, offset+totalDur], clamped to the song.
              const inPt = Math.max(0, Math.min(offset, Math.max(0, mediaDur - 0.5)));
              const outPt = Math.min(inPt + totalDur, mediaDur);

              const stableHashFn = (s: string) => {
                let h = 0;
                for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
                return Math.abs(h).toString(36);
              };
              const newMediaId = `media-music-${stableHashFn(url)}`;

              // Register media library item if not present.
              let item = proj.mediaLibrary?.items?.find((m: any) => m.id === newMediaId);
              if (!item) {
                let blob: Blob | null = null;
                try {
                  const fr = await fetch(url);
                  if (fr.ok) blob = await fr.blob();
                } catch { /* hydrate later if fetch fails — clip still mounts */ }
                const newItem: any = {
                  id: newMediaId,
                  name: typeof label === "string" && label ? label : "Background music",
                  type: "audio",
                  fileHandle: null,
                  blob,
                  metadata: { duration: mediaDur, fileSize: blob?.size ?? 0, sampleRate: 44100, channels: 2 },
                  thumbnailUrl: null,
                  waveformData: null,
                  originalUrl: url,
                  category: "Music",
                  role: "music",
                };
                useProjectStore.setState((s: any) => ({
                  project: {
                    ...s.project,
                    mediaLibrary: { ...s.project.mediaLibrary, items: [...(s.project.mediaLibrary?.items ?? []), newItem] },
                    modifiedAt: Date.now(),
                  },
                }));
                item = newItem;
              }

              // Find existing music clip(s). Expected: 0 or 1 (the
              // loader collapses duplicates). Multi-clip case is
              // handled defensively — every existing clip's media is
              // swapped to the new URL so a stale duplicate doesn't
              // keep auditioning the old track.
              // Ensure the music track EXISTS before we add to it. The loader
              // only materialises track-music once it already has clips ("no
              // empty tracks" — matching Flutter, voidspace-loader.ts), so a
              // fresh video project — or ANY project whose autosaved blob
              // predates its first BGM — has none. addClip("track-music")
              // below would then fail with "Track not found" and the user's
              // approved music would silently never reach the timeline (or the
              // render). Create the canonical empty track first so the add —
              // and every subsequent autosave/rebuild — lands.
              let trMusic = (useProjectStore.getState().project.timeline?.tracks ?? []).find((t: any) => t.id === "track-music");
              if (!trMusic) {
                useProjectStore.setState((s: any) => ({
                  project: {
                    ...s.project,
                    timeline: {
                      ...s.project.timeline,
                      tracks: [
                        ...(s.project.timeline?.tracks ?? []),
                        { id: "track-music", type: "audio", name: "Background Music", clips: [], transitions: [], locked: false, hidden: false, muted: false, solo: false },
                      ],
                    },
                    modifiedAt: Date.now(),
                  },
                }));
                trMusic = (useProjectStore.getState().project.timeline?.tracks ?? []).find((t: any) => t.id === "track-music");
              }
              const existingClips: any[] = trMusic?.clips ?? [];
              const clampedVolume = typeof volume === "number"
                ? Math.max(0, Math.min(4, volume))
                : null;

              let resolvedClipId: string | null = null;

              if (existingClips.length === 0) {
                // No music clip yet — add one spanning the full
                // timeline. The voidspace-loader's fallback path
                // would have done this on cold load if music_url
                // was on scene_lists BEFORE the editor's first
                // autosave; once the blob exists, only this RPC
                // can materialise the clip.
                const ar = await useProjectStore.getState().addClip("track-music", newMediaId, 0);
                if (!ar.success) {
                  const e: any = ar.error;
                  const errStr = e && typeof e === "object" ? `${e.code ?? "ERROR"}: ${e.message ?? "addClip failed"}` : (typeof e === "string" ? e : "addClip failed");
                  reply({ type: "voidspace:error", requestId: msg.requestId, error: errStr });
                  break;
                }
                const newTr = (useProjectStore.getState().project.timeline?.tracks ?? []).find((t: any) => t.id === "track-music");
                const newClip = (newTr?.clips ?? []).find((c: any) => c.mediaId === newMediaId && c.startTime === 0);
                if (newClip) {
                  resolvedClipId = newClip.id;
                  if (totalDur > 0) {
                    // [inPt, outPt] = source window; offset for mid-song segments,
                    // [0, totalDur] for ordinary BGM.
                    await useProjectStore.getState().trimClip(newClip.id, inPt, outPt);
                  }
                  if (clampedVolume !== null) {
                    const volStore = useProjectStore.getState() as any;
                    try {
                      await volStore.actionExecutor.execute({
                        type: "audio/setVolume",
                        id: `vol-${Date.now().toString(36)}`,
                        timestamp: Date.now(),
                        params: { clipId: newClip.id, volume: clampedVolume },
                      }, volStore.project);
                      useProjectStore.setState({ project: { ...volStore.project, modifiedAt: Date.now() } });
                    } catch { /* volume is non-critical; clip still plays at default */ }
                  }
                }
              } else {
                // Replace mediaId on every existing music clip + apply
                // volume in the same setState so the autosave sees one
                // atomic commit. Bypasses ActionExecutor for the
                // same reason replace-clip-media does (no
                // clip/setMediaId action type in core).
                /**
                 * ONLY THE BACKGROUND MUSIC — NOT EVERYTHING PARKED HERE.
                 *
                 * This rewrote `mediaId` on EVERY clip of `track-music`, on the
                 * assumption that anything on that track is background music.
                 * That held while BGM was the only thing that could land there.
                 * It stopped holding the moment a clip could be placed on it by
                 * id — and then swapping the music silently repointed those
                 * clips at the song. Measured: three foley hits (engine off,
                 * indicator, riser) placed on this track all came back carrying
                 * the BGM's mediaId, one of them with the BGM's 39-second
                 * duration. They would have played the music instead of the
                 * sound, and nothing reported anything wrong.
                 *
                 * A BGM clip is one THIS path or the loader made: the loader
                 * names them `clip-music-*`, and the ordinary case is a single
                 * clip that can only be the music. Anything else on this track
                 * belongs to someone else and is left alone.
                 */
                const isBgmClip = (c: any) =>
                  existingClips.length === 1 || String(c?.id ?? "").startsWith("clip-music-");
                useProjectStore.setState((s: any) => {
                  const tracks = (s.project.timeline?.tracks ?? []).map((tr: any) => {
                    if (tr.id !== "track-music") return tr;
                    return {
                      ...tr,
                      clips: (tr.clips ?? []).map((c: any) => (isBgmClip(c) ? {
                        ...c,
                        mediaId: newMediaId,
                        ...(clampedVolume !== null ? { volume: clampedVolume } : {}),
                      } : c)),
                    };
                  });
                  return { project: { ...s.project, timeline: { ...s.project.timeline, tracks }, modifiedAt: Date.now() } };
                });
                const refreshedTr = (useProjectStore.getState().project.timeline?.tracks ?? []).find((t: any) => t.id === "track-music");
                resolvedClipId = (refreshedTr?.clips?.[0]?.id) ?? null;
                // Re-apply the source window so a swapped track honours the
                // (possibly mid-song) segment offset too.
                if (resolvedClipId && totalDur > 0 && (offset > 0 || typeof mediaDurationSec === "number")) {
                  try { await useProjectStore.getState().trimClip(resolvedClipId, inPt, outPt); } catch { /* trim is best-effort on swap */ }
                }
              }

              // Record the authoritative music swap (keyed on the music URL) so
              // the chat's music_url patch (which fires a whole-project rebuild
              // from the still-stale blob ~250ms later) can't revert the BGM
              // clip back to the old track before the durable source catches up
              // — see liveSwapAuthority. Guard ALL existing music clips in the
              // defensive multi-clip case.
              const guardedMusicTr = (useProjectStore.getState().project.timeline?.tracks ?? []).find((t: any) => t.id === "track-music");
              for (const mc of (guardedMusicTr?.clips ?? []) as any[]) recordLiveSwap(mc.id, url);

              reply({ type: "voidspace:bgm-clip-added", requestId: msg.requestId, ok: true, clipId: resolvedClipId, mediaId: newMediaId });
            } catch (err: any) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: err?.message ?? String(err) });
            }
            break;
          }
          case "voidspace:remove-clip": {
            const { clipId } = msg as any;
            if (!clipId) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "clipId required" });
              break;
            }
            // Captions are text clips that live in the title engine, NOT in
            // timeline.tracks[].clips — removeClip is a silent no-op for them.
            // Dispatch exactly like keyboard Delete (useKeyboardShortcuts
            // handleDelete) so the agent's remove_clip deletes a caption through
            // the SAME store action the Inspector / context menu / Delete key
            // use (which also keeps project.textClips in sync). Without this the
            // agent got "clip not found" for caption ids and re-read stale state.
            const _store = useProjectStore.getState();
            if (typeof _store.getTextClip === "function" && _store.getTextClip(clipId)) {
              const deleted = _store.deleteTextClip(clipId);
              if (!deleted) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: "TEXT_CLIP_NOT_FOUND: caption could not be deleted" });
                break;
              }
              reply({ type: "voidspace:clip-removed", requestId: msg.requestId, clipId, ok: true, kind: "caption" });
              break;
            }
            const r = await _store.removeClip(clipId);
            if (!r.success) {
              // r.error is an ActionError object { code, message, details? }.
              // Pass the .message string (with the code prefixed) so the
              // bridge's String() coercion doesn't produce "[object Object]"
              // and the chat agent sees something actionable.
              const e: any = r.error;
              const errStr = e && typeof e === "object"
                ? `${e.code ?? "ERROR"}: ${e.message ?? "removeClip failed"}`
                : (typeof e === "string" ? e : "removeClip failed");
              reply({ type: "voidspace:error", requestId: msg.requestId, error: errStr });
              break;
            }
            reply({ type: "voidspace:clip-removed", requestId: msg.requestId, clipId, ok: true });
            break;
          }
          case "voidspace:split-clip": {
            const { clipId, atSec } = msg as any;
            if (!clipId || typeof atSec !== "number") {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "clipId + atSec required" });
              break;
            }
            const r = await useProjectStore.getState().splitClip(clipId, atSec);
            if (!r.success) {
              const e: any = r.error;
              const errStr = e && typeof e === "object" ? `${e.code ?? "ERROR"}: ${e.message ?? "splitClip failed"}` : (typeof e === "string" ? e : "splitClip failed");
              reply({ type: "voidspace:error", requestId: msg.requestId, error: errStr });
              break;
            }
            reply({ type: "voidspace:ack", requestId: msg.requestId, op: "split-clip", ok: true });
            break;
          }
          case "voidspace:remove-range": {
            // Cut a [startSec, endSec] TIMELINE region out of a clip and ripple
            // the rest left: split at endSec, split the left part at startSec,
            // then ripple-delete the middle. Clips are re-located from LIVE
            // project state after each split, so we never depend on what
            // splitClip returns.
            const { clipId, startSec, endSec } = msg as any;
            if (!clipId || typeof startSec !== "number" || typeof endSec !== "number" || endSec <= startSec) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "clipId + startSec + endSec (endSec>startSec) required" });
              break;
            }
            const trackOf = (cid: string) =>
              useProjectStore.getState().project.timeline.tracks.find((t: any) => t.clips.some((c: any) => c.id === cid));
            const track0 = trackOf(clipId);
            if (!track0) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "clip not found" });
              break;
            }
            const trackId = (track0 as any).id;
            const liveClips = () =>
              (useProjectStore.getState().project.timeline.tracks.find((t: any) => t.id === trackId)?.clips ?? []) as any[];
            try {
              // 1. split at endSec (only when endSec falls strictly inside a clip)
              const cEnd = liveClips().find((c) => c.startTime < endSec - 0.01 && c.startTime + c.duration > endSec + 0.01);
              if (cEnd) await useProjectStore.getState().splitClip(cEnd.id, endSec);
              // 2. split at startSec
              const cStart = liveClips().find((c) => c.startTime < startSec - 0.01 && c.startTime + c.duration > startSec + 0.01);
              if (cStart) await useProjectStore.getState().splitClip(cStart.id, startSec);
              // 3. ripple-delete the middle [startSec, endSec)
              const mid = liveClips().find(
                (c) => Math.abs(c.startTime - startSec) < 0.1 && Math.abs(c.startTime + c.duration - endSec) < 0.15,
              );
              if (!mid) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: "could not isolate the range to remove" });
                break;
              }
              await useProjectStore.getState().rippleDeleteClip(mid.id);
              reply({ type: "voidspace:ack", requestId: msg.requestId, op: "remove-range", ok: true });
            } catch (err: any) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: err?.message ?? "remove-range failed" });
            }
            break;
          }
          case "voidspace:cut-ranges": {
            // Cut MANY [startSec, endSec] TIMELINE regions out of one clip in a
            // single pass. This is what transcript-driven editing needs: the
            // agent decides what to remove from the words, and every cut lands
            // atomically here.
            //
            // Two reasons this is not just a loop over remove-range on the
            // agent's side:
            //  • ORDERING — each ripple-delete shifts everything after it left,
            //    so ranges MUST execute back-to-front or every later range is
            //    silently off by the total already removed. Doing it here means
            //    the agent can hand us ranges in reading order and be right.
            //  • UNDO — one action group, so a 12-cut clean-up is ONE Ctrl+Z
            //    for the user instead of twelve.
            const { clipId, ranges } = msg as any;
            if (!clipId || !Array.isArray(ranges) || ranges.length === 0) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "clipId + non-empty ranges required" });
              break;
            }
            const trackOfC = (cid: string) =>
              useProjectStore.getState().project.timeline.tracks.find((t: any) => t.clips.some((c: any) => c.id === cid));
            const tr0 = trackOfC(clipId);
            if (!tr0) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "clip not found" });
              break;
            }
            const trkId = (tr0 as any).id;
            const live = () =>
              (useProjectStore.getState().project.timeline.tracks.find((t: any) => t.id === trkId)?.clips ?? []) as any[];

            // Normalise: drop junk, sort ascending, merge overlaps/touching so
            // two overlapping instructions can't double-cut, then reverse.
            const clean = (ranges as any[])
              .map((r) => ({ start: Number(r.startSec), end: Number(r.endSec) }))
              .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start + 0.02)
              .sort((a, b) => a.start - b.start);
            const merged: { start: number; end: number }[] = [];
            for (const r of clean) {
              const last = merged[merged.length - 1];
              if (last && r.start <= last.end + 0.02) last.end = Math.max(last.end, r.end);
              else merged.push({ ...r });
            }
            if (merged.length === 0) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "no valid ranges after validation" });
              break;
            }

            const history = (useProjectStore.getState() as any).actionHistory;
            history?.beginGroup?.("Cut ranges");
            // `actual` is the duration of the segment REALLY deleted, which is
            // not always `end - start`: the `mid` finder below matches with a
            // ±0.1s / ±0.15s tolerance, so a split that landed slightly off
            // still gets cut. Reporting the REQUESTED length instead made
            // `removedSec` over-report — measured 0.6 claimed against 0.5
            // actually removed on a two-range cut — and an agent that trusts
            // that number reports a cut to the user that the timeline does not
            // have.
            const applied: { start: number; end: number; actual: number }[] = [];
            const failed: { start: number; end: number; reason: string }[] = [];
            try {
              // Back-to-front: a later cut can't disturb an earlier one's times.
              for (let i = merged.length - 1; i >= 0; i--) {
                const { start, end } = merged[i];
                try {
                  const cEnd = live().find((c) => c.startTime < end - 0.01 && c.startTime + c.duration > end + 0.01);
                  if (cEnd) await useProjectStore.getState().splitClip(cEnd.id, end);
                  const cStart = live().find((c) => c.startTime < start - 0.01 && c.startTime + c.duration > start + 0.01);
                  if (cStart) await useProjectStore.getState().splitClip(cStart.id, start);
                  const mid = live().find(
                    (c) => Math.abs(c.startTime - start) < 0.1 && Math.abs(c.startTime + c.duration - end) < 0.15,
                  );
                  if (!mid) {
                    failed.push({ start, end, reason: "could not isolate the range" });
                    continue;
                  }
                  const actual = Number(mid.duration) || (end - start);
                  await useProjectStore.getState().rippleDeleteClip(mid.id);
                  applied.push({ start, end, actual });
                } catch (e: any) {
                  failed.push({ start, end, reason: e?.message ?? "cut failed" });
                }
              }
            } finally {
              history?.endGroup?.();
            }
            const removedSec = applied.reduce((s, r) => s + r.actual, 0);
            reply({
              type: "voidspace:ack",
              requestId: msg.requestId,
              op: "cut-ranges",
              ok: applied.length > 0,
              cutsApplied: applied.length,
              cutsFailed: failed.length,
              removedSec: Math.round(removedSec * 100) / 100,
              failures: failed,
            });
            break;
          }
          case "voidspace:move-clip": {
            const { clipId, startTime, trackId } = msg as any;
            if (!clipId || typeof startTime !== "number") {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "clipId + startTime required" });
              break;
            }
            // Text-clip path — route through the project-store wrapper
            // so the move enters ActionHistory (manual undo + snapshot
            // revert both depend on it).
            const titleEngMove = useEngineStore.getState().getTitleEngine();
            const textClipMove = titleEngMove?.getTextClip(clipId);
            if (textClipMove) {
              const r = await (useProjectStore.getState() as any).updateTextClip(clipId, { startTime });
              if (!r?.success) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: r?.error?.message ?? "updateTextClip failed" });
                break;
              }
              reply({ type: "voidspace:clip-moved", requestId: msg.requestId, clipId, ok: true });
              break;
            }
            // Media clip path.
            const r = await useProjectStore.getState().moveClip(clipId, startTime, trackId);
            if (!r.success) {
              const e: any = r.error;
              const errStr = e && typeof e === "object" ? `${e.code ?? "ERROR"}: ${e.message ?? "moveClip failed"}` : (typeof e === "string" ? e : "moveClip failed");
              reply({ type: "voidspace:error", requestId: msg.requestId, error: errStr });
              break;
            }
            reply({ type: "voidspace:clip-moved", requestId: msg.requestId, clipId, ok: true });
            break;
          }
          // voidspace:apply-editor-state handler removed (2026-05-09).
          // It used to take a chat-doc-cached `tracks[]` snapshot and
          // patch the live project to match — overwriting fresh blob-
          // loaded state with stale chat-cached state. The blob is the
          // source of truth now; nothing should be patching the project
          // from outside the ActionExecutor.
          // ── Inspector-surface RPCs ──────────────────────────────────
          // Single uniform interface the agent uses to drive every
          // openreel Inspector section (transitions, blending, emphasis,
          // effects, etc.). Each surface is a thin wrapper that imports
          // and calls the EXACT same code path the Inspector section's
          // "Apply" button uses — no reimplementation. Add new surfaces
          // by dropping a file in src/agent/inspector-surfaces/ and
          // registering it in that directory's index.ts. No changes
          // here.
          //
          // Three RPCs implement the discovery-then-apply pattern so
          // the chat agent never has to load every surface's full
          // schema into its prompt:
          //   list-inspector-tools      → names + 1-line descriptions
          //   get-inspector-tool-schema → full schema for one surface
          //   apply-inspector-tool      → run a surface against clip(s)
          case "voidspace:list-inspector-tools": {
            const { listSurfaces } = await import("./agent/inspector-surfaces");
            reply({
              type: "voidspace:inspector-tools",
              requestId: (msg as any).requestId,
              ok: true,
              surfaces: listSurfaces(),
            });
            break;
          }
          case "voidspace:get-inspector-tool-schema": {
            const args = msg as any;
            const { getSurface } = await import("./agent/inspector-surfaces");
            const s = getSurface(String(args.name ?? ""));
            if (!s) {
              reply({ type: "voidspace:error", requestId: args.requestId, error: `unknown inspector tool: ${args.name}` });
              break;
            }
            reply({
              type: "voidspace:inspector-tool-schema",
              requestId: args.requestId,
              ok: true,
              name: s.name,
              description: s.description,
              appliesTo: s.appliesTo,
              schema: s.schema,
              readable: typeof s.read === "function",
            });
            break;
          }
          /**
           * READ one surface's current state on one or more clips.
           *
           * The mirror of apply-inspector-tool, and the reason it had to exist:
           * `video-effects` can update, remove and toggle an effect BY ID, and
           * before this there was no way for the agent to learn an id. Two of
           * that surface's five operations were unreachable in practice.
           *
           * Read-only by construction — no snapshot, no history entry, no
           * rollback path, because nothing is mutated. Targets resolve exactly
           * as they do for apply, so "read what I am about to change" uses the
           * same selector as the change.
           */
          case "voidspace:read-inspector-tool": {
            const args = msg as any;
            try {
              const { getSurface, resolveTargetClips } = await import("./agent/inspector-surfaces");
              const surface = getSurface(String(args.surface ?? ""));
              if (!surface) {
                reply({ type: "voidspace:error", requestId: args.requestId, error: `unknown surface: ${args.surface}` });
                break;
              }
              if (typeof surface.read !== "function") {
                reply({
                  type: "voidspace:error",
                  requestId: args.requestId,
                  error: `surface "${surface.name}" is not readable — list_inspector_tools reports which are`,
                });
                break;
              }
              if (!args.clipIds && !args.applyAll) {
                reply({ type: "voidspace:error", requestId: args.requestId, error: "clipIds or applyAll required" });
                break;
              }
              const project = useProjectStore.getState().project;
              const targets = resolveTargetClips(project, surface, {
                clipIds: Array.isArray(args.clipIds) ? args.clipIds : undefined,
                applyAll: !!args.applyAll,
              });
              const ctx = { project, store: useProjectStore.getState() as unknown as Record<string, unknown> };
              const results: Array<{ clipId: string; state: unknown }> = [];
              for (const t of targets) {
                results.push({ clipId: t.id, state: await surface.read(t, ctx) });
              }
              reply({
                type: "voidspace:inspector-tool-read",
                requestId: args.requestId,
                ok: true,
                surface: surface.name,
                clipsRead: results.length,
                results,
              });
            } catch (err: any) {
              reply({ type: "voidspace:error", requestId: args.requestId, error: err?.message ?? String(err) });
            }
            break;
          }
          case "voidspace:apply-inspector-tool": {
            // Args: { surface: string, clipIds?: string[], applyAll?: boolean, config: object }
            const args = msg as any;
            try {
              const { getSurface, resolveTargetClips } = await import("./agent/inspector-surfaces");
              const surface = getSurface(String(args.surface ?? ""));
              if (!surface) {
                reply({ type: "voidspace:error", requestId: args.requestId, error: `unknown surface: ${args.surface}` });
                break;
              }
              if (!args.clipIds && !args.applyAll) {
                reply({ type: "voidspace:error", requestId: args.requestId, error: "clipIds or applyAll required" });
                break;
              }
              /**
               * REFUSE A CONFIG THE SURFACE CANNOT READ, BEFORE TOUCHING ANYTHING.
               *
               * A surface's `apply` acts on the keys it recognises and ignores
               * the rest — correct for a partial edit, silent for a config it
               * understands none of: no branch runs, no error is recorded, and
               * it returns ok. Sixteen calls in a row once answered
               * `{ ok: true, clipsTouched: 1 }` and wrote nothing, because the
               * config had been sent under `params` instead of `config`. One
               * check here covers all 18 surfaces and every surface added after
               * this line.
               */
              const { validateSurfaceConfig } = await import("./agent/inspector-surfaces/validate-config");
              const configError = validateSurfaceConfig(surface, args.config);
              if (configError) {
                reply({ type: "voidspace:error", requestId: args.requestId, error: configError });
                break;
              }
              const project = useProjectStore.getState().project;
              const targets = resolveTargetClips(project, surface, {
                clipIds: Array.isArray(args.clipIds) ? args.clipIds : undefined,
                applyAll: !!args.applyAll,
              });
              if (targets.length === 0) {
                // Diagnostic so the agent can fix typos / wrong-kind targeting
                // without an extra read_timeline round-trip.
                let hint = "no matching clips";
                if (Array.isArray(args.clipIds) && args.clipIds.length > 0) {
                  // Check if those ids exist at all (any kind) so we can
                  // distinguish "id typo" from "wrong kind for this surface".
                  const allKnownIds = new Set<string>();
                  for (const tr of project.timeline?.tracks ?? []) {
                    for (const c of (tr as any).clips ?? []) allKnownIds.add(c.id);
                  }
                  for (const tc of (project as any).textClips ?? []) allKnownIds.add(tc.id);
                  for (const k of ["shapeClips", "svgClips", "stickerClips"] as const) {
                    for (const gc of (project as any)[k] ?? []) allKnownIds.add(gc.id);
                  }
                  const missing = (args.clipIds as string[]).filter((id) => !allKnownIds.has(id));
                  const wrongKind = (args.clipIds as string[]).filter((id) => allKnownIds.has(id));
                  if (missing.length > 0) hint = `unknown clipIds: ${missing.join(", ")}`;
                  else if (wrongKind.length > 0) hint = `clip kind not in surface.appliesTo (${surface.appliesTo.join(",")}): ${wrongKind.join(", ")}`;
                }
                /**
                 * NAMING CLIPS THAT DO NOT EXIST IS A FAILED CALL.
                 *
                 * `applyAll` matching nothing is a real no-op — "crossfade
                 * everything" on a one-clip timeline correctly does nothing, and
                 * failing a batch over it would be wrong. But a caller that
                 * NAMED clips and hit none of them has a typo or a stale id, and
                 * answering `ok: true` sends it on to the next step believing the
                 * edit happened. It finds out at the export, if at all.
                 */
                if (Array.isArray(args.clipIds) && args.clipIds.length > 0) {
                  reply({
                    type: "voidspace:error",
                    requestId: args.requestId,
                    error: `${hint} (surface "${surface.name}" applies to ${surface.appliesTo.join(", ")})`,
                  });
                  break;
                }
                reply({
                  type: "voidspace:inspector-tool-applied",
                  requestId: args.requestId,
                  ok: true, clipsTouched: 0,
                  note: hint,
                  appliesTo: surface.appliesTo,
                });
                break;
              }
              // Auto-snapshot before any agent-driven inspector mutation
              // so the user can rewind from the Snapshots panel.
              try {
                const snapStore = useProjectStore.getState() as any;
                snapStore.actionHistory.createSnapshot(
                  `Before ${surface.name} · ${new Date().toLocaleTimeString()}`,
                );
              } catch {}
              // Capture full BEFORE states — the surfaces mutate through
              // direct store setters that never touch the ActionExecutor, so
              // without an explicit history entry the edit is invisible to
              // Ctrl+Z/redo (and the snapshot above bookmarks an executor
              // stack the setters never grow, making its restore a no-op).
              const beforeStates = new Map<string, unknown>(
                targets.map((t) => [t.id, JSON.parse(JSON.stringify(t.raw))]),
              );
              const results: Array<{ clipId: string; ok: boolean; note?: string; error?: string }> = [];
              let threw: unknown = null;
              /**
               * ONE EDIT, ONE UNDO — EVEN THOUGH THE PIECES ARRIVE SEPARATELY.
               *
               * Surfaces no longer all "mutate through direct store setters":
               * volume-automation, audio-mix and clip-transitions go through the
               * ActionExecutor, which shares THIS history. So one call can push
               * several `keyframe/remove`s, several `keyframe/add`s, and then the
               * state patch registered below.
               *
               * Auto-grouping does not save us — it only merges CONSECUTIVE
               * entries of the SAME type, so that sequence lands as three
               * separate groups. The first Ctrl+Z restores the whole
               * before-state (correct), and the next two then replay keyframe
               * inverses against a project that no longer has those keyframes.
               * An explicit group makes the batch atomic to undo, which is what
               * `Cut ranges` and `Cut silence` already do for the same reason.
               */
              const hist = (useProjectStore.getState() as any).actionHistory;
              const historyBefore = hist?.serialize?.();
              const historyDepthBefore: number = hist?.getHistory?.().length ?? 0;
              try { hist?.beginGroup?.(`Apply ${surface.name}`); } catch { /* older history */ }
              try {
                for (const t of targets) {
                  // LIVE STATE PER TARGET, NOT ONE SNAPSHOT FOR THE BATCH.
                  //
                  // ── WHY THIS COSTS A getState() PER CLIP ──────────────────
                  // A batch is N sequential mutations, and each one replaces
                  // `project` with a new object graph. Hoisting `ctx` above the
                  // loop hands target 2..N the PRE-EDIT project — whose tracks
                  // and clips the store no longer references. Surfaces that
                  // write immutably (`{...project, timeline: {...}}`) then
                  // rebuild the whole project from that stale base and silently
                  // UNDO target 1; surfaces that write through the
                  // ActionExecutor (which mutates in place) push their change
                  // onto an ORPHANED track object that nothing will ever read.
                  //
                  // Measured on `clip-transitions` with applyAll over three
                  // shots: the tool reported "3 ok" — two dissolves and one
                  // correct "last clip has no neighbour" skip — and the track
                  // came back carrying ONE transition. The second dissolve went
                  // onto the old track object, so the second cut exported hard.
                  //
                  // getState() is a field read. Correctness is worth it.
                  const live = useProjectStore.getState();
                  const ctx = {
                    project: live.project,
                    store: live as unknown as Record<string, unknown>,
                  };
                  const r = await surface.apply(t, args.config, ctx);
                  results.push({ clipId: t.id, ok: r.ok, note: r.note, error: r.error });
                }
              } catch (e) {
                threw = e;
              } finally {
                // Close the group on every path, or the NEXT unrelated edit
                // joins this one and a single Ctrl+Z takes back both.
                try { hist?.endGroup?.(); } catch { /* older history */ }
              }
              // FOUNDATION FIX (F8): inspector batch is ALL-OR-NOTHING. The
              // surfaces mutate via direct store setters, so a throw or a single
              // ok:false on target k of N leaves the earlier targets mutated with
              // no history entry (torn, un-undoable state). Restore every target
              // to its captured before-state, register NO history entry, and fail.
              if (threw || results.some((r) => !r.ok)) {
                // Failed executor-backed surfaces must not leave partial edits
                // on the undo/redo stack after their clip state is restored.
                if (historyBefore) hist.restore(historyBefore);
                const engRb = useEngineStore.getState().getTitleEngine();
                const timelineClipIds = new Set<string>();
                for (const tr of project.timeline?.tracks ?? []) {
                  for (const c of tr.clips ?? []) timelineClipIds.add(c.id);
                }
                // Restore timeline clips to their before-state (single store write).
                useProjectStore.setState((s: any) => ({
                  project: {
                    ...s.project,
                    timeline: {
                      ...s.project.timeline,
                      tracks: (s.project.timeline?.tracks ?? []).map((tr: any) => ({
                        ...tr,
                        clips: (tr.clips ?? []).map((c: any) =>
                          beforeStates.has(c.id) ? beforeStates.get(c.id) : c,
                        ),
                      })),
                    },
                    modifiedAt: Date.now(),
                  },
                }));
                // Restore text-clip targets via the engine (not on the timeline).
                if (engRb) {
                  for (const t of targets as any[]) {
                    if (!timelineClipIds.has(t.id) && beforeStates.has(t.id)) {
                      try { engRb.updateTextClip(t.id, beforeStates.get(t.id) as never); } catch { /* best-effort */ }
                    }
                  }
                }
                const firstErr = threw
                  ? (threw instanceof Error ? threw.message : String(threw))
                  : results.find((r) => !r.ok)?.error ?? "unknown";
                const failedN = threw ? results.length : results.filter((r) => !r.ok).length;
                reply({
                  type: "voidspace:error",
                  requestId: args.requestId,
                  error: `inspector batch rolled back (${failedN}/${targets.length} failed): ${firstErr}`,
                });
                break;
              }
              const okCount = results.filter((r) => r.ok).length;
              // Register the mutation on the UNDO stack (Ctrl+Z / History
              // panel / redo) as a generic before/after state patch covering
              // every inspector surface — media clips and text clips.
              // (Graphics clips live in engine stores the executor can't
              // reach; the Snapshots panel remains their rewind path.)
              try {
                /**
                 * DO NOT RECORD THE SAME EDIT TWICE.
                 *
                 * This block exists for surfaces that write straight to the
                 * store, which the ActionExecutor never sees. An executor-backed
                 * surface has ALREADY pushed its own undoable entries, and
                 * adding a state patch on top means undoing the group applies
                 * both: the patch restores the before-state, then the keyframe
                 * inverses run against it and strip keyframes that legitimately
                 * existed beforehand. Ask the history whether anything was
                 * recorded rather than assuming either way.
                 */
                const surfacesRecorded =
                  ((hist?.getHistory?.().length ?? 0) as number) > historyDepthBefore;
                const applied = new Set(results.filter((r) => r.ok).map((r) => r.clipId));
                if (applied.size > 0 && !surfacesRecorded) {
                  const fresh = useProjectStore.getState().project;
                  const freshTextClips: any[] = useEngineStore.getState().getTitleEngine()?.getAllTextClips()
                    ?? (fresh as any).textClips ?? [];
                  const clips: Array<{ clipId: string; state: any }> = [];
                  const textClips: Array<{ clipId: string; state: any }> = [];
                  const invClips: Array<{ clipId: string; state: any }> = [];
                  const invTextClips: Array<{ clipId: string; state: any }> = [];
                  for (const t of targets as any[]) {
                    if (!applied.has(t.id)) continue;
                    const before = beforeStates.get(t.id);
                    let after: any = null;
                    let isText = false;
                    for (const tr of fresh.timeline?.tracks ?? []) {
                      const c = (tr.clips ?? []).find((cc: any) => cc.id === t.id);
                      if (c) { after = c; break; }
                    }
                    if (!after) {
                      const tc = freshTextClips.find((x: any) => x?.id === t.id);
                      if (tc) { after = tc; isText = true; }
                    }
                    if (!before || !after) continue;
                    const b = JSON.parse(JSON.stringify(before));
                    const a = JSON.parse(JSON.stringify(after));
                    if (JSON.stringify(b) === JSON.stringify(a)) continue; // no visible change
                    (isText ? textClips : clips).push({ clipId: t.id, state: a });
                    (isText ? invTextClips : invClips).push({ clipId: t.id, state: b });
                  }
                  if (clips.length > 0 || textClips.length > 0) {
                    const label = `Apply ${surface.name}`;
                    const now = Date.now();
                    (useProjectStore.getState() as any).actionHistory.push(
                      { id: `agent-apply-${now.toString(36)}`, type: "clip/applyState", timestamp: now, params: { label, clips, textClips } },
                      { id: `agent-apply-inv-${now.toString(36)}`, type: "clip/applyState", timestamp: now, params: { label, clips: invClips, textClips: invTextClips } },
                    );
                  }
                }
              } catch (histErr) {
                console.warn("[apply-inspector-tool] undo registration failed:", histErr);
              }

              /**
               * COMMIT THE BATCH — ONCE, HERE, FOR EVERY SURFACE.
               *
               * ── WHY THE DISPATCHER AND NOT EACH SURFACE ───────────────────
               * The autosave is HASH-GATED on
               * `{id, modifiedAt, trackCount, clipCount, mediaCount}`. An edit
               * that changes none of them — a transition added, an effect
               * toggled, a param nudged — is never written, so it survives
               * until the next reload and then evaporates. And the
               * ActionExecutor mutates the project IN PLACE (the clone it takes
               * is only for the inverse), so an executor-backed surface changes
               * nothing the hash can see.
               *
               * That has now shipped as a bug three separate times, each time
               * caught only by exporting a file and measuring it. Leaving the
               * fix as "every surface must remember to commit" guarantees a
               * fourth. One bump here covers all 18 and every surface added
               * after this line.
               *
               * Scope is deliberate: new references for `tracks` and each
               * track's `transitions`/`clips` ARRAYS, plus `modifiedAt`. Clip
               * OBJECTS are NOT cloned — engines hold references to them and a
               * blanket clone would be a much larger change than the durability
               * problem needs. A surface that mutates a clip in place and needs
               * React to repaint still owns that part.
               */
              if (okCount > 0) {
                try {
                  useProjectStore.setState((s: any) => ({
                    project: {
                      ...s.project,
                      timeline: {
                        ...s.project.timeline,
                        tracks: (s.project.timeline?.tracks ?? []).map((t: any) => ({
                          ...t,
                          clips: [...(t.clips ?? [])],
                          transitions: [...(t.transitions ?? [])],
                        })),
                      },
                      modifiedAt: Date.now(),
                    },
                  }));
                } catch (commitErr) {
                  console.warn("[apply-inspector-tool] commit failed:", commitErr);
                }
              }

              reply({
                type: "voidspace:inspector-tool-applied",
                requestId: args.requestId,
                ok: true,
                surface: surface.name,
                clipsTouched: okCount,
                clipsAttempted: results.length,
                results,
              });
            } catch (err: any) {
              reply({ type: "voidspace:error", requestId: args.requestId, error: err?.message ?? String(err) });
            }
            break;
          }
          /**
           * RENDER ONE FRAME of the composited timeline, as an image.
           *
           * ── WHY THE AGENT NEEDED EYES HERE SPECIFICALLY ────────────────────
           * `inspect_media` could always look at a SOURCE file or a finished
           * render. Neither answers the question that matters while editing:
           * what does the timeline look like right now, with the caption over
           * the shot, the grade applied, the logo where it was just placed?
           * The only way to find out was a full export, which the playbook
           * budgets at two rounds — so in practice the agent verified what it
           * generated and never what it composed. Captions colliding with a
           * logo, a transform that pushed a face out of the safe area, a grade
           * pushed too far: all invisible until a person watched the result.
           *
           * This is the same `renderFrame` the preview and the export call, so
           * what comes back IS the frame — every effect, transition, caption
           * and nested sequence included, not an approximation of them.
           *
           * Returns a JPEG data URL. The caller uploads it and hands the agent
           * a URL, because the vision path takes URLs.
           */
          case "voidspace:render-frame": {
            const args = msg as any;
            try {
              const proj = useProjectStore.getState().project;
              if (!proj) {
                reply({ type: "voidspace:error", requestId: args.requestId, error: "no project loaded" });
                break;
              }
              const dur = proj.timeline?.duration ?? 0;
              const rawTime = Number(args.timeSec);
              if (!Number.isFinite(rawTime) || rawTime < 0) {
                reply({ type: "voidspace:error", requestId: args.requestId, error: "timeSec must be a non-negative number" });
                break;
              }
              // Clamp INSIDE the film. A request one frame past the end would
              // render black and read as "the shot is black", which is a much
              // worse answer than "that is past the end".
              const time = dur > 0 ? Math.min(rawTime, Math.max(0, dur - 0.05)) : rawTime;

              const core = await import("@openreel/core");
              const engine = core.getVideoEngine();
              if (!engine.isInitialized()) await engine.initialize();

              // A frame for LOOKING at, not for mastering: cap the long edge so
              // the upload and the vision call stay cheap. 960px is comfortably
              // enough to read a caption or see a face is cropped.
              const maxEdge = Math.max(240, Math.min(1920, Number(args.maxEdge) || 960));
              const sw = proj.settings?.width ?? 1920;
              const sh = proj.settings?.height ?? 1080;
              const scale = Math.min(1, maxEdge / Math.max(sw, sh));
              const w = Math.max(2, Math.round(sw * scale));
              const h = Math.max(2, Math.round(sh * scale));

              const rendered = await engine.renderFrame(proj, time, w, h);
              const canvas = new OffscreenCanvas(rendered.width, rendered.height);
              const cctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
              cctx.drawImage(rendered.image, 0, 0);
              try { rendered.image.close(); } catch { /* already closed */ }
              const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
              const dataUrl = await new Promise<string>((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(String(fr.result));
                fr.onerror = () => reject(fr.error);
                fr.readAsDataURL(blob);
              });

              reply({
                type: "voidspace:frame-rendered",
                requestId: args.requestId,
                ok: true,
                dataUrl,
                timeSec: time,
                requestedTimeSec: rawTime,
                width: rendered.width,
                height: rendered.height,
                projectDurationSec: dur,
              });
            } catch (err: any) {
              reply({ type: "voidspace:error", requestId: args.requestId, error: err?.message ?? String(err) });
            }
            break;
          }
          case "voidspace:snapshot": {
            // Bookmark the current ActionHistory undoStack index. The
            // chat uses this to mark "state before this agent turn"
            // so editing-and-resending the same user message later
            // walks ActionHistory back to here, replaying inverse
            // actions for everything done since.
            //
            // This requires every timeline mutation in between to be
            // recorded as an action with a valid inverse. The
            // text-clip path (captions) used to bypass that — it now
            // routes through projectStore.updateTextClip → text/update
            // action. If you find a mutation that still doesn't show
            // up in the HistoryPanel, route it through the executor
            // (don't add a parallel snapshot mechanism).
            const snapStore = useProjectStore.getState() as any;
            const snapName = typeof msg.name === "string" && msg.name ? msg.name : `Agent checkpoint ${new Date().toLocaleTimeString()}`;
            const snap = snapStore.actionHistory.createSnapshot(snapName);
            reply({ type: "voidspace:snapshot", requestId: msg.requestId, ok: true, snapshot: snap });
            break;
          }
          case "voidspace:restore-snapshot": {
            // Walk ActionHistory back to the snapshot's undoStack
            // index by replaying inverse actions one at a time
            // through the native undo() — the same path the manual
            // undo button uses. No parallel state-capture: the
            // editor's history is the single source of truth.
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
            let proj = useProjectStore.getState().project;
            if (!proj) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "no project loaded" });
              break;
            }
            try {
              const core = await import("@openreel/core");
              const engine = core.getExportEngine();
              await engine.initialize();

              const { fetchMediaBlob } = await import("./services/voidspace-loader");
              const postPhase = (phase: string) =>
                (e.source as Window | null)?.postMessage(
                  { type: "voidspace:export-progress", requestId: msg.requestId, fraction: 0, phase },
                  "*",
                );

              // ── Render-readiness gate ────────────────────────────────────
              // The FIRST render used to drop every clip after the first. Root
              // cause: the voidspace loader's live Firestore subscription
              // rebuilds the project across several async ticks (the
              // project_state blob loads first, then a per-scene rebuild swaps
              // in the freshly-generated clips + their blobs). A render fired
              // right after open therefore operated on a half-built timeline —
              // the later clips had no media yet and painted black. By the time
              // the user hit "Re-render" the rebuild had settled, which is
              // exactly why the second render "just worked".
              //
              // Fix: before exporting, wait for the project to STOP changing
              // (track / clip / media counts stable across consecutive reads),
              // then re-read it — so the first render exports the same complete
              // timeline a re-render would.
              const sigOf = (p: any) => {
                if (!p) return "none";
                const tracks = p.timeline?.tracks ?? [];
                let clips = 0;
                for (const t of tracks) clips += t.clips?.length ?? 0;
                return `${tracks.length}/${clips}/${p.mediaLibrary?.items?.length ?? 0}`;
              };
              {
                let prev = sigOf(proj);
                let stable = 0;
                for (let i = 0; i < 40 && stable < 3; i++) {
                  await new Promise((r) => setTimeout(r, 200));
                  const sig = sigOf(useProjectStore.getState().project);
                  if (sig === prev) {
                    stable++;
                  } else {
                    stable = 0;
                    prev = sig;
                    postPhase("Finishing loading the timeline…");
                  }
                }
                proj = useProjectStore.getState().project || proj;
                console.warn(`[voidspace:export] timeline settled at ${sigOf(proj)}`);
              }

              // Pre-flight: hydrate EVERY blob the timeline references. Video
              // frames decode through a <video>/mediabunny decoder and audio
              // decode needs a real Blob (Web Audio decodes an ArrayBuffer);
              // the project_state blob path loads media URL-only, so without
              // this a clip whose blob hasn't been lazily fetched yet renders
              // black (video) or silent (audio). Cover every timeline-
              // referenced clip from any URL field, with retries — not just
              // items that happen to carry `originalUrl`.
              try {
                const neededIds = new Set<string>();
                for (const t of (proj.timeline?.tracks ?? [])) {
                  for (const c of (t.clips ?? [])) {
                    if ((c as any).mediaId) neededIds.add((c as any).mediaId);
                  }
                }
                const urlOf = (m: any) => m?.originalUrl || m?.url || null;
                const items = (proj.mediaLibrary?.items ?? []) as any[];
                let missing = items.filter((m) => neededIds.has(m.id) && !m.blob && urlOf(m));
                if (missing.length > 0) {
                  postPhase(`Loading ${missing.length} media file${missing.length === 1 ? "" : "s"}…`);
                  for (let attempt = 0; attempt < 3 && missing.length > 0; attempt++) {
                    await Promise.all(
                      missing.map(async (m) => {
                        const blob = await fetchMediaBlob(urlOf(m));
                        if (blob) m.blob = blob;
                      }),
                    );
                    missing = items.filter((m) => neededIds.has(m.id) && !m.blob && urlOf(m));
                  }
                }
                const unrenderable = items.filter((m) => neededIds.has(m.id) && !m.blob);
                if (unrenderable.length) {
                  console.warn(
                    `[voidspace:export] ${unrenderable.length} timeline media still have no blob:`,
                    unrenderable.map((m) => m.id),
                  );
                }
              } catch (preflightErr) {
                console.warn("[voidspace:export] blob preflight failed:", preflightErr);
              }

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
          /**
           * ── EXPORT THE MIX, NOT A PICTURE OF IT ───────────────────────────
           *
           * An audio episode rendered through the VIDEO path came out with the
           * mixer ignored: a clip set to volume 0 still played at full level in
           * the file, so nothing an agent (or a person) set in the mixer reached
           * the output. Levels, fades and ducking were all being written and all
           * being discarded, which is indistinguishable from a broken mixer and
           * is why an episode kept coming back with the ambience on top of the
           * dialogue however quiet it was set.
           *
           * `exportAudio` is the engine that renders the timeline THROUGH its
           * mixer. It has always existed; it was reachable only from the
           * toolbar's own button, behind a file-save picker, so no agent and no
           * automation could use it. This is the same call, without the picker.
           *
           * mp3 at 320k by default: small enough to hand back as a blob url and
           * good enough that the mix, not the codec, is what is being judged.
           * wav is there for a master.
           */
          /**
           * MEASURE EVERY AUDIO CLIP — loudness, peak, and the gain to fix it.
           *
           * ── WHY THE AGENT NEEDED THIS ─────────────────────────────────────
           * It cannot hear, and until now it had no meter either, so every level
           * was a guess that only got checked when a person said "I can't hear
           * the dialogue". Loudness is also not a thing you can infer from the
           * numbers already on the timeline: `clip.volume` is a multiplier, and
           * how loud a source IS depends entirely on the file.
           *
           * Measures the SOURCE, not the mix, because that is what makes the
           * answer actionable — source loudness plus a target gives a gain, and
           * gain is linear in dB, so applying it lands exactly. The mix itself is
           * measured by exporting and reading the file, which is one render
           * rather than a guess per clip.
           */
          case "voidspace:measure-audio": {
            const proj = useProjectStore.getState().project;
            if (!proj) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "no project loaded" });
              break;
            }
            try {
              const core = await import("@openreel/core");
              const a = msg as any;
              const anchorLufs = Number.isFinite(Number(a.anchorLufs)) ? Number(a.anchorLufs) : -18;
              /**
               * House offsets, in dB relative to the dialogue anchor. Under
               * -12 a bed starts masking consonants; past -18 it stops being
               * present at all. SFX are short and peak-driven, so they sit
               * closer but are watched on peak rather than loudness.
               */
              const OFFSETS: Record<string, number> = {
                dialogue: 0, narration: 0, voice: 0,
                ambience: -15,
                music: -12,
                effects: -8, sfx: -8,
                general: -12,
                ...(a.targets && typeof a.targets === "object" ? a.targets : {}),
              };

              const roleOf = (track: any): string => {
                const r = String(track?.role ?? "").toLowerCase();
                if (r) return r;
                const n = `${track?.name ?? ""}`.toLowerCase();
                if (/narration|dialogue|voice|speech|vocal/.test(n)) return "dialogue";
                if (/ambien|room|atmos/.test(n)) return "ambience";
                if (/sfx|foley|effect/.test(n)) return "effects";
                if (/music|score|bgm/.test(n)) return "music";
                return "general";
              };

              const ac = new AudioContext();
              const cache = new Map<string, any>();
              const rows: any[] = [];
              try {
                for (const track of proj.timeline?.tracks ?? []) {
                  if (track.type !== "audio" && track.type !== "video") continue;
                  const role = roleOf(track);
                  for (const clip of track.clips ?? []) {
                    const media = (proj.mediaLibrary?.items ?? []).find((m: any) => m.id === clip.mediaId);
                    if (!media) continue;
                    let reading = cache.get(clip.mediaId);
                    if (!reading) {
                      // Same hydration the preview and export use: generated
                      // narration/music arrive as a remote url with no blob.
                      let bytes: ArrayBuffer | null = null;
                      if ((media as any).blob instanceof Blob && (media as any).blob.size > 0) {
                        bytes = await (media as any).blob.arrayBuffer();
                      } else if ((media as any).originalUrl) {
                        const resp = await fetch(core.rewriteToProxy((media as any).originalUrl), { mode: "cors" });
                        if (resp.ok) bytes = await resp.arrayBuffer();
                      }
                      if (!bytes || bytes.byteLength === 0) continue;
                      const buf = await ac.decodeAudioData(bytes);
                      const chans: Float32Array[] = [];
                      for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
                      reading = core.measureLoudnessOf(chans, buf.sampleRate);
                      cache.set(clip.mediaId, reading);
                    }

                    // What this clip is ACTUALLY playing at: a volume keyframe
                    // replaces clip.volume, so the curve wins where it exists.
                    const curve = (clip.keyframes ?? [])
                      .filter((k: any) => k.property === "volume" && Number.isFinite(k.value))
                      .map((k: any) => k.value as number);
                    const currentGain = curve.length ? Math.max(...curve) : (clip.volume ?? 1);

                    const offset = OFFSETS[role] ?? -12;
                    const targetLufs = anchorLufs + offset;
                    const suggestedGain = core.gainToReach(reading.integrated, targetLufs);

                    rows.push({
                      clipId: clip.id,
                      track: track.name,
                      role,
                      sourceLufs: Number.isFinite(reading.integrated) ? Number(reading.integrated.toFixed(1)) : null,
                      sourceTruePeakDb: Number.isFinite(reading.truePeak) ? Number(reading.truePeak.toFixed(1)) : null,
                      currentGain: Number(currentGain.toFixed(3)),
                      targetLufs: Number(targetLufs.toFixed(1)),
                      suggestedGain: Number(suggestedGain.toFixed(3)),
                      hasCurve: curve.length > 0,
                    });
                  }
                }
              } finally {
                try { await ac.close(); } catch { /* already closed */ }
              }

              const peaks = rows.map((r) => r.sourceTruePeakDb).filter((p) => typeof p === "number");
              reply({
                type: "voidspace:audio-measured",
                requestId: msg.requestId,
                anchorLufs,
                offsets: OFFSETS,
                clips: rows,
                loudestSourcePeakDb: peaks.length ? Math.max(...peaks) : null,
                note:
                  rows.length === 0
                    ? "No decodable audio on the timeline."
                    : "sourceLufs is the FILE's own loudness; suggestedGain puts it at targetLufs. Where hasCurve is true, scale every automation point by suggestedGain/currentGain — setting clip volume alone does nothing.",
              });
            } catch (err) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: String((err as any)?.message ?? err) });
            }
            break;
          }
          case "voidspace:export-audio": {
            const proj = useProjectStore.getState().project;
            if (!proj) {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "no project loaded" });
              break;
            }
            try {
              const core = await import("@openreel/core");
              const engine = core.getExportEngine();
              await engine.initialize();

              const a = msg as any;

              const runExport = async (format: "wav" | "mp3") => {
                const settings = {
                  format,
                  sampleRate: 48000 as const,
                  channels: 2 as const,
                  bitDepth: (format === "wav" ? 24 : 16) as 16 | 24,
                  bitrate: 320,
                };
                const gen = engine.exportAudio(proj, settings);
                let result: any;
                while (true) {
                  const { value, done } = await gen.next();
                  if (done) { result = value; break; }
                  (e.source as Window | null)?.postMessage(
                    {
                      type: "voidspace:export-progress",
                      requestId: msg.requestId,
                      fraction: value?.progress ?? 0,
                      phase: value?.phase ?? "Mixing",
                    },
                    "*",
                  );
                }
                if (!result?.success || !result?.blob) {
                  throw new Error(result?.error?.message || "Audio export produced no file.");
                }
                return result;
              };

              // WAV IS THE FALLBACK, NOT A LESSER RESULT.
              //
              // The browser encoder refuses some perfectly ordinary MP3
              // configurations — "(mp3, 320000 bps, 2 channels, 44100 Hz) is
              // not supported by this browser" — and which ones depends on the
              // build the viewer happens to be running. The caller is an agent
              // finishing an episode; it cannot know that, and failing the
              // whole mix over a container choice throws away several minutes
              // of rendering for a reason nobody asked about. WAV is lossless,
              // so the substitution costs file size and nothing else.
              let format: "wav" | "mp3" = a.format === "wav" ? "wav" : "mp3";
              let result: any;
              let fellBackFrom: string | undefined;
              try {
                result = await runExport(format);
              } catch (mp3Err) {
                if (format !== "mp3") throw mp3Err;
                fellBackFrom = String((mp3Err as any)?.message ?? mp3Err);
                format = "wav";
                result = await runExport(format);
              }

              reply({
                type: "voidspace:export-audio-done",
                requestId: msg.requestId,
                blobUrl: URL.createObjectURL(result.blob),
                mimeType: format === "wav" ? "audio/wav" : "audio/mpeg",
                format,
                bytes: result.blob.size,
                durationSec: proj.timeline?.duration ?? 0,
                ...(fellBackFrom ? { fellBackFrom } : {}),
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

  /**
   * EMBEDDED, THE CANVAS IS THE POINT — so the Inspector starts shut.
   *
   * Opening a project from Voidspace puts this editor in a pane beside the
   * chat, and the Inspector then takes a third of what is left for a column
   * that says "No selection" until something is clicked. Collapsed, the
   * timeline and the preview get that width back, and one click on its header
   * brings it straight back.
   *
   * ON OPEN, not as a default: the panel store is persisted, so a default
   * would be overwritten the first time anyone touched it and never apply
   * again. Running once per mount means every project opens focused and
   * anything the user does afterwards stands for as long as they are in there.
   *
   * Standalone (no `embed=1`) is untouched — there the editor IS the page.
   */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("embed") !== "1") return;
    useUIStore.getState().setPanelCollapsed("inspector", true);
  }, []);

  const searchParams = new URLSearchParams(window.location.search);
  const forceWelcome =
    params.forceWelcome === "1" || searchParams.get("forceWelcome") === "1";
  const welcomeMode = searchParams.get("mode") === "music" ? "music" : "video";
  // Suppress the landing/format-picker screen whenever the editor is
  // hosted inside the studio-ai iframe (embed=1) or has been opened
  // against a specific project (sceneListId / import). Showing it there
  // gives the user clickable controls (Vertical/Horizontal/Square,
  // Browse templates, Open editor) that would replace the active
  // project state — a hard footgun. While the project is loading we
  // already show LoadingSpinner; after load `navigate("editor")` fires.
  // If the load fails we surface the explicit voidspaceError instead.
  const sp = new URLSearchParams(window.location.search);
  const isProjectContext =
    sp.get("embed") === "1" || sp.has("sceneListId") || sp.has("import");
  const showWelcome =
    !isProjectContext && (["welcome", "templates"].includes(route) || forceWelcome);
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
          <WelcomeScreen initialTab={initialTab} mode={welcomeMode} />
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
