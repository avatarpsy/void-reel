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

        // No local copy — import fresh from Firestore AND subscribe to
        // live updates. Studio chat upserts assets one-by-one as the
        // user approves each step (frame → voiceover → clip → render);
        // without the subscription the editor only saw the snapshot at
        // mount time, so the timeline never refreshed and users had to
        // reload to see the next clip land. The subscription
        // coalesces bursts and re-runs `loadSceneListAsProject` on
        // every Firestore write so tracks fill in real time.
        console.log(`[Voidspace] Loading scene list: ${sceneListId} (live)`);
        let firstLoad = true;
        const unsubscribe = subscribeSceneListAsProject(
          userId,
          sceneListId,
          (project) => {
            if (firstLoad) {
              firstLoad = false;
              loadProject(project);
              navigate("editor");
              console.log(
                `[Voidspace] Loaded project: ${project.name} (${project.mediaLibrary.items.length} media items)`,
              );
              return;
            }
            // Subsequent live update — merge fresh media + timeline
            // into the running project so the editor canvas / tracks
            // update without losing the user's in-progress edits
            // (selection, playhead, etc.).
            const current = useProjectStore.getState().project;
            useProjectStore.setState({
              project: {
                ...current,
                name: project.name,
                settings: project.settings,
                mediaLibrary: project.mediaLibrary,
                timeline: project.timeline,
                modifiedAt: project.modifiedAt,
              },
            });
            console.log(
              `[Voidspace] Live update: ${project.mediaLibrary.items.length} media items`,
            );
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
            reply({
              type: "voidspace:state",
              requestId: msg.requestId,
              state: {
                id: proj.id,
                name: proj.name,
                settings: proj.settings,
                duration: proj.timeline?.duration ?? 0,
                tracks: (proj.timeline?.tracks ?? []).map((tr) => ({
                  id: tr.id, name: tr.name, kind: tr.id?.includes("music") ? "music" : tr.id?.includes("narration") ? "narration" : "video",
                  clips: (tr.clips ?? []).map((c: any) => ({
                    id: c.id, mediaId: c.mediaId, startTime: c.startTime, duration: c.duration,
                    inPoint: c.inPoint, outPoint: c.outPoint,
                  })),
                })),
                mediaCount: proj.mediaLibrary?.items?.length ?? 0,
              },
            });
            break;
          }
          case "voidspace:reload": {
            const sp = new URLSearchParams(window.location.search);
            const sceneListId = sp.get("sceneListId");
            const userId = useProjectStore.getState().project?.id?.match(/users?_(.*?)_/)?.[1] || null;
            if (sceneListId && userId) {
              try {
                const fresh = await loadSceneListAsProject(userId, sceneListId);
                loadProject(fresh);
                reply({ type: "voidspace:ack", requestId: msg.requestId, op: "reload" });
              } catch (err) {
                reply({ type: "voidspace:error", requestId: msg.requestId, error: String((err as any)?.message ?? err) });
              }
            } else {
              reply({ type: "voidspace:error", requestId: msg.requestId, error: "no sceneListId in URL" });
            }
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
