import { useEffect, useCallback, useRef, lazy, Suspense, useState } from "react";
import { ToastContainer } from "./components/Toast";
import { ScriptViewDialog } from "./components/editor/ScriptViewDialog";
import { SearchModal } from "./components/editor/SearchModal";
import { MobileBlocker } from "./components/MobileBlocker";
import { WelcomeScreen } from "./components/welcome";
import { SharePage } from "./pages/SharePage";
import { useUIStore } from "./stores/ui-store";
import { useProjectStore } from "./stores/project-store";
import { useVoidspaceStore } from "./stores/voidspace-store";
import { useRouter } from "./hooks/use-router";
import { SOCIAL_MEDIA_PRESETS, type SocialMediaCategory } from "@openreel/core";
import { TooltipProvider } from "@openreel/ui";
import {
  waitForAuth,
  fetchSceneListContext,
  loadSceneListAsProject,
} from "./services/voidspace-loader";
import { autoSaveManager } from "./services/auto-save";
import {
  buildLegacyVoidspaceProjectId,
  buildUserScopedVoidspaceProjectId,
  buildVoidspaceProjectId,
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

function App() {
  const { activeModal, closeModal } = useUIStore();
  const { openModal: openSearchModal } = useUIStore();
  const createNewProject = useProjectStore((state) => state.createNewProject);
  const loadProject = useProjectStore((state) => state.loadProject);
  const forceSave = useProjectStore((state) => state.forceSave);
  const [voidspaceLoading, setVoidspaceLoading] = useState(() => {
    const sp = new URLSearchParams(window.location.search);
    return sp.has("sceneListId");
  });
  const [voidspaceError, setVoidspaceError] = useState<string | null>(null);

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

            if (recoveredLooksStale) {
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

                if (refreshedHasOffsets) {
                  loadProject(refreshedProject);
                  await forceSave();
                  console.log(
                    "[Voidspace] Replaced stale local cache with refreshed scene timing.",
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
            navigate("editor");
            console.log(`[Voidspace] Restored local project: ${localSave.projectName}`);
            setVoidspaceLoading(false);
            return;
          }
          console.warn("[Voidspace] Local recovery failed, falling back to Firestore import");
        }

        // No local copy — import fresh from Firestore
        console.log(`[Voidspace] Loading scene list: ${sceneListId}`);
        const project = await loadSceneListAsProject(userId, sceneListId);
        loadProject(project);
        navigate("editor");
        console.log(
          `[Voidspace] Loaded project: ${project.name} (${project.mediaLibrary.items.length} media items)`,
        );
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
