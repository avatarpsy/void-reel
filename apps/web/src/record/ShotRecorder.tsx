import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Circle, Pause, Play, RotateCcw, Settings, Square, Trash2, X } from "lucide-react";
import { useRecorderStore } from "../stores/recorder-store";
import {
  ScreenRecorderService,
  formatDuration,
  getFileExtension,
  type RecordingMode,
  type RecordingResult,
} from "../services/screen-recorder";
import { ensureWhisperModel } from "../services/teleprompter-asr";
import { canSaveToCloud, saveMediaToCloudFor } from "../services/cloud-save-host";
import { Teleprompter } from "../components/editor/Teleprompter";
import { InlineRecordingPreview } from "../components/editor/InlineRecordingPreview";
import {
  aspectToRecorder,
  isFromParent,
  MAX_SCRIPT,
  postToParent,
  readInit,
  readParams,
  readTakeResult,
  type TakeResult,
} from "./protocol";

/**
 * The shot recorder: one board shot, one camera, as many takes as it takes.
 *
 * Everything that records is the editor's own: the recorder store and service
 * (device pickers, measured camera modes, 3-2-1 countdown, pause), the live
 * preview with countdown (InlineRecordingPreview) and the voice-follow
 * teleprompter. This page only lays them out for a single shot and hands
 * finished takes to the board (see ./protocol.ts).
 */

type View = "camera" | "review";
type SaveState = "local" | "saving" | "saved" | "failed";

interface TakePart {
  blob: Blob;
  ext: string;
  /** Added to the label for the second file of a "Screen + camera" take. */
  suffix: string;
  /** Uploaded already: a retry after the board said no re-sends, never re-uploads. */
  url?: string;
  saved: boolean;
}

interface Take {
  id: string;
  label: string;
  /** Plays the take in the review player. */
  url: string;
  durationSec: number;
  parts: TakePart[];
  state: SaveState;
  progress: number;
  error?: string;
  warning?: string;
}

interface Problem {
  title: string;
  detail: string;
}

const SCRIPT_DEBOUNCE_MS = 800;
/** How long to wait for the board to confirm a take before calling it failed. */
const TAKE_RESULT_TIMEOUT_MS = 20000;

const MODES: { value: RecordingMode; label: string }[] = [
  { value: "camera", label: "Camera" },
  { value: "both", label: "Screen + camera" },
];

/** Work out WHY the camera did not open, in words a person can act on. */
async function describeCameraProblem(raw: string, mode: RecordingMode, starting: boolean): Promise<Problem> {
  if (!ScreenRecorderService.isSupported(mode)) {
    return {
      title: "This browser can't record video.",
      detail: "Open this page in Chrome, Edge or Safari.",
    };
  }
  if (starting && mode === "both" && /denied|not allowed|permission|cancel/i.test(raw)) {
    return {
      title: "Screen sharing didn't start.",
      detail: "Press Record and choose a screen, window or tab to share.",
    };
  }
  let blocked = /denied|not allowed|permission/i.test(raw);
  if (!blocked) {
    try {
      const st = await navigator.permissions?.query({ name: "camera" as PermissionName });
      blocked = st?.state === "denied";
    } catch {
      /* not every browser can ask */
    }
  }
  if (blocked) {
    return {
      title: "Your camera or microphone is blocked.",
      detail:
        "Allow both for this site: tap the camera or lock icon in the address bar (or your browser's site settings), then press Try again.",
    };
  }
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    if (devices && !devices.some((d) => d.kind === "videoinput")) {
      return {
        title: "No camera found.",
        detail: "Connect a camera, then press Try again.",
      };
    }
  } catch {
    /* fall through */
  }
  return {
    title: "Your camera didn't start.",
    detail:
      "Close other apps or tabs that use the camera, or pick another camera in Settings, then press Try again.",
  };
}

/** Largest box of `ratio` that fits in w×h. */
function fitBox(w: number, h: number, ratio: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  return w / h > ratio
    ? { width: Math.round(h * ratio), height: Math.round(h) }
    : { width: Math.round(w), height: Math.round(w / ratio) };
}

