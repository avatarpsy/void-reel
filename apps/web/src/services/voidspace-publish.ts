/**
 * Voidspace Publish Service — Handles video upload, social draft creation,
 * and scheduling for the Studio publish flow.
 *
 * All calls route through same-origin Nuxt server proxy endpoints
 * (/api/studio/*) which forward to the App Server with auth.
 * When running in dev mode (localhost:5173), falls back to direct calls.
 */

import { auth } from "../config/firebase-config";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "../config/firebase-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getAuthHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");
  const token = await user.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Resolve the base URL for API calls.
 * - If embedded in the Voidspace website (same origin): use relative /api/studio/*
 * - If standalone dev mode: call app server directly via the website proxy
 */
function getApiBase(): string {
  // In production the Studio is served under /studio/ on the same origin
  // as the Nuxt site, so relative URLs resolve correctly.
  // In dev mode we need to call back to the website dev server.
  if (typeof window !== "undefined") {
    // If we're inside an iframe, use parent origin for API calls
    try {
      if (window.parent && window.parent !== window) {
        return window.parent.location.origin;
      }
    } catch {
      // Cross-origin — fall through to current origin
    }
  }
  return "";
}

async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const base = getApiBase();
  const headers = await getAuthHeaders();
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`API error ${res.status}: ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublishResult {
  success: boolean;
  draftId?: string;
  status?: string;
  message?: string;
  error?: string;
}

export interface ScheduleSlot {
  publishAtUtc: string;
  day: string;
  reason: string;
}

export interface OptimalTimesResult {
  recommended_slots: ScheduleSlot[];
}

export interface UploadMediaResult {
  videoUrl: string;
  thumbnailUrl?: string;
}

export interface VoidspaceNativePublishResult {
  success: boolean;
  loopId?: string;
  feedPostId?: string;
}

// ---------------------------------------------------------------------------
// Upload rendered video to Firebase Storage (temp path)
// ---------------------------------------------------------------------------

export async function uploadRenderedVideo(
  userId: string,
  blob: Blob,
  filename: string,
): Promise<UploadMediaResult> {
  const ts = Date.now();
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `users/${userId}/studio-exports/${ts}_${safeFilename}`;
  const fileRef = storageRef(storage, path);

  await uploadBytes(fileRef, blob, {
    contentType: blob.type || "video/mp4",
    customMetadata: {
      source: "studio-publish",
      uploadedAt: new Date().toISOString(),
    },
  });

  const videoUrl = await getDownloadURL(fileRef);
  return { videoUrl };
}

// ---------------------------------------------------------------------------
// Create social post draft (same as Flutter → /social-post-draft/store)
// ---------------------------------------------------------------------------

export async function createSocialDraft(params: {
  userId: string;
  draftId: string;
  avatarId: string;
  avatarName: string;
  platforms: string[];
  videoUrl: string;
  thumbnailUrl?: string;
  caption: string;
  uploadPostProfile: string;
  scheduledTime?: string; // ISO-8601 UTC or null for immediate
}): Promise<PublishResult> {
  return apiFetch<PublishResult>(
    "/api/studio/social-draft",
    {
      method: "POST",
      body: JSON.stringify({
        user_id: params.userId,
        draft_id: params.draftId,
        avatar_id: params.avatarId,
        avatar_name: params.avatarName,
        platforms: params.platforms,
        content_type: "video",
        content: params.caption,
        description: params.caption,
        video_url: params.videoUrl,
        image_url: params.thumbnailUrl || "",
        upload_post_profile: params.uploadPostProfile,
        scheduled_time: params.scheduledTime || null,
        status: "pending_approval",
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// Approve & publish a draft (same as Flutter → /reviews/action)
// ---------------------------------------------------------------------------

export async function publishDraft(params: {
  userId: string;
  draftId: string;
  platforms: string[];
  caption: string;
  decision?: "approve" | "schedule";
}): Promise<PublishResult> {
  return apiFetch<PublishResult>(
    "/api/studio/publish",
    {
      method: "POST",
      body: JSON.stringify({
        user_id: params.userId,
        draft_id: params.draftId,
        decision: params.decision || "approve",
        selected_platforms: params.platforms,
        description: params.caption,
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// Publish directly to Voidspace (Flutter-equivalent native path)
// ---------------------------------------------------------------------------

export async function publishToVoidspaceNative(params: {
  userId: string;
  avatarId: string;
  avatarName: string;
  caption: string;
  videoUrl: string;
  thumbnailUrl?: string;
}): Promise<VoidspaceNativePublishResult> {
  const title = (params.caption || "Voidspace Video").trim().slice(0, 120) || "Voidspace Video";

  const loopResult = await apiFetch<{ success?: boolean; loop_id?: string }>(
    "/api/studio/voidspace-loop",
    {
      method: "POST",
      body: JSON.stringify({
        user_id: params.userId,
        avatar_id: params.avatarId,
        avatar_name: params.avatarName,
        video_url: params.videoUrl,
        thumbnail_url: params.thumbnailUrl || "",
        title,
        description: params.caption,
        scene_text: params.caption,
      }),
    },
  );

  if (!loopResult?.success || !loopResult.loop_id) {
    throw new Error("Voidspace loop publish failed");
  }

  const mediaItems: Array<Record<string, unknown>> = [
    {
      type: "video",
      url: params.videoUrl,
      thumbnailUrl: params.thumbnailUrl || "",
    },
  ];

  if (params.thumbnailUrl) {
    mediaItems.push({
      type: "image",
      url: params.thumbnailUrl,
      thumbnailUrl: params.thumbnailUrl,
    });
  }

  const feedResult = await apiFetch<{ success?: boolean; postId?: string; existingPostId?: string }>(
    "/api/studio/voidspace-feed",
    {
      method: "POST",
      body: JSON.stringify({
        userId: params.userId,
        avatarId: params.avatarId,
        avatarName: params.avatarName,
        contentType: "loop",
        content: params.caption,
        mediaItems,
        hashtags: [],
        mood: "",
        source: "studio",
        status: "published",
        sourceType: "loop",
        sourceCollection: "loops",
        sourceId: loopResult.loop_id,
      }),
    },
  );

  return {
    success: true,
    loopId: loopResult.loop_id,
    feedPostId: feedResult.postId || feedResult.existingPostId,
  };
}

// ---------------------------------------------------------------------------
// Schedule a draft
// ---------------------------------------------------------------------------

export async function scheduleDraft(params: {
  userId: string;
  draftId: string;
  publishAtUtc: string; // ISO-8601
}): Promise<PublishResult> {
  return apiFetch<PublishResult>(
    "/api/studio/schedule",
    {
      method: "POST",
      body: JSON.stringify({
        user_id: params.userId,
        draft_id: params.draftId,
        new_publish_at_utc: params.publishAtUtc,
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// Get optimal posting times
// ---------------------------------------------------------------------------

export async function getOptimalTimes(params: {
  userId: string;
  platforms: string[];
  avatarId?: string;
  count?: number;
}): Promise<OptimalTimesResult> {
  const qs = new URLSearchParams({
    user_id: params.userId,
    platforms: params.platforms.join(","),
    count: String(params.count ?? 5),
    ...(params.avatarId ? { avatar_id: params.avatarId } : {}),
  });
  const raw = await apiFetch<{ recommended_slots?: Array<Record<string, unknown>> }>(
    `/api/studio/optimal-times?${qs.toString()}`,
  );

  const normalized: ScheduleSlot[] = (raw.recommended_slots ?? [])
    .map((slot) => {
      const publishAtUtc =
        (slot.publish_at_utc as string | undefined) ||
        (slot.publishAtUtc as string | undefined) ||
        "";
      return {
        publishAtUtc,
        day: String(slot.day ?? ""),
        reason: String(slot.reason ?? ""),
      };
    })
    .filter((slot) => slot.publishAtUtc.length > 0);

  return { recommended_slots: normalized };
}

// ---------------------------------------------------------------------------
// Check draft status
// ---------------------------------------------------------------------------

export async function checkDraftStatus(params: {
  userId: string;
  draftId: string;
}): Promise<{
  success: boolean;
  status: string;
  posted_platforms?: string[];
  error?: string;
}> {
  const qs = new URLSearchParams({
    user_id: params.userId,
    draft_id: params.draftId,
  });
  return apiFetch(`/api/studio/draft-status?${qs.toString()}`);
}
