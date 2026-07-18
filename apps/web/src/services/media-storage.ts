import { StorageEngine } from "@openreel/core";
import type { MediaRecord, MediaMetadata } from "@openreel/core";

const storage = new StorageEngine();

export async function saveMediaBlob(
  projectId: string,
  mediaId: string,
  blob: Blob,
  metadata: MediaMetadata,
): Promise<void> {
  const record: MediaRecord = {
    id: mediaId,
    projectId,
    blob,
    metadata,
  };

  await storage.saveMedia(record);
}

export async function loadMediaBlob(mediaId: string): Promise<Blob | null> {
  const record = await storage.loadMedia(mediaId);
  return record?.blob || null;
}

/**
 * Load a blob but REJECT it if it belongs to a different project.
 *
 * The IndexedDB MEDIA store is keyed by mediaId GLOBALLY (keyPath "id"),
 * yet scene media ids (`media-video-{sceneDocId}-…`, `media-narration-…`)
 * REPEAT across automation projects — scene doc ids are the same 1,2,3… in
 * every project. So `loadMediaBlob(id)` returns whichever project wrote
 * that id LAST: project B's timeline would decode project A's video bytes.
 * That is the "every project shows the same Scene 1/2 video" corruption,
 * and why a PAUSED frame (drawn from this project's own originalUrl/poster)
 * looked right while PLAYBACK (the collided IndexedDB blob) was wrong.
 *
 * Each record carries the projectId it was saved under, so we can detect
 * the collision: a foreign projectId means stale, cross-project bytes —
 * return null so the caller refetches this project's OWN originalUrl.
 */
export async function loadMediaBlobForProject(
  projectId: string,
  mediaId: string,
): Promise<Blob | null> {
  const record = await storage.loadMedia(mediaId);
  if (!record?.blob) return null;
  if (record.projectId && projectId && record.projectId !== projectId) {
    console.warn(
      `[media-storage] cross-project blob collision for ${mediaId}: stored under project ${record.projectId}, current is ${projectId} — ignoring stale bytes, refetching own source`,
    );
    return null;
  }
  return record.blob;
}

export async function loadMediaRecord(
  mediaId: string,
): Promise<MediaRecord | null> {
  return storage.loadMedia(mediaId);
}

export async function loadProjectMedia(
  projectId: string,
): Promise<MediaRecord[]> {
  return storage.getMediaByProject(projectId);
}

export async function deleteMediaBlob(mediaId: string): Promise<void> {
  await storage.deleteMedia(mediaId);
}

export async function deleteProjectMedia(projectId: string): Promise<void> {
  const records = await storage.getMediaByProject(projectId);
  for (const record of records) {
    await storage.deleteMedia(record.id);
  }
}

export async function saveFileHandle(name: string, size: number, handle: FileSystemFileHandle): Promise<void> {
  await storage.saveFileHandle(name, size, handle);
}

export async function loadFileHandle(name: string, size: number): Promise<FileSystemFileHandle | null> {
  return storage.loadFileHandle(name, size);
}

export async function saveDirectoryHandle(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await storage.saveDirectoryHandle(projectId, handle);
}

export async function loadDirectoryHandle(projectId: string): Promise<{ handle: FileSystemDirectoryHandle; folderName: string } | null> {
  return storage.loadDirectoryHandle(projectId);
}

export async function getStorageStats(): Promise<{
  used: number;
  quota: number;
  mediaCount: number;
}> {
  const usage = await storage.getStorageUsage();
  return {
    used: usage.used,
    quota: usage.quota,
    mediaCount: usage.mediaItems,
  };
}
