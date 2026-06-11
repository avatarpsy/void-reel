/**
 * User Music Loader — paginated fetch of user-generated music tracks
 * from `users/{uid}/music/{date}` docs whose `songs[]` array holds the
 * actual track entries (title, music_url, image_url, duration, status…).
 *
 * Date docs are ordered by document ID (YYYY-MM-DD) descending, so the
 * newest day surfaces first and we stream older days in as the user
 * scrolls.
 */

import {
  collection,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "../config/firebase-config";

export interface UserMusicTrack {
  /** Stable id: prefer song's music_id, otherwise dateDocId#index */
  id: string;
  title: string;
  artist?: string;
  imageUrl: string | null;
  musicUrl: string;
  durationMs: number;
  status?: string;
  createdAtMs?: number;
  /** Suno lineage — present on Suno-generated tracks; enables the editor's
   *  native ops (separate stems / WAV / timestamped lyrics / native extend). */
  sunoTaskId?: string;
  sunoAudioId?: string;
}

export interface UserMusicPage {
  tracks: UserMusicTrack[];
  lastDoc: QueryDocumentSnapshot | null;
  done: boolean;
}

/** Default number of date-bucket docs to fetch per page. */
export const USER_MUSIC_DATE_PAGE_SIZE = 5;

function toMs(raw: unknown): number | undefined {
  if (!raw) return undefined;
  if (typeof raw === "number") return raw;
  if (typeof raw === "object") {
    const seconds = (raw as { seconds?: number }).seconds;
    if (typeof seconds === "number") return seconds * 1000;
  }
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

function toDurationMs(raw: unknown): number {
  if (typeof raw === "number") {
    // Heuristic: values < 10000 are seconds (matches generation pipeline),
    // larger values are already milliseconds.
    return raw < 10000 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return toDurationMs(n);
  }
  return 0;
}

function parseSongs(
  dateDocId: string,
  data: Record<string, unknown> | undefined,
): UserMusicTrack[] {
  if (!data || !Array.isArray(data.songs)) return [];
  const tracks: UserMusicTrack[] = [];
  const songs = data.songs as Array<Record<string, unknown>>;
  for (let i = 0; i < songs.length; i++) {
    const s = songs[i];
    if (!s || typeof s !== "object") continue;
    const musicUrl = (s.music_url as string) || "";
    const status = (s.status as string) || undefined;
    // Skip songs that have neither a URL nor a generating status —
    // they are dead rows from cancelled jobs.
    if (!musicUrl && status !== "generating") continue;

    const imageUrl =
      (s.image_url as string) ||
      (s.cover_url as string) ||
      (s.artwork_url as string) ||
      (s.thumbnail_url as string) ||
      null;

    const musicId = (s.music_id as string) || "";
    // Suno lineage — tolerate the snake/camel variants the various writers
    // (studio finalize-song, n8n processors) might use.
    const sunoTaskId =
      (s.suno_task_id as string) || (s.sunoTaskId as string) ||
      (s.task_id as string) || (s.taskId as string) || undefined;
    const sunoAudioId =
      (s.suno_audio_id as string) || (s.sunoAudioId as string) ||
      (s.audio_id as string) || (s.audioId as string) || undefined;
    tracks.push({
      id: musicId || `${dateDocId}#${i}`,
      title: (s.title as string)?.trim() || "Untitled track",
      artist: (s.artist as string) || undefined,
      imageUrl,
      musicUrl,
      durationMs: toDurationMs(s.duration),
      status,
      createdAtMs: toMs(s.created_at),
      sunoTaskId: sunoTaskId || undefined,
      sunoAudioId: sunoAudioId || undefined,
    });
  }
  return tracks;
}

/**
 * Fetch a page of user music. `startAfterDoc` is the QueryDocumentSnapshot
 * returned from the previous call — pass `null` for the first page.
 */
export async function fetchUserMusicPage(
  userId: string,
  options: {
    pageSize?: number;
    startAfterDoc?: QueryDocumentSnapshot | null;
  } = {},
): Promise<UserMusicPage> {
  const pageSize = options.pageSize ?? USER_MUSIC_DATE_PAGE_SIZE;
  const ref = collection(db, "users", userId, "music");

  const constraints = [orderBy(documentId(), "desc"), limit(pageSize)];
  const q = options.startAfterDoc
    ? query(ref, orderBy(documentId(), "desc"), startAfter(options.startAfterDoc), limit(pageSize))
    : query(ref, ...constraints);

  const snap = await getDocs(q);

  const tracks: UserMusicTrack[] = [];
  for (const d of snap.docs) {
    tracks.push(...parseSongs(d.id, d.data() as Record<string, unknown>));
  }
  // Within a page keep newest-first by created_at when present, falling
  // back to insertion order so the date-doc ordering still drives layout.
  tracks.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));

  return {
    tracks,
    lastDoc: snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null,
    done: snap.docs.length < pageSize,
  };
}