export const ShotRecorder: React.FC = () => {
  const params = useMemo(() => readParams(window.location.search), []);
  const embedded = window.parent !== window;

  const status = useRecorderStore((s) => s.status);
  const storeError = useRecorderStore((s) => s.error);
  const duration = useRecorderStore((s) => s.duration);
  const previewStream = useRecorderStore((s) => s.previewStream);
  const audioDevices = useRecorderStore((s) => s.audioDevices);
  const videoDevices = useRecorderStore((s) => s.videoDevices);
  const options = useRecorderStore((s) => s.options);
  const mode: RecordingMode = options.mode === "both" ? "both" : "camera";

  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [aspect, setAspect] = useState(params.aspect);
  /** Typing lines in place of a prompter (an empty shot opens on this). */
  const [editingLines, setEditingLines] = useState(false);
  const [showLines, setShowLines] = useState(true);
  const [view, setView] = useState<View>("camera");
  const [takes, setTakes] = useState<Take[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const takeCounter = useRef(0);
  /** What the last camera request was for, so a failure is explained right. */
  const attemptRef = useRef<"preview" | "record">("preview");
  const aspectRef = useRef(aspect);
  aspectRef.current = aspect;
  const takesRef = useRef<Take[]>([]);
  takesRef.current = takes;

  const live = status === "countdown" || status === "recording" || status === "paused";
  const busy = live || status === "processing" || status === "requesting";
  const shape = aspectToRecorder(aspect);
  const modeOptions = MODES.filter((m) => ScreenRecorderService.isSupported(m.value));

  // ── Recorder setup ────────────────────────────────────────────────────────
  const applyRecorderOptions = useCallback((nextMode: RecordingMode, aspectStr: string) => {
    const a = aspectToRecorder(aspectStr);
    const { options: cur, setOptions } = useRecorderStore.getState();
    setOptions({
      mode: nextMode,
      targetAspect: a.targetAspect,
      webcam: { ...cur.webcam, enabled: true, aspect: a.aspect },
      audio: { systemAudio: false, microphone: true },
    });
  }, []);

  const openCamera = useCallback(async () => {
    const st = useRecorderStore.getState();
    useRecorderStore.setState(st.status === "error" ? { status: "idle", error: null } : { error: null });
    attemptRef.current = "preview";
    setProblem(null);
    const m: RecordingMode = st.options.mode === "both" ? "both" : "camera";
    if (!ScreenRecorderService.isSupported(m)) {
      setProblem(await describeCameraProblem("", m, false));
      return;
    }
    await useRecorderStore.getState().startPreview(m);
  }, []);

  useEffect(() => {
    applyRecorderOptions("camera", params.aspect);
    ensureWhisperModel();
    void openCamera();
    return () => {
      useRecorderStore.getState().reset();
    };
  }, [applyRecorderOptions, openCamera, params.aspect]);

  // Turn a store error into a plain message with a way forward.
  useEffect(() => {
    if (!storeError) return;
    let cancelled = false;
    void describeCameraProblem(storeError, mode, attemptRef.current === "record").then((p) => {
      if (!cancelled) setProblem(p);
    });
    return () => {
      cancelled = true;
    };
  }, [storeError, mode]);

  // ── Talking to the board ──────────────────────────────────────────────────
  const userEditedScript = useRef(false);
  /** Waiting for the board to confirm the take we just sent (one at a time). */
  const takeResultWaiter = useRef<((r: TakeResult) => void) | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isFromParent(event)) return;
      const result = readTakeResult(event.data, params.shotId);
      if (result) {
        const resolve = takeResultWaiter.current;
        takeResultWaiter.current = null;
        resolve?.(result);
        return;
      }
      const init = readInit(event.data, params.shotId);
      if (!init) return;
      setTitle(init.title);
      if (!userEditedScript.current) {
        setScript(init.script);
        setEditingLines(!init.script.trim());
      }
      if (init.aspect && init.aspect !== aspectRef.current) {
        setAspect(init.aspect);
        const st = useRecorderStore.getState();
        applyRecorderOptions(st.options.mode === "both" ? "both" : "camera", init.aspect);
        // A new shape needs a new camera mode; only while nothing is recording.
        if (st.status === "idle" && st.previewStream) void openCamera();
      }
    };
    window.addEventListener("message", onMessage);
    postToParent({ type: "voidspace:recorder-ready", shotId: params.shotId });
    // Opened on its own (no board): start with the lines box, since no script will arrive.
    if (!embedded) setEditingLines(true);
    return () => window.removeEventListener("message", onMessage);
  }, [applyRecorderOptions, openCamera, params.shotId, embedded]);

  // Debounced script edits go back to the shot.
  const scriptTimer = useRef<number | null>(null);
  const pendingScript = useRef<string | null>(null);
  const flushScript = useCallback(() => {
    if (scriptTimer.current) window.clearTimeout(scriptTimer.current);
    scriptTimer.current = null;
    if (pendingScript.current !== null) {
      postToParent({ type: "voidspace:recorder-script", shotId: params.shotId, script: pendingScript.current });
      pendingScript.current = null;
    }
  }, [params.shotId]);
  const onScriptChange = (raw: string) => {
    const next = raw.slice(0, MAX_SCRIPT);
    userEditedScript.current = true;
    setScript(next);
    pendingScript.current = next;
    if (scriptTimer.current) window.clearTimeout(scriptTimer.current);
    scriptTimer.current = window.setTimeout(flushScript, SCRIPT_DEBOUNCE_MS);
  };
  useEffect(() => () => flushScript(), [flushScript]);

  // ── Stage sizing ──────────────────────────────────────────────────────────
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setArea({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // No shape from the shot: frame the camera as it comes.
  const trackRatio = useMemo(() => {
    const s = previewStream?.getVideoTracks()[0]?.getSettings?.();
    return s?.width && s?.height ? s.width / s.height : null;
  }, [previewStream]);
  const ratio = shape.ratio ?? trackRatio ?? 16 / 9;
  const box = fitBox(area.w, area.h, ratio);
  // The teleprompter pins itself over [data-tour='preview'] and re-measures on
  // window resize; tell it when the stage moves for any other reason.
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, [box.width, box.height, view, editingLines]);

  // Live camera in the idle stage.
  const bindPreview = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && previewStream && el.srcObject !== previewStream) {
        el.srcObject = previewStream;
        el.play().catch(() => {/* muted; resolves */});
      }
    },
    [previewStream],
  );

  // ── Recording ─────────────────────────────────────────────────────────────
  const record = async () => {
    setSettingsOpen(false);
    setEditingLines(false);
    setProblem(null);
    flushScript();
    const st = useRecorderStore.getState();
    useRecorderStore.setState(st.status === "error" ? { status: "idle", error: null } : { error: null });
    attemptRef.current = "record";
    // Same sequence as the editor's Record dialog: drop the preview, take the
    // real streams with the chosen devices, then 3-2-1.
    st.stopPreview();
    const ok = await st.requestPermissions();
    if (ok) await useRecorderStore.getState().startRecording();
  };

  const cancelCountdown = () => {
    useRecorderStore.getState().cancelRecording();
    void openCamera();
  };

  const addTake = (result: RecordingResult, fallbackSec: number) => {
    const n = ++takeCounter.current;
    const primary = result.screenBlob;
    const parts: TakePart[] = [
      { blob: primary, ext: getFileExtension(primary.type || "video/webm"), suffix: "", saved: false },
    ];
    if (result.webcamBlob && result.webcamBlob.size > 0) {
      parts.push({
        blob: result.webcamBlob,
        ext: getFileExtension(result.webcamBlob.type || "video/webm"),
        suffix: " · camera",
        saved: false,
      });
    }
    const cap = result.capture;
    let warning: string | undefined;
    if (cap && cap.frames !== null && cap.durationSec > 2 && cap.frames / cap.durationSec < 5) {
      warning = "Your camera sent very few frames, so this take may play like a still picture. Try another camera in Settings.";
    }
    const take: Take = {
      id: `take-${Date.now()}-${n}`,
      label: `Take ${n}`,
      url: URL.createObjectURL(primary),
      durationSec: Math.round((cap?.durationSec ?? fallbackSec) * 10) / 10,
      parts,
      state: "local",
      progress: 0,
      warning,
    };
    setTakes((t) => [...t, take]);
    setSelectedId(take.id);
    setView("review");
  };

  const stop = async () => {
    const fallbackSec = useRecorderStore.getState().duration / 1000;
    const result = await useRecorderStore.getState().stopRecording();
    if (result && result.screenBlob.size > 0) {
      addTake(result, fallbackSec);
    } else {
      // The camera is closed after a take; "Try again" reopens it.
      setProblem({
        title: "Nothing was recorded.",
        detail: "Press Try again, then Record.",
      });
    }
  };

  const recordAgain = () => {
    setView("camera");
    void openCamera();
  };

  // ── Takes ─────────────────────────────────────────────────────────────────
  const patchTake = (id: string, patch: Partial<Take>) =>
    setTakes((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  /** Post a take and wait for the board to say it is on the shot. */
  const sendTake = (msg: Parameters<typeof postToParent>[0]): Promise<TakeResult> =>
    new Promise((resolve) => {
      // A previous wait that never got its answer is over.
      takeResultWaiter.current?.({ ok: false });
      const timer = window.setTimeout(() => {
        if (takeResultWaiter.current === done) takeResultWaiter.current = null;
        resolve({ ok: false, message: "The board didn't answer. Your take is still here. Try again." });
      }, TAKE_RESULT_TIMEOUT_MS);
      const done = (r: TakeResult) => {
        window.clearTimeout(timer);
        resolve(r);
      };
      takeResultWaiter.current = done;
      postToParent(msg);
    });

  const saveTake = async (take: Take) => {
    if (!embedded || !params.boardId || !canSaveToCloud()) {
      patchTake(take.id, {
        state: "failed",
        error: "This page can't save takes on its own. Open the recorder from a shot on your board.",
      });
      return;
    }
    patchTake(take.id, { state: "saving", progress: 0, error: undefined });
    const parts = take.parts.map((p) => ({ ...p }));
    const todo = parts.filter((p) => !p.saved);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.saved) continue;
      const idx = todo.indexOf(part);
      const label = `${take.label}${part.suffix}`;
      const saved = part.url ? { url: part.url } : await saveMediaToCloudFor(
        part.blob,
        `${title.trim() || "Shot"} · ${label}`,
        part.ext,
        "recordings",
        {
          projectId: params.boardId,
          onProgress: (f) => patchTake(take.id, { progress: (idx + Math.min(1, Math.max(0, f))) / todo.length }),
        },
      );
      if (!saved) {
        patchTake(take.id, {
          parts,
          state: "failed",
          error: "Couldn't save this take. It's still here. Check your connection and try again.",
        });
        return;
      }
      part.url = saved.url;
      const answer = await sendTake({
        type: "voidspace:recorder-take",
        shotId: params.shotId,
        url: saved.url,
        durationSec: take.durationSec,
        label,
        keepOpen: true,
      });
      if (!answer.ok) {
        patchTake(take.id, {
          parts,
          state: "failed",
          error: answer.message || "The board couldn't add this take. It's still here. Try again.",
        });
        return;
      }
      part.saved = true;
    }
    patchTake(take.id, { parts, state: "saved", progress: 1, error: undefined });
  };

  const deleteTake = (take: Take) => {
    if (take.state === "saving") return;
    if (take.state !== "saved" && !window.confirm(`Delete ${take.label}? It hasn't been used yet.`)) return;
    URL.revokeObjectURL(take.url);
    const rest = takesRef.current.filter((t) => t.id !== take.id);
    setTakes(rest);
    if (selectedId === take.id) {
      const next = rest[rest.length - 1];
      setSelectedId(next?.id ?? null);
      if (!next) recordAgain();
    }
  };

  useEffect(() => () => takesRef.current.forEach((t) => URL.revokeObjectURL(t.url)), []);

  // ── Leaving ───────────────────────────────────────────────────────────────
  const close = () => {
    const st = useRecorderStore.getState().status;
    if ((st === "recording" || st === "paused") && !window.confirm("Stop recording and leave? This take won't be kept.")) {
      return;
    }
    const unsaved = takesRef.current.some((t) => t.state !== "saved");
    if (unsaved && !window.confirm("Leave without using these takes?")) return;
    flushScript();
    useRecorderStore.getState().reset();
    postToParent({ type: "voidspace:recorder-close" });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !settingsOpen) close();
      if (e.key === "Escape" && settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const changeMode = (next: RecordingMode) => {
    applyRecorderOptions(next, aspect);
    setView("camera");
    void openCamera();
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const selected = takes.find((t) => t.id === selectedId) ?? null;
  const showingTake = view === "review" && selected !== null && !live;
  const prompterOn =
    !showingTake && showLines && !editingLines && !problem && script.trim().length > 0;
  const savedCount = takes.filter((t) => t.state === "saved").length;

  return (
    <div
      className="flex flex-col h-screen bg-[#09090b] text-white"
      style={{ height: "100dvh" }}
    >
      {/* Top bar: shot name, settings, close */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 flex-shrink-0">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wide text-white/45">Record</p>
          <p className="text-sm font-medium truncate text-white/90">{title || "This shot"}</p>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            disabled={busy}
            className="w-10 h-10 rounded-full flex items-center justify-center bg-white/5 hover:bg-white/10 disabled:opacity-40"
            aria-label="Settings"
            title="Settings"
          >
            <Settings size={18} />
          </button>
          {settingsOpen && !busy && (
            <SettingsMenu
              mode={mode}
              modeOptions={modeOptions}
              onMode={changeMode}
              cameraId={options.videoDeviceId ?? ""}
              micId={options.audioDeviceId ?? ""}
              cameras={videoDevices}
              mics={audioDevices}
              onCamera={(id) => useRecorderStore.getState().setCamera(id)}
              onMic={(id) => useRecorderStore.getState().setMic(id)}
              showLines={showLines}
              onShowLines={setShowLines}
              onEditLines={() => {
                setEditingLines(true);
                setView("camera");
                setSettingsOpen(false);
              }}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </div>
        <button
          type="button"
          onClick={close}
          className="w-10 h-10 rounded-full flex items-center justify-center bg-white/5 hover:bg-white/10"
          aria-label="Close"
          title="Close"
        >
          <X size={20} />
        </button>
      </div>

      {/* Stage */}
      <div ref={areaRef} className="flex-1 min-h-0 flex items-center justify-center px-4">
        <div
          data-tour="preview"
          className="relative overflow-hidden rounded-xl bg-black"
          style={{ width: box.width, height: box.height }}
        >
          {showingTake ? (
            <video
              key={selected!.id}
              src={selected!.url}
              controls
              autoPlay
              playsInline
              className="w-full h-full object-contain bg-black"
            />
          ) : (
            <>
              {previewStream && !live && (
                <video
                  ref={bindPreview}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-cover"
                  style={{ transform: "scaleX(-1)" }}
                />
              )}
              {!previewStream && !live && !problem && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-white/50">
                  {status === "requesting" ? "Starting…" : "Opening your camera…"}
                </div>
              )}
              <InlineRecordingPreview />
            </>
          )}

          {problem && !live && !showingTake && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-black/85">
              <p className="text-base font-semibold">{problem.title}</p>
              <p className="text-sm text-white/70 max-w-xs">{problem.detail}</p>
              <button
                type="button"
                onClick={() => void openCamera()}
                className="mt-1 px-5 py-2.5 rounded-full bg-white text-black text-sm font-semibold"
              >
                Try again
              </button>
            </div>
          )}

          {editingLines && !live && !showingTake && !problem && (
            <div className="absolute inset-0 flex flex-col gap-2 p-3 bg-black/75">
              <label htmlFor="shot-lines" className="text-sm font-medium text-white/90">
                Your lines
              </label>
              <textarea
                id="shot-lines"
                value={script}
                onChange={(e) => onScriptChange(e.target.value)}
                placeholder="Type or paste what you'll say. It scrolls with your voice while you record."
                maxLength={MAX_SCRIPT}
                className="flex-1 min-h-0 w-full resize-none text-base !bg-black/60 !text-white"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingLines(false)}
                  className="px-4 py-2 rounded-full bg-white text-black text-sm font-semibold"
                >
                  {script.trim() ? "Done" : "Skip"}
                </button>
              </div>
            </div>
          )}

          {selected?.warning && showingTake && (
            <div className="absolute top-2 left-2 right-2 px-3 py-2 rounded-lg bg-amber-500/90 text-black text-xs">
              {selected.warning}
            </div>
          )}
        </div>
      </div>

      {prompterOn && (
        <Teleprompter
          script={script}
          active={status === "recording"}
          live={live}
          holdLabel={status === "countdown" ? "Starting…" : "Paused"}
          onClose={() => setShowLines(false)}
        />
      )}

      {/* Takes from this session */}
      {takes.length > 0 && (
        <div className="flex-shrink-0 px-4 pt-3">
          <div className="flex gap-2 overflow-x-auto no-scrollbar">
            {takes.map((t) => (
              <div
                key={t.id}
                className={`flex items-center flex-shrink-0 rounded-full border text-xs ${
                  t.id === selectedId && view === "review"
                    ? "border-white/70 bg-white/10"
                    : "border-white/15 bg-white/5"
                }`}
              >
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSelectedId(t.id);
                    setView("review");
                  }}
                  className="flex items-center gap-1.5 pl-3 pr-2 py-1.5 disabled:opacity-50"
                >
                  {t.state === "saved" && <Check size={13} className="text-emerald-400" />}
                  <span className="font-medium">{t.label}</span>
                  <span className="text-white/50">{formatDuration(t.durationSec * 1000)}</span>
                </button>
                <button
                  type="button"
                  disabled={busy || t.state === "saving"}
                  onClick={() => deleteTake(t)}
                  className="pr-2.5 pl-1 py-1.5 text-white/45 hover:text-white disabled:opacity-40"
                  aria-label={`Delete ${t.label}`}
                  title={`Delete ${t.label}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Controls */}
      <div
        className="flex-shrink-0 px-4 pt-3 flex flex-col items-center gap-2"
        style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
      >
        {showingTake && selected ? (
          <TakeActions
            take={selected}
            onUse={() => void saveTake(selected)}
            onRecordAgain={recordAgain}
          />
        ) : status === "countdown" ? (
          <button
            type="button"
            onClick={cancelCountdown}
            className="h-14 px-8 rounded-full bg-white/10 hover:bg-white/15 text-sm font-semibold"
          >
            Cancel
          </button>
        ) : status === "recording" || status === "paused" ? (
          <div className="flex items-center gap-5">
            <span className="w-16 text-right font-mono text-sm tabular-nums text-white/80">
              {formatDuration(duration)}
            </span>
            <button
              type="button"
              onClick={() => void stop()}
              className="w-[72px] h-[72px] rounded-full border-4 border-white/80 flex items-center justify-center"
              aria-label="Stop"
              title="Stop"
            >
              <Square size={26} className="text-red-500 fill-red-500" />
            </button>
            <button
              type="button"
              onClick={() =>
                status === "paused"
                  ? useRecorderStore.getState().resumeRecording()
                  : useRecorderStore.getState().pauseRecording()
              }
              className="w-16 h-12 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center"
              aria-label={status === "paused" ? "Resume" : "Pause"}
              title={status === "paused" ? "Resume" : "Pause"}
            >
              {status === "paused" ? <Play size={20} /> : <Pause size={20} />}
            </button>
          </div>
        ) : status === "processing" ? (
          <p className="h-[72px] flex items-center text-sm text-white/70">Finishing your take…</p>
        ) : (
          <button
            type="button"
            onClick={() => void record()}
            disabled={status === "requesting" || !ScreenRecorderService.isSupported(mode)}
            className="w-[72px] h-[72px] rounded-full border-4 border-white/80 flex items-center justify-center disabled:opacity-40"
            aria-label="Record"
            title="Record"
          >
            <Circle size={52} className="text-red-500 fill-red-500" />
          </button>
        )}
        <p className="text-xs text-white/45 h-4">
          {showingTake
            ? savedCount > 0
              ? `${savedCount} on the shot`
              : ""
            : status === "paused"
              ? "Paused"
              : status === "recording"
                ? ""
                : status === "countdown"
                  ? "Get ready…"
                  : takes.length > 0
                    ? "Record another take"
                    : "Tap to record"}
        </p>
      </div>
    </div>
  );
};

const TakeActions: React.FC<{
  take: Take;
  onUse: () => void;
  onRecordAgain: () => void;
}> = ({ take, onUse, onRecordAgain }) => (
  <div className="w-full max-w-md flex flex-col items-center gap-2">
    {take.error && <p className="text-xs text-amber-300 text-center">{take.error}</p>}
    <div className="w-full flex gap-2">
      <button
        type="button"
        onClick={onRecordAgain}
        disabled={take.state === "saving"}
        className="flex-1 h-12 rounded-full bg-white/10 hover:bg-white/15 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
      >
        <RotateCcw size={16} />
        Record again
      </button>
      {take.state === "saved" ? (
        <div className="flex-1 h-12 rounded-full bg-emerald-500/15 text-emerald-300 text-sm font-semibold flex items-center justify-center gap-2">
          <Check size={16} />
          On the shot
        </div>
      ) : (
        <button
          type="button"
          onClick={onUse}
          disabled={take.state === "saving"}
          className="flex-1 h-12 rounded-full bg-primary hover:bg-primary-hover text-white text-sm font-semibold disabled:opacity-70"
        >
          {take.state === "saving"
            ? `Saving… ${Math.round(take.progress * 100)}%`
            : take.state === "failed"
              ? "Try again"
              : "Use this take"}
        </button>
      )}
    </div>
  </div>
);

const SettingsMenu: React.FC<{
  mode: RecordingMode;
  modeOptions: { value: RecordingMode; label: string }[];
  onMode: (m: RecordingMode) => void;
  cameraId: string;
  micId: string;
  cameras: { deviceId: string; label: string }[];
  mics: { deviceId: string; label: string }[];
  onCamera: (id: string) => void;
  onMic: (id: string) => void;
  showLines: boolean;
  onShowLines: (v: boolean) => void;
  onEditLines: () => void;
  onClose: () => void;
}> = (p) => (
  <>
    {/* Tap outside to close */}
    <div className="fixed inset-0" style={{ zIndex: 2147482500 }} onClick={p.onClose} />
    <div
      className="absolute right-0 top-12 w-[min(300px,calc(100vw-32px))] rounded-2xl bg-zinc-900 border border-white/10 shadow-2xl p-4 flex flex-col gap-4 text-sm"
      style={{ zIndex: 2147483000 }}
    >
      {p.modeOptions.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-white/50">Record</span>
          <div className="grid grid-cols-2 gap-1 p-1 rounded-full bg-white/5">
            {p.modeOptions.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => p.onMode(m.value)}
                className={`h-9 rounded-full text-xs font-semibold ${
                  p.mode === m.value ? "bg-white text-black" : "text-white/70"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {p.mode === "both" && (
            <span className="text-[11px] text-white/45">
              Your camera is saved as a second clip next to the screen.
            </span>
          )}
        </div>
      )}
      <DevicePicker label="Camera" value={p.cameraId} devices={p.cameras} onChange={p.onCamera} />
      <DevicePicker label="Microphone" value={p.micId} devices={p.mics} onChange={p.onMic} />
      <div className="flex flex-col gap-2">
        <label className="flex items-center justify-between gap-3">
          <span>Show my lines</span>
          <input
            type="checkbox"
            checked={p.showLines}
            onChange={(e) => p.onShowLines(e.target.checked)}
            className="w-5 h-5 !p-0 accent-[#4A9BD9]"
          />
        </label>
        <button type="button" onClick={p.onEditLines} className="self-start text-[#7fbbe8] text-sm">
          Edit lines
        </button>
        <span className="text-[11px] text-white/45">
          Text size and speed are on the bar above your lines.
        </span>
      </div>
    </div>
  </>
);

const DevicePicker: React.FC<{
  label: string;
  value: string;
  devices: { deviceId: string; label: string }[];
  onChange: (id: string) => void;
}> = ({ label, value, devices, onChange }) => (
  <label className="flex flex-col gap-1.5">
    <span className="text-xs text-white/50">{label}</span>
    <select
      value={value || "default"}
      onChange={(e) => onChange(e.target.value === "default" ? "" : e.target.value)}
      className="w-full text-sm"
    >
      <option value="default">Default</option>
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label}
        </option>
      ))}
    </select>
  </label>
);
