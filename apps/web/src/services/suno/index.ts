/**
 * Suno audio operations client (editor side).
 *
 * Talks to the Voidspace Studio server proxies — never to Kie directly —
 * so the central kie.ai key and the credit ledger stay server-side:
 *
 *   POST /api/studio/upload-temp   → public URL for an uploaded clip's audio
 *   POST /api/studio/suno-op       → run a Suno op (charges credits on success)
 *   GET  /api/studio/media-proxy   → CORS-fronted download of the result
 *
 * Auth: the user's Firebase ID token, forwarded as `Authorization: Bearer`,
 * exactly like voidspace-publish.ts. The server resolves the UID and
 * debits that user's Voidspace credits.
 *
 * Operations that act on ANY audio (upload first): cover, extend, add_vocals,
 * add_instrumental. Operations that need a Suno-origin source (taskId +
 * audioId carried on the MediaItem): separate, wav, timestamped_lyrics, and
 * the native `extend` path.
 */

import { v4 as uuidv4 } from "uuid";
import { auth } from "../../config/firebase-config";
import { useProjectStore } from "../../stores/project-store";
import type { MediaItem } from "@openreel/core";

export type SunoOp =
  | "cover"
  | "extend"
  | "add_vocals"
  | "add_instrumental"
  | "separate"
  | "wav"
  | "timestamped_lyrics"
  | "boost_style";

/**
 * Display-only credit costs per op. MUST mirror the server's source of
 * truth (studio/src/models/registry.ts → SUNO_OP_PRICING); the actual
 * charge is computed server-side, this is just for the UI badge.
 */
export const SUNO_OP_COST: Record<SunoOp, number> = {
  cover: 24,
  extend: 24,
  add_vocals: 24,
  add_instrumental: 24,
  separate: 8,
  wav: 4,
  timestamped_lyrics: 2,
  boost_style: 1,
};

export interface SunoTrack {
  url: string;
  audioId: string;
  title?: string;
  duration?: number;
  imageUrl?: string;
}

export interface SunoTracksResult {
  result: { tracks: SunoTrack[]; taskId: string };
  charged: number;
  balance: number;
}

export interface SunoSeparateResult {
  result: { vocalUrl: string; instrumentalUrl: string; originUrl?: string };
  charged: number;
  balance: number;
}

export interface SunoWavResult {
  result: { wavUrl: string };
  charged: number;
  balance: number;
}

export interface SunoLyricsWord {
  word: string;
  success: boolean;
  startS: number;
  endS: number;
}

export interface SunoLyricsResult {
  result: { alignedWords: SunoLyricsWord[]; waveformData?: number[] };
  charged: number;
  balance: number;
}

export interface SunoBoostResult {
  result: string;
  charged: number;
  balance: number;
}

// ── transport ────────────────────────────────────────────────────────────────

async function authHeader(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to use AI audio tools.");
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

/** Same origin-resolution rule as voidspace-publish.ts. */
function apiBase(): string {
  if (typeof window !== "undefined") {
    try {
      if (window.parent && window.parent !== window) {
        return window.parent.location.origin;
      }
    } catch {
      /* cross-origin — use current origin */
    }
  }
  return "";
}

/** Pull a friendly error message out of an h3 createError JSON body. */
async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw);
    return j?.statusMessage || j?.message || j?.statusText || raw || `HTTP ${res.status}`;
  } catch {
    return raw || `HTTP ${res.status}`;
  }
}

// ── upload the selected clip's audio → public URL ──────────────────────────────

/**
 * Make the selected clip's audio reachable by Kie's Suno endpoint.
 * Uses the clip's local blob when available (multipart), else relays its
 * remote `originalUrl` via the JSON branch of /api/studio/upload-temp.
 */
export async function uploadClipAudio(
  item: MediaItem,
  signal?: AbortSignal,
): Promise<string> {
  const headers = await authHeader();
  const base = apiBase();

  let res: Response;
  if (item.blob) {
    const form = new FormData();
    const name = (item.name || "audio").replace(/[^a-zA-Z0-9._-]/g, "_");
    form.append("file", item.blob, name.includes(".") ? name : `${name}.mp3`);
    res = await fetch(`${base}/api/studio/upload-temp`, {
      method: "POST",
      headers,
      body: form,
      signal,
    });
  } else if (item.originalUrl) {
    res = await fetch(`${base}/api/studio/upload-temp`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: item.originalUrl, filename: item.name }),
      signal,
    });
  } else {
    throw new Error("This clip has no audio data to upload.");
  }

  if (!res.ok) throw new Error(`Upload failed: ${await errorText(res)}`);
  const data = (await res.json()) as { url?: string };
  if (!data.url) throw new Error("Upload returned no URL.");
  return data.url;
}

// ── run an operation ───────────────────────────────────────────────────────────

