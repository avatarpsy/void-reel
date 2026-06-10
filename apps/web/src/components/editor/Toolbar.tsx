import React, { useCallback, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Command,
  ChevronDown,
  FileVideo,
  Film,
  Music,
  Loader2,
  X,
  Check,
  FileCode,
  Settings,
  Zap,
  Circle,
  History,
  HelpCircle,
  Diamond,
  Sparkles,
  Play,
  Send,
  Download,
  Save,
  Minimize2,
  Maximize2,
  SlidersHorizontal,
  MonitorPlay,
} from "lucide-react";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { autoSaveManager } from "../../services/auto-save";
import { saveRecordingToDisk, saveMediaToDisk } from "../../services/recording-save";
import {
  getExportEngine,
  getDeviceProfile,
  estimateExportTime,
  type VideoExportSettings,
  type AudioExportSettings,
  type ExportResult,
  type DeviceProfile,
  type TimeEstimate,
} from "@openreel/core";
import { ExportDialog } from "./ExportDialog";
import { PublishDialog } from "./PublishDialog";
import { ScreenRecorder } from "./ScreenRecorder";
import { HistoryPanel } from "./inspector/HistoryPanel";
import { SettingsDialog } from "./settings/SettingsDialog";
import { toast } from "../../stores/notification-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useAnalytics, AnalyticsEvents } from "../../hooks/useAnalytics";
import { startTour, ONBOARDING_KEY, startMoGraphTour, MOGRAPH_TOUR_KEY } from "./tour";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@openreel/ui";

type ExportType =
  | "mp4"
  | "prores"
  | "gif"
  | "wav"
  | "4k-master"
  | "4k-prores"
  | "4k"
  | "1080p-high"
  | "4k-60-master"
  | "1080p-60"
  | "project";

interface ExportState {
  isExporting: boolean;
  progress: number;
  phase: string;
  error: string | null;
  complete: boolean;
}

// BUILD MARKER — log on module load so we can confirm which build is running
console.log("[BUILD] Toolbar.tsx v2-savedebug — Save with ack flow");

