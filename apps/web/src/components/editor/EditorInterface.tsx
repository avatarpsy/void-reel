import React, { useEffect, useState, useRef, useCallback } from "react";

import { Toolbar } from "./Toolbar";
import { AssetsPanel } from "./AssetsPanel";
import { Preview } from "./Preview";
import { InspectorPanel } from "./InspectorPanel";
import { Timeline } from "./Timeline";
import { PanelResizer } from "./PanelResizer";
import { KeyframeEditorPanel } from "./KeyframeEditorPanel";
import { AudioMixer } from "../audio-mixer";
import { KeyboardShortcutsOverlay } from "./KeyboardShortcutsOverlay";
import { PanelErrorBoundary } from "../ErrorBoundary";
import { SpotlightTour, MoGraphTour } from "./tour";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { useEngineStore } from "../../stores/engine-store";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import {
  initializePlaybackBridge,
  disposePlaybackBridge,
} from "../../bridges/playback-bridge";
import {
  initializeMediaBridge,
  disposeMediaBridge,
} from "../../bridges/media-bridge";
import {
  initializeRenderBridge,
  disposeRenderBridge,
} from "../../bridges/render-bridge";
import {
  initializeEffectsBridge,
  disposeEffectsBridge,
} from "../../bridges/effects-bridge";

/**
 * Auto-save initialization hook
 */
const useAutoSave = () => {
  const { initializeAutoSave } = useProjectStore();

  useEffect(() => {
    initializeAutoSave().catch(console.error);
  }, [initializeAutoSave]);
};

/**
 * Engine and bridge initialization hook
 * Ensures all engines and bridges are fully initialized before rendering editor
 */
