/**
 * Board → video updates, applied IN PLACE.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A board compiled into this project keeps changing after the compile: a take
 * is chosen or regenerated, a shot is retimed, removed, added or moved. Those
 * changes used to reach the open editor only through a FULL REBUILD of the
 * project from the scene docs (voidspace-loader → applyAdditiveMerge), and a
 * rebuild lays clips at running scene totals, full length, inPoint 0. On 8 Oct
 * that put BETTER ME's hand-cut clips back at shotIndex × 6.04 s.
 *
 * Now a board-linked clip (one with `shotId`) is never changed by a rebuild
 * (see `isBoardLinkedClip` and its use in App.tsx). Board changes arrive as
 * STRUCTURED UPDATES — "shot X now plays take Y", "shot X is 3.2 s", "shot X
 * is gone", "the shots are in this order" — and each is applied here through
 * the editor's own undoable actions, keeping everything the person did in the
 * editor: the clip's start, its trim window, fades, effects, captions.
 *
 * ── HOW THEY GET HERE ───────────────────────────────────────────────────────
 * The website writes each batch to `scene_lists/{id}/board_updates` and, when
 * this editor is open, routes it to the host page as the client tool
 * `apply_board_update` (the same routed dispatch every agent→editor call uses).
 * The host posts `voidspace:apply-board-update` to this iframe. When the
 * editor was closed, the host drains the pending batches once this project
 * has loaded. Either way the work happens HERE, after `markBoardProjectReady`.
 *
 * ── IDEMPOTENT BY DESIGN ────────────────────────────────────────────────────
 * Every update says what the timeline SHOULD hold, not what to do to it. A
 * batch delivered live and then drained again on the next open is a no-op the
 * second time ("unchanged"), so delivery can be at-least-once.
 */
import type { Clip, MediaItem, Project, Track } from "@openreel/core";
import { useProjectStore } from "../stores/project-store";
import { replaceClipTake } from "./replace-clip-take";
import { ensureUrlMedia } from "./url-media";
import { normSwapUrl } from "./live-swap-authority";
import {
  asOneUndoStep, carryOwnedCaptions, clipWindow, ownedCaptions, removeOwnedCaptions,
} from "./caption-cascade";

export type BoardUpdateKind = "take" | "first_frame" | "retime" | "remove" | "reorder";

export interface BoardUpdate {
  kind: BoardUpdateKind;
  /** The board shot (every kind but `reorder`). */
  shotId?: string;
  /** `take`: the file that now plays. `first_frame`: the still. */
  url?: string;
  posterUrl?: string;
  /** `retime`: the shot's new length. `take`: the take's measured length, a hint. */
  durationSec?: number;
  /** `take` for a shot the cut does not have yet: the shot before it on the board. */
  afterShotId?: string;
  /** `take`: every take url this shot has had — finds a hand-placed clip that plays one. */
  takeUrls?: string[];
  /** `take`: the shot is new to this video (not in its last compile) — only then append. */
  newShot?: boolean;
  /** `reorder`: every shot id in board order. */
  order?: string[];
  /** The shot's title, for names and messages. */
  title?: string;
}

export interface BoardUpdateResult {
  kind: BoardUpdateKind | string;
  shotId?: string;
  status: "applied" | "unchanged" | "skipped" | "failed";
  detail: string;
  clipId?: string;
  startTime?: number;
  duration?: number;
}

type Located = { clip: Clip; track: Track };

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * A clip the board owns. A rebuild must never change one: its media and its
 * layout reach the editor only through a structured update. Alternate takes
 * (`clip-take-<shot>-<take>`) carry `shotId` too, so they are covered.
 */
export function isBoardLinkedClip(clip: { shotId?: string } | null | undefined): boolean {
  return !!clip?.shotId;
}

const isAuxShotClip = (id: string) =>
  id.startsWith("clip-take-") || id.startsWith("clip-graphic-") || id.startsWith("clip-sfx-")
  || id.startsWith("clip-narration-") || id.startsWith("caption-");

/**
 * The clip that IS this shot on the timeline: `clip-video-<shotId>` (what
 * compile + the loader mint), else `clip-image-<shotId>`, else the earliest
 * picture clip that names the shot and is not an alternate, graphic or sound.
 */