async function postOp<T>(
  op: SunoOp,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const headers = await authHeader();
  const base = apiBase();
  const res = await fetch(`${base}/api/studio/suno-op`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      // Fresh key per invocation: a refresh mid-call recovers the result
      // and never double-charges (server-side withReceipt).
      "Idempotency-Key": `suno-${op}-${uuidv4()}`,
    },
    body: JSON.stringify({ op, ...params }),
    signal,
  });
  if (!res.ok) {
    const err = new Error(await errorText(res)) as Error & { statusCode?: number };
    err.statusCode = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export function coverClip(uploadUrl: string, params: Record<string, unknown>, signal?: AbortSignal) {
  return postOp<SunoTracksResult>("cover", { uploadUrl, ...params }, signal);
}
export function extendClipUpload(uploadUrl: string, params: Record<string, unknown>, signal?: AbortSignal) {
  return postOp<SunoTracksResult>("extend", { uploadUrl, ...params }, signal);
}
export function extendClipNative(audioId: string, params: Record<string, unknown>, signal?: AbortSignal) {
  return postOp<SunoTracksResult>("extend", { audioId, ...params }, signal);
}
export function addVocalsToClip(uploadUrl: string, params: Record<string, unknown>, signal?: AbortSignal) {
  return postOp<SunoTracksResult>("add_vocals", { uploadUrl, ...params }, signal);
}
export function addInstrumentalToClip(uploadUrl: string, params: Record<string, unknown>, signal?: AbortSignal) {
  return postOp<SunoTracksResult>("add_instrumental", { uploadUrl, ...params }, signal);
}
export function separateClipStems(taskId: string, audioId: string, signal?: AbortSignal) {
  return postOp<SunoSeparateResult>("separate", { taskId, audioId }, signal);
}
export function convertClipToWav(taskId: string, audioId: string, signal?: AbortSignal) {
  return postOp<SunoWavResult>("wav", { taskId, audioId }, signal);
}
export function getClipTimestampedLyrics(taskId: string, audioId: string, signal?: AbortSignal) {
  return postOp<SunoLyricsResult>("timestamped_lyrics", { taskId, audioId }, signal);
}
export function boostStyleText(content: string, signal?: AbortSignal) {
  return postOp<SunoBoostResult>("boost_style", { content }, signal);
}

// ── import a result into the timeline ──────────────────────────────────────────

/**
 * Same-origin URL for previewing a remote result in an <audio> element.
 * Routes through the studio media proxy (no auth needed, host-allowlisted)
 * so playback isn't blocked by CORS/CSP on the Kie/Suno host.
 */
export function proxiedMediaUrl(remoteUrl: string): string {
  return `${apiBase()}/api/studio/media-proxy?url=${encodeURIComponent(remoteUrl)}`;
}

/** Download a remote result URL through the same-origin CORS proxy. */
export async function downloadResult(url: string, signal?: AbortSignal): Promise<Blob> {
  const base = apiBase();
  const headers = await authHeader();
  const proxied = `${base}/api/studio/media-proxy?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxied, { headers, signal });
  if (!res.ok) throw new Error(`Download failed: ${await errorText(res)}`);
  const blob = await res.blob();
  if (blob.size === 0) throw new Error("Downloaded audio was empty.");
  return blob;
}

export interface SunoLineage {
  sunoTaskId?: string;
  sunoAudioId?: string;
}

/** Where to put a produced track. The user chooses per result. */
export type PlacementMode = "new-track" | "after-clip" | "library";

/**
 * Download a produced track and import it into the media library (only) —
 * stamping its Suno lineage so downstream Suno-native ops (separate / wav /
 * lyrics / native-extend) light up. Returns the new media id. Placement on
 * the timeline is a separate, user-chosen step (placeMedia).
 */
export async function importResultToLibrary(
  url: string,
  name: string,
  lineage: SunoLineage = {},
  signal?: AbortSignal,
): Promise<string> {
  const { importMedia } = useProjectStore.getState();
  const blob = await downloadResult(url, signal);
  const ext = blob.type.includes("wav") ? "wav" : "mp3";
  const safe = name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 80) || "AI Audio";
  const file = new File([blob], `${safe}.${ext}`, { type: blob.type || "audio/mpeg" });

  const imported = await importMedia(file);
  if (!imported.success || !imported.actionId) {
    const err = imported.error as unknown;
    const msg =
      typeof err === "string"
        ? err
        : (err as { message?: string })?.message ?? "Failed to import audio";
    throw new Error(msg);
  }
  const mediaId = imported.actionId;

  // Stamp Suno lineage + a friendly name on the media item. Direct
  // setState mirrors AIMusicSection.ensureInLibrary — the store has no
  // generic patch method and a focused write keeps this self-contained.
  if (lineage.sunoTaskId || lineage.sunoAudioId) {
    const { project } = useProjectStore.getState();
    if (project) {
      useProjectStore.setState({
        project: {
          ...project,
          mediaLibrary: {
            ...project.mediaLibrary,
            items: project.mediaLibrary.items.map((m) =>
              m.id === mediaId
                ? { ...m, name: safe, sunoTaskId: lineage.sunoTaskId, sunoAudioId: lineage.sunoAudioId }
                : m,
            ),
          },
          modifiedAt: Date.now(),
        },
      });
    }
  }
  return mediaId;
}

/** Resolve the track id + end time of a clip (for "after-clip" placement). */
export function clipPlacementContext(clipId: string): { trackId: string; endTime: number; startTime: number } | null {
  const { project } = useProjectStore.getState();
  const tracks = project?.timeline?.tracks ?? [];
  for (const t of tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return { trackId: t.id, startTime: c.startTime, endTime: c.startTime + c.duration };
  }
  return null;
}

/**
 * Place an already-imported media item on the timeline per the chosen mode:
 *   new-track  → fresh audio track, aligned to `alignStart` (the source clip's start)
 *   after-clip → same track as the source clip, starting at its end (continuation)
 *   library    → no timeline placement (already in the library)
 */
export async function placeMedia(
  mediaId: string,
  mode: PlacementMode,
  ctx?: { trackId?: string; startTime?: number },
): Promise<void> {
  const { addClipToNewTrack, addClip } = useProjectStore.getState();
  if (mode === "library") return;
  if (mode === "after-clip" && ctx?.trackId != null && typeof ctx.startTime === "number") {
    await addClip(ctx.trackId, mediaId, ctx.startTime);
    return;
  }
  // new-track (default) — align to the source clip's start when known
  await addClipToNewTrack(mediaId, typeof ctx?.startTime === "number" ? ctx.startTime : undefined);
}