export const Toolbar: React.FC = () => {
  const { project } = useProjectStore();
  const {
    setExportState: setGlobalExportState,
    keyframeEditorOpen,
    toggleKeyframeEditor,
    panels,
    togglePanel,
    previewCollapsed,
    togglePreviewCollapsed,
    centerView,
    toggleCenterView,
  } = useUIStore();
  // The center column shows either the video player or the audio mixer.
  // When the mixer occupies the center there is no video surface to
  // minimise and the dock-mixer toggle would be redundant, so those two
  // controls are hidden then. The swap button itself is always shown.
  const showMixerCenter = centerView === "mixer";
  // Theme is driven by the parent website (studio-ai page sets
  // ?theme= and posts voidspace:theme messages). Keeping
  // useThemeStore unused here so the toolbar doesn't fight the
  // parent's choice.
  const { openSettings } = useSettingsStore();
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [isRecorderOpen, setIsRecorderOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [publishBlob, setPublishBlob] = useState<Blob | null>(null);
  const [publishFilename, setPublishFilename] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  const { importMedia } = useProjectStore();
  const { track } = useAnalytics();

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    console.log("[save] click → forceSave");
    try {
      // Trigger an immediate native save. autoSaveManager writes the
      // full Project to IndexedDB, then the remote-sync hook (set up
      // in App.tsx for Voidspace mode) postMessages the same blob to
      // the parent for Firestore persistence. No more per-track
      // stripping — captions, animations, transforms, all round-trip.
      const proj = useProjectStore.getState().project;
      await autoSaveManager.forceSave(proj);
      console.log("[save] forceSave done");
      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 1200);
    } catch (err) {
      console.error("[save] failed", err);
    } finally {
      setIsSaving(false);
    }
  }, [isSaving]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  const handleStartTour = useCallback(() => {
    localStorage.removeItem(ONBOARDING_KEY);
    startTour();
  }, []);

  const handleStartMoGraphTour = useCallback(() => {
    localStorage.removeItem(MOGRAPH_TOUR_KEY);
    startMoGraphTour();
  }, []);

  // hasSelectedClip used to drive the search palette's "Search effects
  // for selected clip…" hint state. The palette is hidden in the
  // studio shell, so the flag is no longer read.
  const [exportState, setExportState] = useState<ExportState>({
    isExporting: false,
    progress: 0,
    phase: "",
    error: null,
    complete: false,
  });
  const [deviceProfile, setDeviceProfile] = useState<DeviceProfile | null>(null);
  const [exportEstimates, setExportEstimates] = useState<Map<string, TimeEstimate>>(new Map());

  useEffect(() => {
    setGlobalExportState({
      isExporting: exportState.isExporting,
      progress: exportState.progress,
      phase: exportState.phase,
    });
  }, [exportState.isExporting, exportState.progress, exportState.phase, setGlobalExportState]);

  useEffect(() => {
    if (isExportOpen && !deviceProfile) {
      getDeviceProfile().then(setDeviceProfile);
    }
  }, [isExportOpen, deviceProfile]);

  useEffect(() => {
    if (!deviceProfile || !project.timeline?.duration) {
      return;
    }

    const duration = project.timeline.duration;
    const estimates = new Map<string, TimeEstimate>();

    const configs: Array<{ key: string; width: number; height: number; frameRate: number; codec: "h264" | "h265" | "vp9" | "av1" }> = [
      { key: "mp4", width: project.settings.width, height: project.settings.height, frameRate: 30, codec: "h264" },
      { key: "4k", width: 3840, height: 2160, frameRate: 30, codec: "h264" },
      { key: "4k-60-master", width: 3840, height: 2160, frameRate: 60, codec: "h264" },
      { key: "4k-master", width: 3840, height: 2160, frameRate: 30, codec: "h264" },
      { key: "1080p-high", width: 1920, height: 1080, frameRate: 30, codec: "h264" },
      { key: "1080p-60", width: 1920, height: 1080, frameRate: 60, codec: "h264" },
      { key: "prores", width: project.settings.width, height: project.settings.height, frameRate: 30, codec: "h264" },
    ];

    for (const config of configs) {
      const estimate = estimateExportTime(deviceProfile, {
        width: config.width,
        height: config.height,
        frameRate: config.frameRate,
        duration,
        codec: config.codec,
      });
      estimates.set(config.key, estimate);
    }

    setExportEstimates(estimates);
  }, [deviceProfile, project.timeline?.duration, project.settings.width, project.settings.height]);

  // Search palette removed from the toolbar; the chat sidebar is the
  // canonical search/ask surface in the studio shell. Keeping the
  // unused handler would trip TS6133 in strict noUnused checks.

  const runExport = useCallback(
    async (videoSettings: Partial<VideoExportSettings>, _ext: string, writableStream: FileSystemWritableFileStream) => {
      const engine = getExportEngine();
      await engine.initialize();

      // Preflight: rehydrate any media items whose blob never finished
      // loading (or got dropped). Without this, the audio engine logs
      // "No blob available for media item …" and renders silence — the
      // video plays back muted and the chat result card shows 0:00.
      try {
        const { fetchMediaBlob } = await import("../../services/voidspace-loader");
        const missing = (project.mediaLibrary?.items ?? []).filter(
          (m: any) => !m.blob && (m.originalUrl || (m as any).url),
        );
        if (missing.length > 0) {
          setExportState((prev) => ({
            ...prev,
            phase: `Loading ${missing.length} media file${missing.length === 1 ? "" : "s"}...`,
          }));
          await Promise.all(missing.map(async (m: any) => {
            const blob = await fetchMediaBlob(m.originalUrl || (m as any).url);
            if (blob) m.blob = blob;
          }));
        }
      } catch (e) {
        console.warn("[runExport] blob preflight failed:", e);
      }

      const generator = engine.exportVideo(project, videoSettings, writableStream);
      let finalResult: ExportResult | undefined;

      while (true) {
        const { value, done } = await generator.next();
        if (done) {
          finalResult = value;
          break;
        }
        setExportState((prev) => ({
          ...prev,
          progress: value.progress * 100,
          phase: value.phase === "complete" ? "Complete!" : `${value.phase}...`,
        }));
      }

      if (finalResult?.success) {
        setExportState((prev) => ({ ...prev, complete: true, phase: "Saved!" }));
        track(AnalyticsEvents.PROJECT_EXPORTED, {
          format: videoSettings.format ?? "mp4",
          codec: videoSettings.codec ?? "h264",
          width: videoSettings.width ?? project.settings.width,
          height: videoSettings.height ?? project.settings.height,
          frameRate: videoSettings.frameRate ?? project.settings.frameRate,
          duration: project.timeline?.duration ?? 0,
        });
      } else {
        throw new Error(finalResult?.error?.message || "Export failed");
      }
    },
    [project, track],
  );

  const showSavePicker = useCallback(async (filename: string, ext: string): Promise<FileSystemWritableFileStream> => {
    const mimeMap: Record<string, string> = {
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      wav: "audio/wav",
    };
    const mime = mimeMap[ext] || "application/octet-stream";

    // Standalone editor (opened directly at /studio/, no chat parent):
    // use the browser's native "Save As" dialog — original openreel
    // behavior. Lets the user pick the destination per-export.
    const isEmbedded =
      typeof window !== "undefined" &&
      (window.self !== window.top ||
        new URLSearchParams(window.location.search).get("embed") === "1");

    if (!isEmbedded && "showSaveFilePicker" in window) {
      const handle = await (window as unknown as {
        showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: "Media file",
          accept: { [mime]: [`.${ext}`] },
        }],
      });
      return handle.createWritable();
    }

    // Embedded in the Voidspace chat, OR browser without File System
    // Access API: collect bytes in memory and let `triggerDownload`
    // decide where they go (parent postMessage when embedded, browser
    // download otherwise). The "same output folder for everything"
    // contract lives in the chat — the editor can't know outputDir on
    // its own (cross-frame setting), so it hands the blob to the
    // parent which already has the path + Firebase auth.

    let buffer = new Uint8Array(16 * 1024 * 1024);
    let length = 0;
    let cursor = 0;

    const grow = (needed: number) => {
      if (needed <= buffer.length) return;
      let newSize = buffer.length;
      while (newSize < needed) newSize *= 2;
      const next = new Uint8Array(newSize);
      next.set(buffer.subarray(0, length));
      buffer = next;
    };

    const triggerDownload = () => {
      const blob = new Blob([buffer.slice(0, length)], { type: mime });
      const url = URL.createObjectURL(blob);

      // Embedded in chat → hand the blob to the parent, which persists
      // it to the user's configured outputDir via save-render. Same
      // folder as narrations / videos / frames (which the chat mirrors
      // via mirror-asset). The parent revokes the URL after upload.
      if (isEmbedded && window.parent) {
        window.parent.postMessage({
          type: "voidspace:editor-render-saved",
          blobUrl: url,
          filename,
          mimeType: mime,
          bytes: length,
        }, "*");
        return;
      }

      // Standalone fallback (Firefox, Safari, or any browser without
      // File System Access API): plain download anchor.
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    const writeBytes = (bytes: Uint8Array, position: number) => {
      const end = position + bytes.byteLength;
      grow(end);
      buffer.set(bytes, position);
      if (end > length) length = end;
      cursor = end;
    };

    return {
      seek(position: number) {
        cursor = position;
        return Promise.resolve();
      },
      write(data: unknown) {
        if (data instanceof ArrayBuffer) {
          writeBytes(new Uint8Array(data), cursor);
        } else if (ArrayBuffer.isView(data)) {
          writeBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), cursor);
        }
        return Promise.resolve();
      },
      close() {
        triggerDownload();
        return Promise.resolve();
      },
      abort() {
        return Promise.resolve();
      },
      truncate() {
        return Promise.resolve();
      },
    } as unknown as FileSystemWritableFileStream;
  }, []);

  const createMirroredWritable = useCallback(
    (
      target: FileSystemWritableFileStream,
      mimeType: string,
      onBlobReady: (blob: Blob) => void,
    ): FileSystemWritableFileStream => {
      let mirrorBuffer = new Uint8Array(16 * 1024 * 1024);
      let mirrorLength = 0;
      let cursor = 0;

      const ensureCapacity = (needed: number) => {
        if (needed <= mirrorBuffer.length) return;
        let nextSize = mirrorBuffer.length;
        while (nextSize < needed) {
          nextSize *= 2;
        }
        const next = new Uint8Array(nextSize);
        next.set(mirrorBuffer.subarray(0, mirrorLength));
        mirrorBuffer = next;
      };

      const writeMirrorBytes = (bytes: Uint8Array, position: number) => {
        const end = position + bytes.byteLength;
        ensureCapacity(end);
        mirrorBuffer.set(bytes, position);
        if (end > mirrorLength) {
          mirrorLength = end;
        }
      };

      const toBytes = (data: unknown): Uint8Array | null => {
        if (data instanceof ArrayBuffer) {
          return new Uint8Array(data);
        }
        if (ArrayBuffer.isView(data)) {
          return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }
        return null;
      };

      return {
        seek(position: number) {
          cursor = position;
          return target.seek(position);
        },
        write(data: unknown) {
          const bytes = toBytes(data);
          if (bytes) {
            writeMirrorBytes(bytes, cursor);
            cursor += bytes.byteLength;
          }
          return target.write(data as never);
        },
        close() {
          const blob = new Blob([mirrorBuffer.slice(0, mirrorLength)], { type: mimeType });
          onBlobReady(blob);
          return target.close();
        },
        abort() {
          return target.abort();
        },
        truncate(size: number) {
          return target.truncate(size);
        },
      } as FileSystemWritableFileStream;
    },
    [],
  );

  const createMemoryWritable = useCallback(
    (
      mimeType: string,
      onBlobReady: (blob: Blob) => void,
    ): FileSystemWritableFileStream => {
      let buffer = new Uint8Array(16 * 1024 * 1024);
      let length = 0;
      let cursor = 0;

      const ensureCapacity = (needed: number) => {
        if (needed <= buffer.length) return;
        let nextSize = buffer.length;
        while (nextSize < needed) {
          nextSize *= 2;
        }
        const next = new Uint8Array(nextSize);
        next.set(buffer.subarray(0, length));
        buffer = next;
      };

      const writeBytes = (bytes: Uint8Array, position: number) => {
        const end = position + bytes.byteLength;
        ensureCapacity(end);
        buffer.set(bytes, position);
        if (end > length) {
          length = end;
        }
      };

      const toBytes = (data: unknown): Uint8Array | null => {
        if (data instanceof ArrayBuffer) {
          return new Uint8Array(data);
        }
        if (ArrayBuffer.isView(data)) {
          return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }
        return null;
      };

      return {
        seek(position: number) {
          cursor = position;
          return Promise.resolve();
        },
        write(data: unknown) {
          const bytes = toBytes(data);
          if (bytes) {
            writeBytes(bytes, cursor);
            cursor += bytes.byteLength;
          }
          return Promise.resolve();
        },
        close() {
          const blob = new Blob([buffer.slice(0, length)], { type: mimeType });
          onBlobReady(blob);
          return Promise.resolve();
        },
        abort() {
          return Promise.resolve();
        },
        truncate(size: number) {
          if (size < length) {
            length = size;
          }
          return Promise.resolve();
        },
      } as FileSystemWritableFileStream;
    },
    [],
  );

  const handleExport = useCallback(
    async (type: ExportType) => {
      setIsExportOpen(false);

      try {
        if (type === "wav") {
          const writable = await showSavePicker(`${project.name || "export"}.wav`, "wav");

          setExportState({
            isExporting: true,
            progress: 0,
            phase: "Initializing...",
            error: null,
            complete: false,
          });

          const engine = getExportEngine();
          await engine.initialize();

          const audioSettings: Partial<AudioExportSettings> = {
            format: "wav",
            sampleRate: 48000,
            channels: 2,
            bitDepth: 24,
          };

          const generator = engine.exportAudio(project, audioSettings);
          let finalResult: ExportResult | undefined;

          while (true) {
            const { value, done } = await generator.next();
            if (done) {
              finalResult = value;
              break;
            }
            setExportState((prev) => ({
              ...prev,
              progress: value.progress * 100,
              phase: value.phase === "complete" ? "Complete!" : `${value.phase}...`,
            }));
          }

          if (finalResult?.success && finalResult.blob) {
            if ("showSaveFilePicker" in window) {
              await finalResult.blob.stream().pipeTo(writable as unknown as WritableStream<Uint8Array>);
            } else {
              const url = URL.createObjectURL(finalResult.blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${project.name || "export"}.wav`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }
            setExportState((prev) => ({ ...prev, complete: true, phase: "Saved!" }));
            track(AnalyticsEvents.PROJECT_EXPORTED, {
              format: "wav",
              duration: project.timeline?.duration ?? 0,
            });
          } else {
            try { await writable.abort(); } catch {}
            throw new Error(finalResult?.error?.message || "Export failed");
          }
        } else {
          const base = {
            width: project.settings.width,
            height: project.settings.height,
            frameRate: project.settings.frameRate,
          };

          const presets: Record<string, { settings: Partial<VideoExportSettings>; ext: string }> = {
            mp4: { settings: { ...base, format: "mp4", codec: "h264", bitrate: 12000, quality: 85 }, ext: "mp4" },
            gif: { settings: { ...base, format: "webm", codec: "vp9", bitrate: 8000 }, ext: "webm" },
            project: { settings: { ...base, format: "mp4", codec: "h264", bitrate: 12000, quality: 85 }, ext: "mp4" },
            "4k-60-master": { settings: { ...base, width: 3840, height: 2160, frameRate: 60, format: "mov", codec: "h265", bitrate: 100000, quality: 95 }, ext: "mov" },
            "4k-master": { settings: { ...base, width: 3840, height: 2160, frameRate: 30, format: "mov", codec: "h265", bitrate: 80000, quality: 95 }, ext: "mov" },
            "4k-prores": { settings: { ...base, width: 3840, height: 2160, frameRate: 30, format: "mov", codec: "prores", bitrate: 880000, quality: 100 }, ext: "mov" },
            "4k": { settings: { ...base, width: 3840, height: 2160, frameRate: 30, format: "mp4", codec: "h264", bitrate: 50000, quality: 90 }, ext: "mp4" },
            "1080p-60": { settings: { ...base, width: 1920, height: 1080, frameRate: 60, format: "mp4", codec: "h264", bitrate: 25000, quality: 95 }, ext: "mp4" },
            "1080p-high": { settings: { ...base, width: 1920, height: 1080, frameRate: 30, format: "mp4", codec: "h264", bitrate: 20000, quality: 95 }, ext: "mp4" },
            prores: { settings: { ...base, format: "mov", codec: "prores", bitrate: 220000, quality: 100 }, ext: "mov" },
          };

          const preset = presets[type] ?? presets.mp4;
          const outputFilename = `${project.name || "export"}.${preset.ext}`;
          const writable = await showSavePicker(outputFilename, preset.ext);
          const mimeMap: Record<string, string> = {
            mp4: "video/mp4",
            webm: "video/webm",
            mov: "video/quicktime",
          };
          const mirroredWritable = createMirroredWritable(
            writable,
            mimeMap[preset.ext] || "video/mp4",
            (blob) => {
              setPublishBlob(blob);
              setPublishFilename(outputFilename);
            },
          );

          setExportState({
            isExporting: true,
            progress: 0,
            phase: "Initializing...",
            error: null,
            complete: false,
          });

          await runExport(preset.settings, preset.ext, mirroredWritable);
        }

        setTimeout(() => {
          setExportState({ isExporting: false, progress: 0, phase: "", error: null, complete: false });
        }, 2000);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        setExportState((prev) => ({
          ...prev,
          isExporting: false,
          error: error instanceof Error ? error.message : "Export failed",
        }));
      }
    },
    [project, track, runExport, showSavePicker],
  );

  const handleCancelExport = useCallback(() => {
    const engine = getExportEngine();
    engine.cancel();
    if (exportToBlobRef.current) {
      exportToBlobRef.current.abort();
      exportToBlobRef.current = null;
    }
    setExportState({
      isExporting: false,
      progress: 0,
      phase: "",
      error: null,
      complete: false,
    });
  }, []);

  const handleCustomExport = useCallback(
    async (settings: VideoExportSettings) => {
      // ExportDialog has already called onClose() before invoking us, so
      // the overlay is gone and showSaveFilePicker can fire cleanly
      // with the user-activation token from the Start Export click.
      try {
        const ext = settings.format === "mov" ? "mov" : settings.format === "webm" ? "webm" : "mp4";
          const outputFilename = `${project.name || "export"}.${ext}`;
          const writable = await showSavePicker(outputFilename, ext);
          const mimeMap: Record<string, string> = {
            mp4: "video/mp4",
            webm: "video/webm",
            mov: "video/quicktime",
          };
          const mirroredWritable = createMirroredWritable(
            writable,
            mimeMap[ext] || "video/mp4",
            (blob) => {
              setPublishBlob(blob);
              setPublishFilename(outputFilename);
            },
          );

        setExportState({
          isExporting: true,
          progress: 0,
          phase: "Initializing...",
          error: null,
          complete: false,
        });

        const needsUpscaling =
          settings.width > project.settings.width ||
          settings.height > project.settings.height;

        const exportSettings: Partial<VideoExportSettings> = {
          ...settings,
          upscaling:
            settings.upscaling?.enabled && needsUpscaling
              ? settings.upscaling
              : undefined,
        };

        await runExport(exportSettings, ext, mirroredWritable);

        track(AnalyticsEvents.PROJECT_EXPORTED, {
          format: settings.format,
          codec: settings.codec,
          width: settings.width,
          height: settings.height,
          frameRate: settings.frameRate,
          duration: project.timeline?.duration ?? 0,
          exportType: "custom",
          upscaling: settings.upscaling?.enabled ?? false,
        });

        setTimeout(() => {
          setExportState({ isExporting: false, progress: 0, phase: "", error: null, complete: false });
        }, 2000);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        setExportState((prev) => ({
          ...prev,
          isExporting: false,
          error: error instanceof Error ? error.message : "Export failed",
        }));
      }
    },
    [project, track, runExport, showSavePicker, createMirroredWritable],
  );


  const exportToBlobRef = useRef<AbortController | null>(null);

  const handlePublish = useCallback(
    async () => {
      setIsExportOpen(false);

      const outputFilename = `${project.name || "export"}.mp4`;
      setPublishFilename(outputFilename);

      if (publishBlob && publishBlob.size > 0) {
        setIsPublishDialogOpen(true);
        return;
      }

      try {
        setExportState({
          isExporting: true,
          progress: 0,
          phase: "Rendering for publish...",
          error: null,
          complete: false,
        });

        const renderedBlobRef: { current: Blob | null } = { current: null };
        const writable = createMemoryWritable("video/mp4", (blob) => {
          renderedBlobRef.current = blob;
          setPublishBlob(blob);
          setPublishFilename(outputFilename);
        });

        const publishSettings: Partial<VideoExportSettings> = {
          width: project.settings.width,
          height: project.settings.height,
          frameRate: project.settings.frameRate,
          format: "mp4",
          codec: "h264",
          bitrate: 12000,
          quality: 90,
        };

        await runExport(publishSettings, "mp4", writable);

        if (!renderedBlobRef.current || renderedBlobRef.current.size === 0) {
          throw new Error("Render completed but produced no publishable video.");
        }

        setExportState({
          isExporting: false,
          progress: 0,
          phase: "",
          error: null,
          complete: false,
        });
        setIsPublishDialogOpen(true);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        setExportState((prev) => ({
          ...prev,
          isExporting: false,
          error: error instanceof Error ? error.message : "Publish render failed",
        }));
      }
    },
    [project, publishBlob, createMemoryWritable, runExport],
  );

  const handleRecordingComplete = useCallback(
    async (
      screenBlob: Blob,
      webcamBlob?: Blob,
      mode?: "screen" | "camera" | "both" | "audio",
    ) => {
      if (!screenBlob || screenBlob.size === 0) {
        toast.error(
          "Recording failed",
          "No data was captured. Please try again.",
        );
        return;
      }

      const timestamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:-]/g, "");
      let importCount = 0;
      const errors: string[] = [];

      // The PRIMARY recording is named by what it actually is: audio-only →
      // an audio track, camera → a webcam clip, screen/both → the screen.
      const isAudio = mode === "audio" || (screenBlob.type || "").startsWith("audio");
      const primaryLabel = isAudio ? "Audio" : mode === "camera" ? "Webcam" : "Screen";
      const primaryFile = new File([screenBlob], `${primaryLabel}_${timestamp}.webm`, {
        type: screenBlob.type || (isAudio ? "audio/webm" : "video/webm"),
      });
      const primaryResult = await importMedia(primaryFile);
      if (primaryResult.success) {
        importCount++;
        // An audio-only recording IS the user's voice — file it under "Voice"
        // in the Media tab (instead of the generic "Imported" bucket it landed
        // in, which is why it seemed to "disappear"). The disk save below uses
        // the `narration` kind so it ALSO shows in the cross-project Library
        // under Voice. Webcam/screen takes keep their default category.
        if (isAudio && primaryResult.actionId) {
          const vid = primaryResult.actionId;
          useProjectStore.setState((s: any) => ({
            project: {
              ...s.project,
              mediaLibrary: {
                ...s.project.mediaLibrary,
                items: (s.project.mediaLibrary?.items ?? []).map((m: any) =>
                  m.id === vid ? { ...m, category: "Voice", role: m.role ?? "voice" } : m,
                ),
              },
              modifiedAt: Date.now(),
            },
          }));
        }
      } else {
        errors.push(
          primaryResult.error?.message || `Failed to import ${primaryLabel.toLowerCase()} recording`,
        );
      }

      // 'both' mode also produces a separate webcam file.
      let webcamMediaId: string | null = null;
      if (webcamBlob && webcamBlob.size > 0) {
        const webcamFile = new File([webcamBlob], `Webcam_${timestamp}.webm`, {
          type: webcamBlob.type || "video/webm",
        });
        const webcamResult = await importMedia(webcamFile);
        if (webcamResult.success) {
          importCount++;
          webcamMediaId = webcamResult.actionId ?? null;
        } else {
          errors.push(
            webcamResult.error?.message || "Failed to import webcam recording",
          );
        }
      }

      // Tag the imported item's originalUrl with the durable local-asset
      // serve URL so (a) the agent's timeline context carries a URL the
      // transcribe/build-scenes tools can read from disk, and (b) the item
      // rehydrates after IndexedDB eviction (same idiom as
      // voidspace:add-media-from-url in App.tsx).
      const tagOriginalUrl = (mediaId: string, url: string) => {
        useProjectStore.setState((s: any) => ({
          project: {
            ...s.project,
            mediaLibrary: {
              ...s.project.mediaLibrary,
              items: (s.project.mediaLibrary?.items ?? []).map((m: any) =>
                m.id === mediaId ? { ...m, originalUrl: m.originalUrl ?? url } : m,
              ),
            },
            modifiedAt: Date.now(),
          },
        }));
      };

      // Durability: also save the raw take(s) to the user's local folder so
      // they persist beyond IndexedDB and the project reopens later. Best-
      // effort and non-blocking — the in-editor copy already works without it.
      let savedToDisk = false;
      try {
        // Audio takes save to narrations/ (kind 'narration') so they reach the
        // Library under Voice; webcam/screen takes stay local-only in recordings/.
        const primarySave = await saveMediaToDisk(
          primaryFile,
          `${primaryLabel}_${timestamp}`,
          "webm",
          isAudio ? "narration" : "recordings",
        );
        savedToDisk = !!primarySave;
        if (primarySave?.url && primaryResult.success && primaryResult.actionId) {
          tagOriginalUrl(primaryResult.actionId, primarySave.url);
        }
        if (webcamBlob && webcamBlob.size > 0) {
          const webcamSave = await saveRecordingToDisk(webcamBlob, `Webcam_${timestamp}`, "webm");
          if (webcamSave?.url && webcamMediaId) {
            tagOriginalUrl(webcamMediaId, webcamSave.url);
          }
        }
      } catch {
        /* non-fatal — recording is still usable from the asset library */
      }

      if (importCount > 0) {
        // Persist the new recording to project_state IMMEDIATELY. importMedia
        // only mutates the in-memory project + IndexedDB blob; the library item
        // doesn't reach the durable project_state blob (local autosave +
        // Firestore) until the next periodic autosave. If the user reloads in
        // that window, the item vanishes from Assets (the blob orphans in
        // IndexedDB) — the "my recordings disappeared" bug. A forceSave here
        // closes that window so a recording survives a reload the instant it's
        // taken. Best-effort; the in-editor copy works regardless.
        try {
          await autoSaveManager.forceSave(useProjectStore.getState().project);
        } catch (err) {
          console.warn("[recording] forceSave after import failed:", err);
        }
        toast.success(
          `${importCount} recording${importCount > 1 ? "s" : ""} imported!`,
          savedToDisk
            ? "Saved to your Voidspace folder and added to assets."
            : webcamBlob && webcamBlob.size > 0
              ? "Screen and webcam added to assets. Use the timeline to composite them."
              : `${primaryLabel} recording added to assets.`,
        );
      } else if (errors.length > 0) {
        toast.error("Import failed", errors.join(". "));
      }
    },
    [importMedia],
  );

  const projectRes = `${project.settings.width}×${project.settings.height}`;
  const aspectRatio = project.settings.width / project.settings.height;
  const isVertical = aspectRatio < 0.9;

  const exportOptions: Array<{
    label: string;
    icon: typeof FileVideo;
    desc: string;
    type: ExportType;
    recommended?: boolean;
    separator?: boolean;
  }> = [
    {
      label: "MP4 Standard",
      icon: Zap,
      desc: `${projectRes} H.264 - Web & social`,
      type: "mp4",
      recommended: true,
    },
    {
      label: "",
      icon: Film,
      desc: "",
      type: "mp4",
      separator: true,
    },
    ...(isVertical
      ? []
      : [
          {
            label: "4K Standard",
            icon: FileVideo,
            desc: "3840×2160 - YouTube 4K",
            type: "4k" as ExportType,
          },
        ]),
    {
      label: "1080p High Quality",
      icon: FileVideo,
      desc: "1920×1080 30fps - High bitrate",
      type: "1080p-high",
    },
    {
      label: "1080p 60fps",
      icon: FileVideo,
      desc: "1920×1080 - Smooth playback",
      type: "1080p-60",
    },
    {
      label: "Audio Only (WAV)",
      icon: Music,
      desc: "Uncompressed audio",
      type: "wav",
    },
  ];

  return (
    <div className="h-16 border-b border-border flex items-center px-6 justify-between bg-background shrink-0 z-30 relative">
      <div className="flex items-center gap-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => {
                if (window.top && window.top !== window) {
                  window.top.location.href = "/studio/projects";
                  return;
                }
                window.location.href = "/studio/projects";
              }}
              className="flex items-center gap-3 hover:opacity-80 transition-opacity"
              title="Back to Studio Projects"
            >
              <img
                src="/studio/images/logo.png"
                alt="Voidspace"
                className="w-8 h-8 group-hover:scale-110 transition-transform duration-300"
              />
              {/* VOIDSPACE wordmark removed — the chat sidebar already
                  shows the brand; doubling it on the editor toolbar
                  ate horizontal space and made the row feel cluttered. */}
            </button>
          </TooltipTrigger>
          <TooltipContent>Back to Studio Projects</TooltipContent>
        </Tooltip>
        <div className="h-6 w-px bg-border hidden md:block" />
        <button
          onClick={() => {
            if (window.top && window.top !== window) {
              window.top.location.href = "/studio/projects";
              return;
            }
            window.location.href = "/studio/projects";
          }}
          /* Allow the button to size to its label and never overflow the
             toolbar gutter. The previous fixed height + no min-width let
             the text clip on narrower split-mode panes. */
          className="h-9 px-3 rounded-lg border border-border bg-background-secondary text-sm text-text-secondary hover:text-text-primary hover:bg-background-elevated transition-colors whitespace-nowrap shrink-0 inline-flex items-center"
          title="Back to Studio Projects"
        >
          Back to Projects
        </button>
      </div>

      {/* The "Search tools, effects, or ask AI…" command palette
          launcher used to live here. Hidden by request — the chat
          sidebar is the canonical search/ask surface in the studio
          shell, so duplicating it in the editor toolbar was both
          visually noisy and confusing for users who couldn't tell
          which AI surface they were talking to. */}
      <div className="flex-1" />

      <div className="flex items-center gap-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="p-2 rounded-lg hover:bg-background-elevated text-text-secondary hover:text-text-primary transition-colors"
            >
              <HelpCircle size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={handleStartTour} className="gap-2">
              <Play size={14} />
              <span>Editor Tour</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleStartMoGraphTour} className="gap-2">
              <Sparkles size={14} className="text-purple-400" />
              <span>Animation & Effects Tour</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 text-text-muted">
              <Command size={14} />
              <span>Press ? for shortcuts</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Theme toggle removed in the studio shell — the website's
            top-bar theme button is the single source of truth.
            Studio-AI relays the website's theme into this iframe via
            ?theme= URL param + a `voidspace:theme` postMessage; the
            App.tsx listener applies it to the openreel theme store
            so light/dark stays in lockstep with the parent. */}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => openSettings()}
              className="p-2 rounded-lg hover:bg-background-elevated text-text-secondary hover:text-text-primary transition-colors"
            >
              <Settings size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Settings & API Keys</p>
          </TooltipContent>
        </Tooltip>

        {/* Center-column swap: video player ⇄ audio mixer. Always available
            in BOTH modes so a music project can show the video player and a
            video project can show the mixer. Mirrors centerView in ui-store;
            EditorInterface keeps Preview mounted-but-hidden when the mixer
            is up, so playback never stops. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => toggleCenterView()}
              className={`p-2 rounded-lg transition-colors ${
                showMixerCenter
                  ? "bg-primary/20 text-primary"
                  : "hover:bg-background-elevated text-text-secondary hover:text-text-primary"
              }`}
            >
              {showMixerCenter ? <MonitorPlay size={16} /> : <SlidersHorizontal size={16} />}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{showMixerCenter ? "Show video player" : "Show audio mixer"}</p>
          </TooltipContent>
        </Tooltip>

        {!showMixerCenter && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => togglePreviewCollapsed()}
                className={`p-2 rounded-lg transition-colors ${
                  previewCollapsed
                    ? "bg-primary/20 text-primary"
                    : "hover:bg-background-elevated text-text-secondary hover:text-text-primary"
                }`}
              >
                {previewCollapsed ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{previewCollapsed ? "Show video preview" : "Minimize video preview"}</p>
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => useUIStore.getState().openModal("scriptView")}
              className="p-2 rounded-lg hover:bg-background-elevated text-text-secondary hover:text-text-primary transition-colors"
            >
              <FileCode size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Project JSON - Export/Import</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={toggleKeyframeEditor}
              className={`p-2 rounded-lg transition-colors ${
                keyframeEditorOpen
                  ? "bg-primary/20 text-primary"
                  : "hover:bg-background-elevated text-text-secondary hover:text-text-primary"
              }`}
            >
              <Diamond size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Keyframe Editor</p>
          </TooltipContent>
        </Tooltip>

        {!showMixerCenter && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => togglePanel("audioMixer")}
                className={`p-2 rounded-lg transition-colors ${
                  panels.audioMixer?.visible
                    ? "bg-primary/20 text-primary"
                    : "hover:bg-background-elevated text-text-secondary hover:text-text-primary"
                }`}
              >
                <Music size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Audio Mixer – track volume and master level</p>
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setIsHistoryOpen(!isHistoryOpen)}
              className={`p-2 rounded-lg transition-colors ${
                isHistoryOpen
                  ? "bg-primary/20 text-primary"
                  : "hover:bg-background-elevated text-text-secondary hover:text-text-primary"
              }`}
            >
              <History size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>History - Undo/Redo</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                saveFlash
                  ? "bg-green-500/20 text-green-400"
                  : "bg-background-secondary hover:bg-background-tertiary text-text-secondary hover:text-text-primary"
              } ${isSaving ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <Save size={14} />
              <span className="text-sm font-medium">{saveFlash ? "Saved" : "Save"}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Save project + chat (Ctrl+S)</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setIsRecorderOpen(true)}
              className="flex items-center gap-2 px-3 py-2 bg-error/10 hover:bg-error/20 text-error rounded-lg transition-colors"
            >
              <Circle size={14} className="fill-current" />
              <span className="text-sm font-medium">Record</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Screen Recording</p>
          </TooltipContent>
        </Tooltip>

        <div className="relative">
          {exportState.isExporting ? (
            <div className="h-10 px-4 bg-background-secondary border border-border rounded-lg flex items-center gap-3 min-w-[200px]">
              <Loader2 size={14} className="text-primary animate-spin" />
              <div className="flex-1">
                <div className="text-[10px] text-text-secondary">
                  {exportState.phase}
                </div>
                <div className="h-1 bg-background-tertiary rounded-full mt-1 overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-200"
                    style={{ width: `${exportState.progress}%` }}
                  />
                </div>
              </div>
              <button
                onClick={handleCancelExport}
                className="p-1 hover:bg-background-tertiary rounded text-text-muted hover:text-error transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          ) : exportState.error ? (
            <div className="h-10 px-4 bg-error/10 border border-error/30 rounded-lg flex items-center gap-2">
              <span className="text-xs text-error">{exportState.error}</span>
              <button
                onClick={() =>
                  setExportState((prev) => ({ ...prev, error: null }))
                }
                className="p-1 hover:bg-error/20 rounded text-error transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          ) : exportState.complete ? (
            <div className="h-10 px-4 bg-primary/10 border border-primary/30 rounded-lg flex items-center gap-2">
              <Check size={14} className="text-primary" />
              <span className="text-xs text-primary">Downloaded!</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {/*
                Publish button is hidden when the editor runs inside the
                Voidspace chat iframe. The chat owns the publish flow
                end-to-end (its result card has the Publish button +
                platform-select modal that pulls connected accounts from
                the user's avatar settings). Surfacing a SECOND publish
                button here would create two divergent code paths into
                the social-post tool — keeping a single source of truth
                in the chat is what the user explicitly asked for.
                Detection: standalone openreel renders in a top-level
                window; the chat-embedded iframe carries `?embed=1`
                (set by studio-ai/index.vue's iframe `:src` builder)
                AND has window.self !== window.top.
              */}
              {!(
                typeof window !== "undefined" &&
                (window.self !== window.top ||
                  new URLSearchParams(window.location.search).get("embed") === "1")
              ) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handlePublish}
                      className="h-10 px-4 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold rounded-lg flex items-center gap-2 transition-all shadow-[0_0_20px_rgba(59,130,246,0.3)] hover:shadow-[0_0_30px_rgba(59,130,246,0.5)] transform hover:-translate-y-0.5"
                    >
                      <Send size={14} />
                      <span className="text-sm tracking-wider">PUBLISH</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Publish to your social platforms</TooltipContent>
                </Tooltip>
              )}
              <div className="flex items-center">
                <button
                  onClick={() => setIsExportDialogOpen(true)}
                  className="h-10 px-4 bg-primary/10 border border-primary/30 hover:bg-primary/20 text-primary font-bold rounded-l-lg flex items-center gap-2 transition-all hover:-translate-y-0.5"
                  title="Open render settings"
                >
                  <Download size={14} />
                  <span className="text-sm tracking-wider">RENDER</span>
                </button>
              <DropdownMenu open={isExportOpen} onOpenChange={setIsExportOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    className={`h-10 px-2 bg-primary/10 border border-primary/30 border-l-0 hover:bg-primary/20 text-primary font-medium rounded-r-lg flex items-center transition-all ${
                      isExportOpen ? "" : "hover:-translate-y-0.5"
                    }`}
                    title="Quick presets"
                  >
                    <ChevronDown
                      size={14}
                      className={`transition-transform duration-200 ${
                        isExportOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72 p-0 rounded-xl bg-background-secondary border-border">
                <div className="p-3 space-y-1 max-h-[400px] overflow-y-auto">
                  {exportOptions.map((option, index) =>
                    option.separator ? (
                      <DropdownMenuSeparator key={`sep-${index}`} />
                    ) : (
                      <DropdownMenuItem
                        key={option.type + index}
                        className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer ${
                          option.recommended
                            ? "bg-primary/10 hover:bg-primary/20 border border-primary/30"
                            : ""
                        }`}
                        onClick={() => handleExport(option.type)}
                      >
                        <div
                          className={`p-2 rounded-lg transition-colors ${
                            option.recommended
                              ? "bg-primary/20 text-primary"
                              : "bg-background-tertiary group-hover:bg-background-elevated text-text-secondary group-hover:text-primary"
                          }`}
                        >
                          <option.icon size={18} />
                        </div>
                        <div className="flex-1">
                          <div
                            className={`text-sm font-medium transition-colors ${
                              option.recommended
                                ? "text-primary"
                                : "text-text-primary"
                            }`}
                          >
                            {option.label}
                            {option.recommended && (
                              <span className="ml-2 text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded">
                                Best Match
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-text-muted mt-0.5">
                            {option.desc}
                          </div>
                          {exportEstimates.get(option.type) && (
                            <div className="text-[10px] text-text-secondary mt-1">
                              Est. {exportEstimates.get(option.type)?.formatted}
                            </div>
                          )}
                        </div>
                      </DropdownMenuItem>
                    ),
                  )}

                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="flex items-center gap-3 p-3 rounded-lg cursor-pointer"
                    onClick={() => setIsExportDialogOpen(true)}
                  >
                    <div className="p-2 bg-primary/10 rounded-lg text-primary transition-colors">
                      <Settings size={18} />
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-primary transition-colors">
                        Custom Export...
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">
                        Full settings with AI upscaling
                      </div>
                    </div>
                    <Settings
                      size={14}
                      className="text-text-muted"
                    />
                  </DropdownMenuItem>
                </div>
                <div className="bg-background-tertiary px-3 py-2.5 text-xs text-center text-text-muted border-t border-border">
                  {project.settings.width}×{project.settings.height} •{" "}
                  {project.settings.frameRate}fps
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
            </div>
          </div>
          )}
        </div>
      </div>

      <ExportDialog
        isOpen={isExportDialogOpen}
        onClose={() => setIsExportDialogOpen(false)}
        onExport={handleCustomExport}
        duration={project.timeline?.duration ?? 0}
        projectWidth={project.settings?.width ?? 1920}
        projectHeight={project.settings?.height ?? 1080}
      />

      <PublishDialog
        isOpen={isPublishDialogOpen}
        onClose={() => {
          setIsPublishDialogOpen(false);
          setPublishBlob(null);
          setPublishFilename("");
        }}
        videoBlob={publishBlob}
        videoFilename={publishFilename}
        projectWidth={project.settings?.width ?? 1920}
        projectHeight={project.settings?.height ?? 1080}
        onDownload={() => {
          if (publishBlob) {
            const url = URL.createObjectURL(publishBlob);
            const a = document.createElement("a");
            a.href = url;
            a.download = publishFilename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
        }}
      />

      <ScreenRecorder
        isOpen={isRecorderOpen}
        onClose={() => setIsRecorderOpen(false)}
        onRecordingComplete={handleRecordingComplete}
      />

      <SettingsDialog />

      {isHistoryOpen && typeof document !== "undefined" && createPortal(
        // Portal to <body> so the panel escapes Toolbar's z-30 stacking
        // context. Otherwise its z-index is bounded by Toolbar's, and
        // the Timeline header (z-[100], in the EditorInterface stacking
        // context) renders ON TOP of the panel — px/s zoom controls
        // punch through. With portal, the panel sits in the root
        // stacking context and `z-[160]` actually wins.
        <>
          <div
            className="fixed inset-0 bg-black/20 z-[150]"
            onClick={() => setIsHistoryOpen(false)}
          />
          <div className="fixed top-16 right-0 bottom-0 w-80 bg-background-secondary border-l border-border z-[160] shadow-2xl animate-in slide-in-from-right duration-200">
            <div className="flex items-center justify-between p-3 border-b border-border">
              <span className="text-sm font-medium text-text-primary">Action History</span>
              <button
                onClick={() => setIsHistoryOpen(false)}
                className="p-1.5 rounded hover:bg-background-tertiary text-text-muted hover:text-text-primary transition-colors"
              >
                <X size={14} />
              </button>
            </div>
            <div className="h-[calc(100%-49px)]">
              <HistoryPanel />
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
};

export default Toolbar;