export function findShotClip(project: Project, shotId: string): Located | null {
  if (!shotId) return null;
  const tracks = project.timeline?.tracks ?? [];
  for (const id of [`clip-video-${shotId}`, `clip-image-${shotId}`]) {
    for (const track of tracks) {
      const clip = track.clips.find((c) => c.id === id);
      if (clip) return { clip, track };
    }
  }
  let best: Located | null = null;
  for (const track of tracks) {
    if (track.type !== "video" && track.type !== "image") continue;
    for (const clip of track.clips) {
      if (clip.shotId !== shotId || isAuxShotClip(clip.id)) continue;
      if (!best || clip.startTime < best.clip.startTime) best = { clip, track };
    }
  }
  return best;
}

/** Everything on the timeline that belongs to one shot: its clip, alternates,
 *  graphics, its narration and sound effects. */
export function shotFamily(project: Project, shotId: string): Located[] {
  if (!shotId) return [];
  const out: Located[] = [];
  const mine = (id: string) =>
    id === `clip-video-${shotId}` || id === `clip-image-${shotId}` || id === `clip-narration-${shotId}`
    || id.startsWith(`clip-take-${shotId}-`) || id.startsWith(`clip-graphic-${shotId}-`)
    || id.startsWith(`clip-sfx-${shotId}-`);
  for (const track of project.timeline?.tracks ?? []) {
    for (const clip of track.clips) {
      if (mine(clip.id) || clip.shotId === shotId) out.push({ clip, track });
    }
  }
  return out;
}

/** The main picture track: `track-video` when present, else the first video track. */
export function mainVideoTrack(project: Project): Track | null {
  const tracks = project.timeline?.tracks ?? [];
  return tracks.find((t) => t.id === "track-video")
    ?? tracks.find((t) => t.type === "video")
    ?? null;
}

const overlaps = (clips: ReadonlyArray<{ id: string; startTime: number; duration: number }>, start: number, dur: number, except?: Set<string>) =>
  clips.some((c) => !except?.has(c.id) && start < c.startTime + c.duration - 1e-3 && start + dur > c.startTime + 1e-3);

/**
 * Where a shot the cut does not have yet goes: right after the shot before it
 * on the board when that gap is free, otherwise at the end of the track. Never
 * on top of anything, never pushing anything.
 */
export function planAppendStart(track: Track, after: Clip | null, duration: number): number {
  if (after) {
    const start = after.startTime + after.duration;
    if (!overlaps(track.clips, start, duration)) return start;
  }
  return Math.max(0, ...track.clips.map((c) => c.startTime + c.duration));
}

/**
 * A retime keeps the clip's START and its IN-POINT and changes only how long it
 * plays — clamped to what the media holds and to the free room before the next
 * clip on the same track. Nothing is pushed: a retime that would overlap the
 * next clip stops at it, and says so.
 */
export function planRetime(
  clip: Pick<Clip, "startTime" | "duration" | "inPoint" | "outPoint" | "speed">,
  mediaDuration: number,
  targetSec: number,
  nextStart: number,
): { inPoint: number; outPoint: number; duration: number; clampedBy: "" | "media" | "next clip" } {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  let inPoint = Math.max(0, clip.inPoint ?? 0);
  let span = Math.max(0.05, targetSec) * speed;
  let clampedBy: "" | "media" | "next clip" = "";
  if (mediaDuration > 0) {
    if (inPoint + span > mediaDuration) {
      // Slide the window back before shortening it: a longer shot should show
      // more of the take, not stop at the old in-point's end.
      inPoint = Math.max(0, mediaDuration - span);
      if (inPoint + span > mediaDuration) { span = mediaDuration - inPoint; clampedBy = "media"; }
    }
  }
  if (Number.isFinite(nextStart)) {
    const room = (nextStart - clip.startTime) * speed;
    if (span > room) { span = Math.max(0.05, room); clampedBy = "next clip"; }
  }
  span = Math.max(0.05, span);
  return { inPoint, outPoint: inPoint + span, duration: span / speed, clampedBy };
}

export type ReorderPlan =
  | { status: "unchanged"; detail: string }
  | { status: "failed"; detail: string }
  | { status: "move"; moves: Array<{ shotId: string; clipId: string; from: number; to: number }> };

