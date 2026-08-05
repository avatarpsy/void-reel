/**
 * Voidspace Store — User identity, avatar and social platform context.
 *
 * Populated via postMessage bridge from the host page (video-editor.vue)
 * and enriched with Firestore data when a scene list is loaded.
 */

import { create } from "zustand";
import { auth, db } from "../config/firebase-config";
import { doc, getDoc } from "firebase/firestore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SocialPlatform {
  platformId: string;
  username?: string;
  displayName?: string;
  socialImage?: string;
  status?: string;
  isConnected: boolean;
}

export interface AvatarContext {
  avatarId: string;
  avatarName: string;
  uploadPostProfile?: string;
  connectedPlatforms: SocialPlatform[];
}

export interface SceneListContext {
  sceneListId: string;
  name?: string;
  reviewId?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  avatarId?: string;
  avatarName?: string;
  caption?: string;
}

interface VoidspaceState {
  /** Firebase UID – derived from shared auth */
  userId: string | null;
  /** Active avatar */
  avatar: AvatarContext | null;
  /** Currently loaded scene list metadata */
  sceneList: SceneListContext | null;
  /** Whether platform data has been fetched at least once */
  platformsLoaded: boolean;
  /** Loading flag for platform fetch */
  loadingPlatforms: boolean;

  // Actions
  setUserId: (uid: string | null) => void;
  setAvatar: (avatar: AvatarContext | null) => void;
  setSceneList: (ctx: SceneListContext | null) => void;
  fetchConnectedPlatforms: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Well-known platforms (same order as Flutter / backend)
// ---------------------------------------------------------------------------

export const SOCIAL_PLATFORMS = [
  { id: "voidspace", name: "Voidspace", icon: "voidspace", alwaysAvailable: true },
  { id: "tiktok", name: "TikTok", icon: "tiktok" },
  { id: "instagram", name: "Instagram", icon: "instagram" },
  { id: "youtube", name: "YouTube", icon: "youtube" },
  { id: "facebook", name: "Facebook", icon: "facebook" },
  { id: "x", name: "X (Twitter)", icon: "x-twitter" },
  { id: "threads", name: "Threads", icon: "threads" },
  { id: "linkedin", name: "LinkedIn", icon: "linkedin" },
  { id: "pinterest", name: "Pinterest", icon: "pinterest" },
  { id: "reddit", name: "Reddit", icon: "reddit" },
] as const;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useVoidspaceStore = create<VoidspaceState>((set, get) => ({
  userId: null,
  avatar: null,
  sceneList: null,
  platformsLoaded: false,
  loadingPlatforms: false,

  setUserId: (uid) => set({ userId: uid }),

  setAvatar: (avatar) => set({ avatar, platformsLoaded: false }),

  setSceneList: (ctx) => set({ sceneList: ctx }),

  /**
   * A Voidspace auth token, or null when genuinely signed out.
   *
   * ── A STARTUP RACE IS NOT A SIGNED-OUT USER ────────────────────────────────
   * This read `auth.currentUser` synchronously. That property is null until the
   * SDK finishes restoring the persisted session from IndexedDB, which is
   * asynchronous and, in a freshly-mounted iframe, has almost never finished by
   * the time the editor's first request goes out.
   *
   * So the Library panel mounted, asked for a token, was told "signed out",
   * fetched `/api/studio/library` with no Authorization header, got a 401, and
   * rendered a permanent failure — for a signed-in user, on every cold load.
   * Nothing was broken; the token was asked for one tick too early. Thumbnails
   * failed the same way, since every one of them goes through here too.
   *
   * `authStateReady()` resolves once that restore has settled either way, so a
   * null return past this point means the user really is signed out. This is
   * the same lesson `apps/board/src/board/parent-auth.ts` already records for
   * the board's token bridge — the video editor never got the fix.
   */
  getIdToken: async () => {
    try {
      await auth.authStateReady();
    } catch {
      /* older SDK / unexpected failure — fall through to the live read */
    }
    const user = auth.currentUser;
    if (!user) return null;
    try {
      return await user.getIdToken();
    } catch {
      return null;
    }
  },

  /**
   * Fetch the user's automation avatar data from Firestore
   * to populate connected social platforms and upload-post profile.
   */
  fetchConnectedPlatforms: async () => {
    const { userId, avatar, sceneList, loadingPlatforms } = get();
    if (!userId || loadingPlatforms) return;

    set({ loadingPlatforms: true });

    try {
      const subDoc = await getDoc(
        doc(db, "avatar_automation_subscriptions", userId),
      );

      if (!subDoc.exists()) {
        set({ loadingPlatforms: false, platformsLoaded: true });
        return;
      }

      const data = subDoc.data();
      const automationAvatars: Array<Record<string, unknown>> =
        data?.automationAvatars ?? [];

      // Find the matching avatar or fall back to first with connected accounts
      let target: Record<string, unknown> | null = null;
      const preferredAvatarId = sceneList?.avatarId || avatar?.avatarId;

      if (preferredAvatarId) {
        target =
          automationAvatars.find(
            (a) => a.avatarId === preferredAvatarId,
          ) ?? null;
      }

      if (!target) {
        target =
          automationAvatars.find(
            (a) =>
              Array.isArray(a.socialAccountsConnected) &&
              a.socialAccountsConnected.length > 0,
          ) ?? automationAvatars[0] ?? null;
      }

      if (!target) {
        set({ loadingPlatforms: false, platformsLoaded: true });
        return;
      }

      const connectedIds: string[] = Array.isArray(
        target.socialAccountsConnected,
      )
        ? (target.socialAccountsConnected as string[])
        : [];

      const details =
        (target.socialAccountDetails as Record<string, Record<string, unknown>>) ?? {};

      const platforms: SocialPlatform[] = connectedIds.map((pid) => {
        const d = details[pid];
        return {
          platformId: pid,
          username: (d?.username as string) || undefined,
          displayName: (d?.displayName as string) || undefined,
          socialImage: (d?.image as string) || undefined,
          status: (d?.status as string) || undefined,
          isConnected: true,
        };
      });

      set({
        avatar: {
          avatarId:
            (target.avatarId as string) ||
            preferredAvatarId ||
            "",
          avatarName:
            (target.avatarName as string) ||
            sceneList?.avatarName ||
            avatar?.avatarName ||
            "Avatar",
          uploadPostProfile: (target.uploadPostProfile as string) || "",
          connectedPlatforms: platforms,
        },
        loadingPlatforms: false,
        platformsLoaded: true,
      });
    } catch (err) {
      console.error("[voidspace-store] Failed to fetch platforms:", err);
      set({ loadingPlatforms: false, platformsLoaded: true });
    }
  },
}));

// ---------------------------------------------------------------------------
// PostMessage listener — host page sends avatar/user context
// ---------------------------------------------------------------------------

function handleHostMessage(event: MessageEvent) {
  if (!event.data || typeof event.data !== "object") return;

  if (event.data.type === "voidspace:user-context") {
    const { userId, avatarId, avatarName } = event.data;
    const store = useVoidspaceStore.getState();

    if (userId) store.setUserId(userId);
    if (avatarId) {
      store.setAvatar({
        avatarId,
        avatarName: avatarName || "Avatar",
        connectedPlatforms: [],
      });
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("message", handleHostMessage);
}