const useEngineInitialization = () => {
  const { initialize, initialized, initializing, initError } = useEngineStore();
  const [bridgesReady, setBridgesReady] = useState(false);
  const [initStatus, setInitStatus] = useState("Starting...");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const initAll = async () => {
      try {
        const currentState = useEngineStore.getState();
        if (!currentState.initialized && !currentState.initializing) {
          setInitStatus("Initializing video engine...");
          await initialize();
        } else if (currentState.initializing) {
          await new Promise<void>((resolve) => {
            const unsubscribe = useEngineStore.subscribe((state) => {
              if (state.initialized || state.initError) {
                unsubscribe();
                resolve();
              }
            });
          });
        }

        if (!isMounted) return;

        const engineState = useEngineStore.getState();
        if (!engineState.initialized) {
          throw new Error(
            engineState.initError || "Engine initialization failed",
          );
        }

        setInitStatus("Initializing media bridge...");
        await initializeMediaBridge();
        if (!isMounted) return;

        setInitStatus("Initializing playback bridge...");
        await initializePlaybackBridge();
        if (!isMounted) return;

        setInitStatus("Initializing render bridge...");
        await initializeRenderBridge();
        if (!isMounted) return;

        setInitStatus("Initializing effects bridge...");
        const projectState = useProjectStore.getState();
        const { width, height } = projectState.project.settings;
        try {
          await initializeEffectsBridge(width, height);
        } catch (effectsError) {
          console.error(
            "[EditorInterface] EffectsBridge initialization failed:",
            effectsError,
          );
        }
        if (!isMounted) return;

        setBridgesReady(true);
      } catch (error) {
        console.error("Failed to initialize engines/bridges:", error);
        if (isMounted) {
          setLocalError(
            error instanceof Error ? error.message : "Unknown error",
          );
          setInitStatus(
            `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
        }
      }
    };

    initAll();

    return () => {
      isMounted = false;
      disposePlaybackBridge();
      disposeMediaBridge();
      disposeRenderBridge();
      disposeEffectsBridge();
    };
  }, [initialize, initialized, initializing]);

  return {
    initialized: initialized && bridgesReady,
    initializing: initializing || (!bridgesReady && initialized),
    initError: initError || localError,
    initStatus,
  };
};

/**
 * Main Editor Interface Component
 */
/**
 * Space the timeline may never take, in px.
 *
 * The timeline can climb until only the player's CONTROL ROW is left above it —
 * never past it. That row carries the transport, so letting the drag swallow it
 * took play/pause and the clock off screen, which is why the transport used to
 * live on the timeline toolbar instead of with the picture it drives.
 *
 * Spelled out rather than written as one number because each part is a real
 * measurement that can drift: an unaccounted 1px border here is a visible
 * overlap between the control row and the timeline.
 */
const TOP_TOOLBAR_H = 64;   // h-16
const GRIP_H = 8;           // h-2 resize grip
const PLAYER_CONTROLS_H = 49; // h-12 row + its 1px top border
const MIN_CHROME_ABOVE_TIMELINE = TOP_TOOLBAR_H + GRIP_H + PLAYER_CONTROLS_H;

export const EditorInterface: React.FC = () => {
  const { initialized, initializing, initError, initStatus } =
    useEngineInitialization();

  const { showShortcutsOverlay, setShowShortcutsOverlay } =
    useKeyboardShortcuts();
  useAutoSave();

  const {
    keyframeEditorOpen,
    setKeyframeEditorOpen,
    getSelectedClipIds,
    panels,
    setPanelVisible,
    previewCollapsed,
    centerView,
  } = useUIStore();
  // The center workspace column shows EITHER the video preview or the audio
  // mixer, chosen by `centerView` (toolbar button swaps it; music projects
  // default to "mixer", video to "preview"). When the mixer is shown the
  // Preview component stays MOUNTED but hidden so its playback/audio engine
  // keeps driving the timeline — see the workspace row below.
  const showMixerCenter = centerView === "mixer";
  const { project, updateClipKeyframes } = useProjectStore();
  const tracks = project.timeline.tracks;

  const [selectedKeyframeIds, setSelectedKeyframeIds] = React.useState<string[]>([]);
  const [copiedKeyframes, setCopiedKeyframes] = React.useState<import("@openreel/core").Keyframe[]>([]);

  const selectedClip = React.useMemo(() => {
    const selectedIds = getSelectedClipIds();
    if (selectedIds.length === 0) return null;
    const clipId = selectedIds[0];
    for (const track of tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return clip;
    }
    return null;
  }, [getSelectedClipIds, tracks]);

  const handleUpdateKeyframe = React.useCallback(
    (keyframeId: string, updates: Partial<import("@openreel/core").Keyframe>) => {
      if (!selectedClip?.keyframes) return;
      const keyframes = selectedClip.keyframes.map((kf) =>
        kf.id === keyframeId ? { ...kf, ...updates } : kf
      );
      updateClipKeyframes(selectedClip.id, keyframes);
    },
    [selectedClip, updateClipKeyframes]
  );

  const handleDeleteKeyframe = React.useCallback(
    (keyframeId: string) => {
      if (!selectedClip?.keyframes) return;
      const keyframes = selectedClip.keyframes.filter((kf) => kf.id !== keyframeId);
      updateClipKeyframes(selectedClip.id, keyframes);
      setSelectedKeyframeIds((prev) => prev.filter((id) => id !== keyframeId));
    },
    [selectedClip, updateClipKeyframes]
  );

  const handleCopyKeyframes = React.useCallback(
    (keyframeIds: string[]) => {
      if (!selectedClip?.keyframes) return;
      const toCopy = selectedClip.keyframes.filter((kf) => keyframeIds.includes(kf.id));
      setCopiedKeyframes(toCopy);
    },
    [selectedClip]
  );

  const handlePasteKeyframes = React.useCallback(
    (clipId: string, time: number) => {
      const targetClip = tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
      if (!targetClip) return;
      const newKeyframes = copiedKeyframes.map((kf) => ({
        ...kf,
        id: `kf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        time: kf.time + time,
      }));
      updateClipKeyframes(clipId, [...(targetClip.keyframes || []), ...newKeyframes]);
    },
    [copiedKeyframes, tracks, updateClipKeyframes]
  );

  const handleSelectKeyframe = React.useCallback(
    (keyframeId: string, addToSelection: boolean) => {
      if (addToSelection) {
        setSelectedKeyframeIds((prev) =>
          prev.includes(keyframeId)
            ? prev.filter((id) => id !== keyframeId)
            : [...prev, keyframeId]
        );
      } else {
        setSelectedKeyframeIds([keyframeId]);
      }
    },
    []
  );

  const [timelineHeight, setTimelineHeight] = useState(320);
  const isDraggingRef = useRef(false);

  // "Minimize video" grows the timeline so the preview row shrinks to a
  // strip (the preview stays mounted — only its box shrinks). One
  // consistent resize model: the grip always adjusts this height.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Minimize takes the video area to nothing but stops at the same floor the
    // drag does, so the control row (and the transport on it) survives either
    // route. Two ways to resize must not disagree about what "minimum" means.
    setTimelineHeight(
      previewCollapsed
        ? Math.max(320, window.innerHeight - MIN_CHROME_ABOVE_TIMELINE)
        : 320,
    );
  }, [previewCollapsed]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;

      const newHeight = window.innerHeight - e.clientY;
      const maxHeight = window.innerHeight - MIN_CHROME_ABOVE_TIMELINE;
      setTimelineHeight(Math.max(200, Math.min(newHeight, maxHeight)));
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  if (initializing || !initialized) {
    return (
      <div className="w-full h-full bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-text-secondary text-sm">Initializing editor...</p>
          <p className="text-text-muted text-xs mt-2">{initStatus}</p>
          {initError && (
            <p className="text-red-500 text-xs mt-2">{initError}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-hidden font-sans select-none relative z-20 text-xs text-text-secondary">
      {/* Main App Toolbar */}
      <Toolbar />

      {/* Workspace Area — always flexes to fill whatever the timeline
          leaves. Minimizing the video grows the timeline (below), which
          shrinks this row to a strip. Preview stays mounted (its
          playback/audio engine lives in it). */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        <PanelErrorBoundary name="Assets Panel">
          <AssetsPanel />
        </PanelErrorBoundary>

        {/* Drag handle: resize the Assets panel */}
        <PanelResizer panelId="mediaLibrary" side="right" />

        {showMixerCenter ? (
          <>
            {/* Preview stays MOUNTED but display:none — its rAF render
                loop + audio scheduler drive timeline playback even with
                no visible video surface. Unmounting it would kill
                playback. Only the box is replaced by the mixer. */}
            <div className="hidden" aria-hidden="true">
              <PanelErrorBoundary name="Preview">
                <Preview />
              </PanelErrorBoundary>
            </div>
            <PanelErrorBoundary name="Audio Mixer">
              <AudioMixer variant="center" visible />
            </PanelErrorBoundary>
          </>
        ) : (
          <PanelErrorBoundary name="Preview">
            <Preview />
          </PanelErrorBoundary>
        )}

        {/* Drag handle: resize the Inspector panel */}
        <PanelResizer panelId="inspector" side="left" />

        <PanelErrorBoundary name="Inspector">
          <InspectorPanel />
        </PanelErrorBoundary>

        {keyframeEditorOpen && (
          <PanelErrorBoundary name="Keyframe Editor">
            <KeyframeEditorPanel
              clip={selectedClip}
              onClose={() => setKeyframeEditorOpen(false)}
              onUpdateKeyframe={handleUpdateKeyframe}
              onDeleteKeyframe={handleDeleteKeyframe}
              onCopyKeyframes={handleCopyKeyframes}
              onPasteKeyframes={handlePasteKeyframes}
              selectedKeyframeIds={selectedKeyframeIds}
              onSelectKeyframe={handleSelectKeyframe}
              copiedKeyframes={copiedKeyframes}
            />
          </PanelErrorBoundary>
        )}
      </div>

      {/* Premium resize grip — always docked on the timeline's top edge
          with a centered grip pill + a tall invisible hit-band so it's
          always easy to grab (the old 1px hairline got lost behind the
          mixer / was hidden when the preview was minimized). */}
      <div
        className="group relative h-2 shrink-0 bg-background-secondary border-t border-border hover:bg-primary/10 cursor-row-resize transition-colors z-30 flex items-center justify-center"
        onMouseDown={handleMouseDown}
        title="Drag to resize the timeline"
      >
        <div className="absolute inset-x-0 -top-1.5 -bottom-1.5" />
        <div className="h-1 w-10 rounded-full bg-border group-hover:bg-primary/60 transition-colors pointer-events-none" />
      </div>

      {/* Audio Mixer dock — only when the mixer is NOT already shown in the
          center column (otherwise it would be a duplicate). */}
      {!showMixerCenter && panels.audioMixer?.visible && (
        <PanelErrorBoundary name="Audio Mixer">
          <AudioMixer
            visible
            onClose={() => setPanelVisible("audioMixer", false)}
          />
        </PanelErrorBoundary>
      )}

      {/* BOTTOM PANEL: Timeline — fixed, user-resizable height. The
          workspace row above always flexes to fill the remainder, so
          minimizing the video just grows this height (one resize model). */}
      <div
        style={{ height: timelineHeight }}
        className="shrink-0 flex flex-col min-h-0"
      >
        <PanelErrorBoundary name="Timeline">
          <Timeline />
        </PanelErrorBoundary>
      </div>

      <KeyboardShortcutsOverlay
        isOpen={showShortcutsOverlay}
        onClose={() => setShowShortcutsOverlay(false)}
      />

      <SpotlightTour />
      <MoGraphTour />
    </div>
  );
};

export default EditorInterface;