/**
 * Put the shots' clips in the board's order, IN THE SLOTS THEY ALREADY HOLD.
 *
 * The first slot keeps its start and every gap the editor left between slots
 * stays where it was (by position, not by shot); each clip keeps its own
 * length and trim. Clips of other shots and anything not on the board stay
 * put — a plan that would land on one of them is refused, not forced.
 */
export function planReorder(project: Project, order: ReadonlyArray<string>): ReorderPlan {
  const entries = order
    .map((shotId) => ({ shotId, at: findShotClip(project, shotId) }))
    .filter((e): e is { shotId: string; at: Located } => !!e.at);
  if (entries.length < 2) return { status: "unchanged", detail: "Fewer than two of these shots are on the timeline." };
  const trackId = entries[0].at.track.id;
  if (entries.some((e) => e.at.track.id !== trackId)) {
    return { status: "failed", detail: "These shots are on different tracks, so their order is the editor's call. Ask the video agent to rearrange them." };
  }
  const slots = [...entries].sort((a, b) => a.at.clip.startTime - b.at.clip.startTime);
  if (entries.every((e, i) => e.at.clip.id === slots[i].at.clip.id)) {
    return { status: "unchanged", detail: "The timeline already plays these shots in the board's order." };
  }
  const gaps = slots.map((s, i) => i + 1 < slots.length
    ? Math.max(0, slots[i + 1].at.clip.startTime - (s.at.clip.startTime + s.at.clip.duration))
    : 0);
  let cursor = slots[0].at.clip.startTime;
  const moves = entries.map((e, i) => {
    const to = cursor;
    cursor += e.at.clip.duration + gaps[i];
    return { shotId: e.shotId, clipId: e.at.clip.id, from: e.at.clip.startTime, to };
  });
  const moving = new Set(moves.map((m) => m.clipId));
  const track = entries[0].at.track;
  for (const m of moves) {
    const clip = track.clips.find((c) => c.id === m.clipId)!;
    if (overlaps(track.clips, m.to, clip.duration, moving)) {
      return { status: "failed", detail: `Reordering would put shot ${m.shotId} on top of another clip on this track. Nothing was moved; ask the video agent to rearrange the cut.` };
    }
  }
  return { status: "move", moves };
}

/** Only files a browser may fetch for the user: http(s) or a same-origin path. */
export function isFetchableMediaUrl(url: string): boolean {
  try {
    const base = typeof location !== "undefined" ? location.origin : "https://voidspace.ai";
    const u = new URL(url, base);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// ── Readiness ──────────────────────────────────────────────────────────────
//
// An update applied before the project has loaded would find no clips and ADD
// a shot that is already in the saved cut. So nothing is applied until App.tsx
// says which project is on screen.

let readyProject: string | null = null;
let readyWaiters: Array<() => void> = [];

export function markBoardProjectReady(projectId: string): void {
  readyProject = projectId;
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const w of waiters) w();
}

/** Test hook: forget the loaded project. */
export function _resetBoardProjectReady(): void {
  readyProject = null;
  readyWaiters = [];
}

export function whenBoardProjectReady(projectId: string, timeoutMs = 90_000): Promise<void> {
  const check = () => {
    if (readyProject !== projectId) {
      throw new Error(`This editor holds project ${readyProject}, not ${projectId}. Nothing was changed.`);
    }
  };
  if (readyProject) { try { check(); return Promise.resolve(); } catch (e) { return Promise.reject(e); } }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      readyWaiters = readyWaiters.filter((w) => w !== done);
      reject(new Error("The project did not finish loading in time. The update is kept and applies on the next open."));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      try { check(); resolve(); } catch (e) { reject(e); }
    };
    readyWaiters.push(done);
  });
}

// ── Execution ──────────────────────────────────────────────────────────────

const store = () => useProjectStore.getState();
const project = () => store().project;

