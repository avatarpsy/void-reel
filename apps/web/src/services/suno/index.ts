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
 * add_instrumental, mashup, separate. Operations that need a Suno-origin source (taskId +
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
  | "replace_section"
  | "mashup"
  | "sounds"
  | "separate"
  | "midi"
  | "persona"
  | "wav"
  | "timestamped_lyrics"
  | "boost_style";

/** How deep to split a track. Kie prices these 8 / 40 / 16 credits. */
export type SeparateType = "separate_vocal" | "split_stem" | "split_stem_advanced";

/**
 * Credit cost shown on the buttons.
 *
 * These are the FINAL BILLED numbers, not a pre-margin basis. The panel used
 * to show the server's cost BASIS (24 for a cover) while the ledger charged
 * basis x the music factor — so every price in the UI was wrong. Keep these in
 * step with `sunoOpCost()` in studio/src/models/registry.ts:
 *
 *     billed = kie list price in credits x PROVIDER_COST_RATIO x MARGIN.music
 *            = basis x 0.5 x 1.25
 *            = basis x 0.625
 *
 * The authoritative number still comes back on every response as `charged`,
 * which is what the toast reports.
 */
export const SUNO_OP_COST: Record<SunoOp, number> = {
  cover: 3.75,
  extend: 3.75,
  add_vocals: 3.75,
  add_instrumental: 3.75,
  mashup: 3.75,
  replace_section: 1.56,
  sounds: 0.78,
  separate: 3.13, // 2-stem; see separateCost() for the deeper splits
  midi: 0, // free upstream
  persona: 0, // free upstream
  wav: 0.13,
  timestamped_lyrics: 0.16,
  boost_style: 0.13,
};

/** Badge cost for a separation, which depends on the split depth. */
export function separateCost(type: SeparateType): number {
  if (type === "split_stem") return 15.63;
  if (type === "split_stem_advanced") return 6.25;
  return SUNO_OP_COST.separate;
}

/** Stems the advanced split can target. Any string works upstream; these are
 *  the ones worth offering in a picker. */
export const ADVANCED_STEM_NAMES = [
  "Lead Vocal", "Backing Vocals", "Drum Kit", "Kick", "Snare", "Hi-Hat",
  "Bass", "Piano", "Electric Guitar", "Acoustic Guitar", "Strings",
  "Brass", "Woodwinds", "Synth", "Organ", "Percussion", "FX",
] as const;

/** Keys Suno accepts for a Sounds generation. */
export const SOUND_KEYS = [
  "C Major", "C Minor", "C# Major", "C# Minor", "D Major", "D Minor",
  "D# Major", "D# Minor", "E Major", "E Minor", "F Major", "F Minor",
  "F# Major", "F# Minor", "G Major", "G Minor", "G# Major", "G# Minor",
  "A Major", "A Minor", "A# Major", "A# Minor", "B Major", "B Minor",
] as const;

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

export interface SunoStem {
  key: string;
  label: string;
  url: string;
}

export interface SunoSeparateResult {
  result: {
    vocalUrl: string;
    instrumentalUrl: string;
    stems: SunoStem[];
    /** The SEPARATION task's id — feed this to MIDI transcription. */
    taskId: string;
    originUrl?: string;
  };
  charged: number;
  balance: number;
}

export interface SunoPersonaResult {
  result: { personaId: string; name: string; description: string };
  charged: number;
  balance: number;
}

export interface SunoMidiInstrument {
  name: string;
  notes: Array<{ pitch: number; start: number; end: number; velocity: number }>;
}

export interface SunoMidiResult {
  result: { instruments: SunoMidiInstrument[]; noteCount: number; midiBase64: string };
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

/** Container formats Suno's upload endpoints accept as-is. */
const SUNO_SAFE_AUDIO = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const SUNO_SAFE_MIME = /(mpeg|mp3|wav|wave|aac|ogg|flac|mp4|m4a)/i;

/**
 * Decode any browser-decodable audio and re-encode it as a 16-bit mono WAV.
 *
 * Why this exists: the recorder captures `audio/webm;codecs=opus`, and the old
 * upload path shipped those bytes under a `.mp3` filename. Suno then received a
 * file whose extension lied about its contents. Mono halves the payload (a
 * 3-minute stereo WAV is ~31MB, over the 20MB separation cap) and costs nothing
 * musically for a vocal take.
 *
 * Returns null when the browser can't decode the blob — the caller then uploads
 * the original rather than failing, which is no worse than the old behaviour.
 */
async function toMonoWav(blob: Blob): Promise<Blob | null> {
  const Ctx: typeof AudioContext | undefined =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = buf.length;
    if (!frames) return null;

    // Downmix every channel to one, averaged.
    const mono = new Float32Array(frames);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < frames; i++) mono[i] += data[i];
    }
    if (buf.numberOfChannels > 1) {
      for (let i = 0; i < frames; i++) mono[i] /= buf.numberOfChannels;
    }

    const rate = buf.sampleRate;
    const bytes = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(bytes);
    const ascii = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + frames * 2, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);      // PCM chunk size
    view.setUint16(20, 1, true);       // format = PCM
    view.setUint16(22, 1, true);       // channels = mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); // byte rate (mono, 16-bit)
    view.setUint16(32, 2, true);        // block align
    view.setUint16(34, 16, true);       // bits per sample
    ascii(36, "data");
    view.setUint32(40, frames * 2, true);
    for (let i = 0; i < frames; i++) {
      const s = Math.max(-1, Math.min(1, mono[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([bytes], { type: "audio/wav" });
  } catch {
    return null;
  } finally {
    // Release the hardware context; failing to close leaks one per upload.
    ctx.close().catch(() => {});
  }
}

/**
 * Make the selected clip's audio reachable by Kie's Suno endpoint.
 * Uses the clip's local blob when available (multipart), else relays its
 * remote `originalUrl` via the JSON branch of /api/studio/upload-temp.
 *
 * Local blobs in a container Suno doesn't take (notably recorder output) are
 * transcoded to WAV first — see toMonoWav.
 */
export async function uploadClipAudio(
  item: MediaItem,
  signal?: AbortSignal,
): Promise<string> {
  const headers = await authHeader();
  const base = apiBase();

  let res: Response;
  if (item.blob) {
    const rawName = (item.name || "audio").replace(/[^a-zA-Z0-9._-]/g, "_");
    let blob = item.blob;
    let name = rawName;
    const alreadySafe = SUNO_SAFE_AUDIO.test(rawName) && SUNO_SAFE_MIME.test(blob.type || "");
    if (!alreadySafe) {
      const wav = await toMonoWav(blob);
      if (wav) {
        blob = wav;
        name = `${rawName.replace(/\.[^.]+$/, "")}.wav`;
      } else if (!name.includes(".")) {
        // Undecodable and unnamed — keep the old default rather than blocking.
        name = `${name}.mp3`;
      }
    }
    const form = new FormData();
    form.append("file", blob, name);
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
  const json = (await res.json()) as T & { charged?: number; balance?: number };

  // Tell the host page what the new balance is.
  //
  // Credits ARE deducted server-side by chargeOrRefund, but the credits chip
  // in the Studio header reads a ref the host owns — and nothing in the iframe
  // ever told it. So every AI-audio op looked free until you reloaded the page.
  // (The chat agent already mirrors its balance for the same reason; this is
  // the same fix for the inspector surface.)
  try {
    if (typeof json?.balance === "number" && window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: "voidspace:credits", balance: json.balance, charged: json.charged ?? 0 },
        "*",
      );
    }
  } catch {
    /* cross-origin parent — the toast still reports the charge */
  }
  return json as T;
}

/** Re-sing this clip in a new style. NOTE: the result uses an AI voice, not
 *  the performer's — for keeping the user's own voice use add_instrumental or
 *  the local Vocal Studio. */
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
/**
 * Split a track into stems.
 *
 * `source` is either a Suno origin ({taskId, audioId}) or a plain
 * {audioUrl} — the audioUrl branch is what makes stem-splitting work on a
 * user's own upload, which the previous taskId-only signature could not do.
 */
export function separateClipStems(
  source: { taskId: string; audioId: string } | { audioUrl: string },
  type: SeparateType = "separate_vocal",
  stemName?: string,
  signal?: AbortSignal,
) {
  return postOp<SunoSeparateResult>(
    "separate",
    { ...source, type, ...(stemName ? { stemName } : {}) },
    signal,
  );
}

/** Regenerate one time window of a track in place. */
export function replaceClipSection(
  source: { taskId: string; audioId: string } | { uploadUrl: string },
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return postOp<SunoTracksResult>("replace_section", { ...source, ...params }, signal);
}

/** Blend exactly two uploaded tracks into one. */
export function mashupClips(uploadUrls: string[], params: Record<string, unknown>, signal?: AbortSignal) {
  return postOp<SunoTracksResult>("mashup", { uploadUrls, ...params }, signal);
}

/** Generate a loopable bed / ambience (no source audio). */
export function generateSounds(params: Record<string, unknown>, signal?: AbortSignal) {
  return postOp<SunoTracksResult>("sounds", params, signal);
}

/** Transcribe a SEPARATED stem task to MIDI notes. */
export function transcribeToMidi(separationTaskId: string, audioId?: string, signal?: AbortSignal) {
  return postOp<SunoMidiResult>("midi", { taskId: separationTaskId, ...(audioId ? { audioId } : {}) }, signal);
}

/** Capture a reusable artist identity from a 10–30s window of a Suno track. */
export function createPersona(
  taskId: string,
  audioId: string,
  params: { name: string; description: string; vocalStart?: number; vocalEnd?: number; style?: string },
  signal?: AbortSignal,
) {
  return postOp<SunoPersonaResult>("persona", { taskId, audioId, ...params }, signal);
}

/** Lossless WAV of a Suno-origin track. */
export function convertClipToWav(taskId: string, audioId: string, signal?: AbortSignal) {
  return postOp<SunoWavResult>("wav", { taskId, audioId }, signal);
}

/** Word-level lyric timings for a Suno-origin track (karaoke captions). */
export function getClipTimestampedLyrics(taskId: string, audioId: string, signal?: AbortSignal) {
  return postOp<SunoLyricsResult>("timestamped_lyrics", { taskId, audioId }, signal);
}

/** Enrich a short style phrase into a fuller production brief. */
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

  // Persist the KEPT take to the user's LOCAL disk (zero Firebase) so it
  // survives a reload + Kie's ~3-day temp-URL TTL AND shows up in the
  // cross-project Library tab under "Music". This is what makes Suno results
  // findable in the assets browser the same way SFX is — previously the take
  // lived ONLY in IndexedDB (vulnerable to eviction, invisible to the
  // manifest-scanned Library). Mirrors the SFX flow in App.tsx
  // (voidspace:add-sfx-clip): importMedia already cached the blob in IndexedDB;
  // here we add the disk copy via save-render?kind=music and repoint originalUrl
  // at the durable /api/studio/local-asset URL. Best-effort + non-blocking —
  // with no outputDir / not authed the IndexedDB copy stands alone, exactly as
  // before this change (we just skip the disk layer + URL repoint).
  let durableUrl: string | undefined;
  try {
    const { saveMediaToDisk } = await import("../recording-save");
    const saved = await saveMediaToDisk(blob, safe, ext, "music");
    if (saved?.url) durableUrl = saved.url; // /api/studio/local-asset?...&kind=music
  } catch (e) {
    console.warn("[suno] disk save failed:", e);
  }

  // Stamp the friendly name, the durable originalUrl (so reloads + a buyer's
  // re-render resolve from disk after Kie expires), a Library-friendly category
  // (groups under "Music" in the Media tab), and Suno lineage (lights up the
  // downstream native ops: separate / wav / lyrics / native-extend). Direct
  // setState mirrors AIMusicSection.ensureInLibrary — the store has no generic
  // patch method and a focused write keeps this self-contained. Always runs now
  // (not gated on lineage) because originalUrl + category must be set even for
  // upload-origin results (cover / add-vocals / add-instrumental) that carry no
  // Suno taskId.
  {
    const { project } = useProjectStore.getState();
    if (project) {
      useProjectStore.setState({
        project: {
          ...project,
          mediaLibrary: {
            ...project.mediaLibrary,
            items: project.mediaLibrary.items.map((m) =>
              m.id === mediaId
                ? {
                    ...m,
                    name: safe,
                    category: "Music",
                    ...(durableUrl ? { originalUrl: durableUrl } : {}),
                    ...(lineage.sunoTaskId ? { sunoTaskId: lineage.sunoTaskId } : {}),
                    ...(lineage.sunoAudioId ? { sunoAudioId: lineage.sunoAudioId } : {}),
                  }
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