function clipNow(clipId: string): Located | null {
  for (const track of project().timeline?.tracks ?? []) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

/**
 * Make a clip the one that IS this board shot, so the board's updates land on
 * it. Hand-placed clips (a take swapped in from the Library, a local re-render)
 * carry no shotId; without the link a new take for that shot had nowhere to go.
 * One shot, one clip: any other clip holding the shot is unlinked.
 */
export function linkClipToShot(clipId: string, shotId: string): boolean {
  let found = false;
  useProjectStore.setState((s) => ({
    project: {
      ...s.project,
      timeline: {
        ...s.project.timeline,
        tracks: s.project.timeline.tracks.map((tr) => ({
          ...tr,
          clips: tr.clips.map((c) => {
            if (c.id === clipId) { found = true; return { ...c, shotId: shotId || undefined } as Clip; }
            if (shotId && (c as Clip).shotId === shotId && !isAuxShotClip(c.id)) return { ...c, shotId: undefined } as Clip;
            return c;
          }),
        })),
      },
      modifiedAt: Date.now(),
    },
  }));
  return found;
}

/** A picture clip on the timeline playing one of these urls (a take of the shot). */
function clipPlayingOneOf(urls: string[]): Located | null {
  const want = new Set(urls.map(normSwapUrl).filter(Boolean));
  if (!want.size) return null;
  for (const track of project().timeline.tracks) {
    if (track.type !== "video" && track.type !== "image") continue;
    for (const clip of track.clips) {
      const u = mediaOf(clip.mediaId)?.originalUrl;
      if (u && want.has(normSwapUrl(u))) return { clip, track };
    }
  }
  return null;
}

function mediaOf(mediaId: string): MediaItem | undefined {
  return store().getMediaItem(mediaId);
}

const label = (u: BoardUpdate) => (u.title ? `"${u.title}"` : `shot ${u.shotId}`);

async function applyPicture(u: BoardUpdate, mediaType: "video" | "image"): Promise<BoardUpdateResult> {
  const shotId = String(u.shotId ?? "");
  const url = String(u.url ?? "");
  const base = { kind: u.kind, shotId };
  if (!shotId || !url) return { ...base, status: "failed", detail: "A take update needs a shotId and a url." };
  if (!isFetchableMediaUrl(url)) return { ...base, status: "failed", detail: "That media url cannot be fetched by the editor." };

  let found = findShotClip(project(), shotId);
  if (!found && Array.isArray(u.takeUrls) && u.takeUrls.length) {
    // A clip placed by hand that plays one of this shot's takes IS the shot.
    const playing = clipPlayingOneOf(u.takeUrls);
    if (playing && !(playing.clip as Clip).shotId) {
      linkClipToShot(playing.clip.id, shotId);
      found = clipNow(playing.clip.id) ?? playing;
    }
  }
  if (found) {
    const current = mediaOf(found.clip.mediaId);
    if (u.kind === "first_frame" && current && current.type !== "image") {
      return {
        ...base, status: "unchanged", clipId: found.clip.id,
        detail: `${label(u)} plays a video take; a new first frame only seeds its next generation, so the clip was left as it is.`,
      };
    }
    if (current?.originalUrl && normSwapUrl(current.originalUrl) === normSwapUrl(url)) {
      return { ...base, status: "unchanged", clipId: found.clip.id, detail: `${label(u)} already plays this take.` };
    }
    const ensured = await ensureUrlMedia({
      url, trackKind: "video", mediaType,
      name: u.title ? `${u.title} · board take` : "Board take",
      posterUrl: u.posterUrl, durationSec: u.durationSec,
    });
    const r = await replaceClipTake(found.clip.id, ensured.mediaId);
    if (!r.ok) {
      if (/already uses/i.test(r.reason)) return { ...base, status: "unchanged", clipId: found.clip.id, detail: `${label(u)} already plays this take.` };
      return { ...base, status: "failed", clipId: found.clip.id, detail: r.reason };
    }
    const after = clipNow(found.clip.id)?.clip ?? found.clip;
    return {
      ...base, status: "applied", clipId: after.id, startTime: round(after.startTime), duration: round(after.duration),
      detail: `${label(u)} now plays the new take at ${round(after.startTime)}s — same start, `
        + `${round(after.duration)}s long, trim kept${Math.abs(after.duration - found.clip.duration) > 0.02 ? " (shortened to fit the new take)" : ""}. Ctrl+Z restores the old take.`,
    };
  }

  if (u.kind === "first_frame") {
    return { ...base, status: "skipped", detail: `${label(u)} has no clip on the timeline, so there is nothing to show its first frame on.` };
  }
  // The cut already has this shot, but no clip is linked to it (placed by
  // hand from a re-render). Appending would put a stray copy at the end of the
  // track; say what is missing instead.
  if (!u.newShot) {
    return {
      ...base, status: "skipped",
      detail: `No clip in the cut is linked to ${label(u)}, so the new take was not placed. Ask the video agent `
        + `to link the clip that plays this shot (edit_clip with linkShotId), then send the update again.`,
    };
  }
  // A shot the cut does not have yet.
  const track = mainVideoTrack(project());
  if (!track) return { ...base, status: "failed", detail: "This project has no video track to put the shot on." };
  const ensured = await ensureUrlMedia({
    url, trackKind: "video", mediaType,
    name: u.title ? `${u.title} · board take` : "Board take",
    posterUrl: u.posterUrl, durationSec: u.durationSec,
  });
  const duration = ensured.duration || (u.durationSec && u.durationSec > 0 ? u.durationSec : 5);
  const prev = u.afterShotId ? findShotClip(project(), u.afterShotId) : null;
  const fresh = project().timeline.tracks.find((t) => t.id === track.id) ?? track;
  const startTime = planAppendStart(fresh, prev && prev.track.id === track.id ? prev.clip : null, duration);
  const clipId = `clip-video-${shotId}`;
  const r = await store().executeAction({
    type: "clip/add",
    id: `board-add-${Date.now().toString(36)}`,
    timestamp: Date.now(),
    params: { trackId: track.id, mediaId: ensured.mediaId, startTime, duration, __addedId: clipId },
  } as never);
  if (!r.success) return { ...base, status: "failed", detail: r.error?.message ?? "The shot could not be added." };
  return {
    ...base, status: "applied", clipId, startTime: round(startTime), duration: round(duration),
    detail: `${label(u)} was not in the cut; added at ${round(startTime)}s on ${track.id}`
      + `${prev && Math.abs(startTime - (prev.clip.startTime + prev.clip.duration)) < 1e-3 ? " right after the shot before it" : " at the end (no free room after the shot before it)"}. Nothing else moved.`,
  };
}

async function applyRetime(u: BoardUpdate): Promise<BoardUpdateResult> {
  const shotId = String(u.shotId ?? "");
  const target = Number(u.durationSec);
  const base = { kind: u.kind, shotId };
  if (!shotId || !(target > 0)) return { ...base, status: "failed", detail: "A retime needs a shotId and durationSec > 0." };
  const found = findShotClip(project(), shotId);
  if (!found) return { ...base, status: "skipped", detail: `${label(u)} has no clip on the timeline to retime.` };
  const media = mediaOf(found.clip.mediaId);
  const md = media && media.type !== "image" ? Number(media.metadata?.duration) || 0 : 0;
  const nextStart = found.track.clips
    .filter((c) => c.id !== found.clip.id && c.startTime > found.clip.startTime + 1e-6)
    .reduce((m, c) => Math.min(m, c.startTime), Infinity);
  const plan = planRetime(found.clip, md, target, nextStart);
  if (Math.abs(plan.duration - found.clip.duration) < 0.02 && Math.abs(plan.inPoint - (found.clip.inPoint ?? 0)) < 1e-3) {
    return { ...base, status: "unchanged", clipId: found.clip.id, detail: `${label(u)} is already ${round(found.clip.duration)}s.` };
  }
  const owned = ownedCaptions(found.clip.id);
  const before = clipWindow(found.clip.id);
  let error = "";
  await asOneUndoStep("Retime from board", async () => {
    const r = await store().trimClip(found.clip.id, plan.inPoint, plan.outPoint);
    if (!r.success) { error = r.error?.message ?? "trim failed"; return; }
    if (before && owned.length) await carryOwnedCaptions(found.clip.id, before, owned);
  });
  if (error) return { ...base, status: "failed", clipId: found.clip.id, detail: error };
  return {
    ...base, status: "applied", clipId: found.clip.id, startTime: round(found.clip.startTime), duration: round(plan.duration),
    detail: `${label(u)} now plays ${round(plan.duration)}s from ${round(found.clip.startTime)}s (start kept)`
      + (plan.clampedBy ? `; asked ${round(target)}s, but the ${plan.clampedBy} allows only that much` : "")
      + ". Nothing else moved.",
  };
}

async function applyRemove(u: BoardUpdate): Promise<BoardUpdateResult> {
  const shotId = String(u.shotId ?? "");
  const base = { kind: u.kind, shotId };
  if (!shotId) return { ...base, status: "failed", detail: "A remove needs a shotId." };
  const family = shotFamily(project(), shotId);
  if (!family.length) return { ...base, status: "unchanged", detail: `${label(u)} has nothing on the timeline.` };
  let removed = 0;
  const errors: string[] = [];
  await asOneUndoStep("Remove shot from board", async () => {
    for (const { clip } of family) {
      const owned = ownedCaptions(clip.id);
      const r = await store().removeClip(clip.id);
      if (!r.success) { errors.push(r.error?.message ?? `could not remove ${clip.id}`); continue; }
      removed++;
      if (owned.length) await removeOwnedCaptions(owned);
    }
  });
  if (!removed) return { ...base, status: "failed", detail: errors.join("; ") || "Nothing could be removed." };
  return {
    ...base, status: "applied",
    detail: `Removed ${removed} clip${removed === 1 ? "" : "s"} of ${label(u)}; the gap is left where it was (no ripple). Ctrl+Z puts them back.`,
  };
}

async function applyReorder(u: BoardUpdate): Promise<BoardUpdateResult> {
  const order = Array.isArray(u.order) ? u.order.map(String).filter(Boolean) : [];
  const base = { kind: u.kind };
  if (order.length < 2) return { ...base, status: "failed", detail: "A reorder needs the board's shot order." };
  const plan = planReorder(project(), order);
  if (plan.status !== "move") return { ...base, status: plan.status, detail: plan.detail };
  let moved = 0;
  await asOneUndoStep("Reorder from board", async () => {
    for (const m of plan.moves) {
      const delta = m.to - m.from;
      if (Math.abs(delta) < 1e-6) continue;
      // The whole shot travels: its alternates, graphics and sound go with it,
      // and so do the captions each of those owns.
      for (const { clip, track } of shotFamily(project(), m.shotId)) {
        const before = clipWindow(clip.id);
        const owned = ownedCaptions(clip.id);
        const r = await store().moveClip(clip.id, Math.max(0, clip.startTime + delta), track.id);
        if (!r.success) continue;
        if (clip.id === m.clipId) moved++;
        if (before && owned.length) await carryOwnedCaptions(clip.id, before, owned);
      }
    }
  });
  return {
    ...base, status: moved ? "applied" : "failed",
    detail: moved
      ? `Re-sequenced ${moved} shot${moved === 1 ? "" : "s"} into the board's order, in the slots they already held — lengths, trims and gaps kept. Ctrl+Z undoes it.`
      : "No shot could be moved.",
  };
}

export async function applyBoardUpdate(u: BoardUpdate): Promise<BoardUpdateResult> {
  try {
    switch (u?.kind) {
      case "take": return await applyPicture(u, "video");
      case "first_frame": return await applyPicture(u, "image");
      case "retime": return await applyRetime(u);
      case "remove": return await applyRemove(u);
      case "reorder": return await applyReorder(u);
      default: return { kind: String(u?.kind ?? ""), shotId: u?.shotId, status: "failed", detail: `Unknown update kind "${u?.kind}".` };
    }
  } catch (e) {
    return { kind: u.kind, shotId: u.shotId, status: "failed", detail: String((e as Error)?.message ?? e) };
  }
}

/** Apply a batch in order. One failure never stops the rest. */
export async function applyBoardUpdates(updates: ReadonlyArray<BoardUpdate>): Promise<BoardUpdateResult[]> {
  const out: BoardUpdateResult[] = [];
  for (const u of updates ?? []) out.push(await applyBoardUpdate(u));
  return out;
}

/** The RPC's entry point: wait for THIS project, then apply. */
export async function applyBoardUpdatesFor(projectId: string, updates: ReadonlyArray<BoardUpdate>): Promise<BoardUpdateResult[]> {
  await whenBoardProjectReady(projectId);
  return applyBoardUpdates(updates);
}
