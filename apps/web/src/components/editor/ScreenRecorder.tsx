import React, { useEffect, useRef } from "react";
import {
  Monitor,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Camera,
  Video,
  Headphones,
  Circle,
  Settings,
  AlertCircle,
  ScrollText,
} from "lucide-react";
import { useRecorderStore } from "../../stores/recorder-store";
import { useProjectStore } from "../../stores/project-store";
import {
  ScreenRecorderService,
  type VideoResolution,
  type FrameRate,
  type WebcamResolution,
  type RecordingMode,
} from "../../services/screen-recorder";
import { RecordingControls } from "./RecordingControls";
import { Teleprompter } from "./Teleprompter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@openreel/ui";

interface ScreenRecorderProps {
  isOpen: boolean;
  onClose: () => void;
  onRecordingComplete: (screenBlob: Blob, webcamBlob?: Blob, mode?: RecordingMode) => void;
}

const MODE_OPTIONS: { value: RecordingMode; label: string; Icon: typeof Monitor }[] = [
  { value: "screen", label: "Screen", Icon: Monitor },
  { value: "camera", label: "Webcam", Icon: Camera },
  { value: "both", label: "Both", Icon: Video },
  { value: "audio", label: "Audio", Icon: Headphones },
];

const RESOLUTION_OPTIONS: {
  value: VideoResolution;
  label: string;
  desc: string;
}[] = [
  { value: "720p", label: "720p HD", desc: "1280×720 - Smaller files" },
  { value: "1080p", label: "1080p Full HD", desc: "1920×1080 - Recommended" },
  { value: "1440p", label: "1440p QHD", desc: "2560×1440 - High quality" },
  { value: "4k", label: "4K Ultra HD", desc: "3840×2160 - Maximum quality" },
];

const FRAMERATE_OPTIONS: { value: FrameRate; label: string }[] = [
  { value: 30, label: "30 fps" },
  { value: 60, label: "60 fps" },
];

const WEBCAM_RESOLUTION_OPTIONS: { value: WebcamResolution; label: string }[] =
  [
    { value: "480p", label: "480p" },
    { value: "720p", label: "720p" },
    { value: "1080p", label: "1080p" },
  ];

export const ScreenRecorder: React.FC<ScreenRecorderProps> = ({
  isOpen,
  onClose,
  onRecordingComplete,
}) => {
  const {
    status,
    options,
    error,
    previewStream,
    audioDevices,
    videoDevices,
    setOptions,
    setVideoOption,
    setAudioOption,
    setWebcamOption,
    setMic,
    setCamera,
    startPreview,
    stopPreview,
    teleprompterEnabled,
    teleprompterScript,
    setTeleprompter,
    requestPermissions,
    startRecording,
    stopRecording,
    cancelRecording,
    pauseRecording,
    resumeRecording,
    reset,
  } = useRecorderStore();

  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const isSupported = ScreenRecorderService.isSupported();
  const features = ScreenRecorderService.getSupportedFeatures();

  // The project's aspect ratio drives webcam capture so the recorded clip
  // fills the project frame (portrait project → portrait take). Read live so
  // a mid-session aspect change is reflected on the next recording. This only
  // CONSTRAINS capture — it never writes back to the project settings.
  const projectAspect = useProjectStore(
    (s) => (s.project.settings.width || 16) / (s.project.settings.height || 9),
  );
  useEffect(() => {
    if (isOpen) setOptions({ targetAspect: projectAspect });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, projectAspect]);

  const mode: RecordingMode = options.mode ?? "screen";
  const showScreenSettings = mode === "screen" || mode === "both";
  const showWebcam = mode === "camera" || mode === "both";
  const showAudioOnly = mode === "audio";
  const micUsed =
    options.audio.microphone || mode === "camera" || mode === "both" || mode === "audio";

  // Picking a mode keeps the legacy webcam.enabled / microphone flags in sync so
  // the rest of the recorder + previews behave consistently.
  const setMode = (next: RecordingMode) => {
    setOptions({
      mode: next,
      webcam: { ...options.webcam, enabled: next === "camera" || next === "both" },
      audio: {
        ...options.audio,
        microphone: next === "camera" || next === "audio" ? true : options.audio.microphone,
      },
    });
    // Show a live preview (and reveal device names) the moment a media mode is
    // chosen; release it for screen-only.
    if (next === "camera" || next === "both" || next === "audio") {
      void startPreview(next);
    } else {
      stopPreview();
    }
  };

  useEffect(() => {
    if (webcamVideoRef.current && previewStream) {
      webcamVideoRef.current.srcObject = previewStream;
    }
  }, [previewStream]);

  // Acquire the config preview when the dialog opens on a media mode; release
  // on close / unmount. Mode-change previews are handled in setMode.
  useEffect(() => {
    if (isOpen && (mode === "camera" || mode === "both" || mode === "audio")) {
      void startPreview(mode);
    } else {
      stopPreview();
    }
    return () => stopPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      if (status === "idle" || status === "error") {
        reset();
      }
    }
  }, [isOpen, status, reset]);

  const handleStartRecording = async () => {
    // Release the preview so recording acquires fresh streams with the chosen
    // devices (permission is already granted, so re-acquire is instant).
    stopPreview();
    const hasPermissions = await requestPermissions();
    if (hasPermissions) {
      await startRecording();
    }
  };

  const handleStopRecording = async () => {
    const result = await stopRecording();
    if (result) {
      onRecordingComplete(result.screenBlob, result.webcamBlob, result.mode);
      onClose();
    }
  };

  const handleCancel = () => {
    cancelRecording();
    onClose();
  };

  if (!isOpen) return null;

  // During countdown the player shows the contained 3-2-1 (InlineRecordingPreview
  // in Preview.tsx). No fullscreen overlay — keep the editor visible behind it.
  if (status === "countdown") {
    return null;
  }

  if (status === "recording" || status === "paused") {
    // The live webcam preview + countdown are rendered INSIDE the editor's
    // player window (InlineRecordingPreview in Preview.tsx) — framed to the
    // project aspect so the user sees exactly what the take will look like on
    // the timeline. No fullscreen overlay. Here we only float the teleprompter
    // (draggable, speech-tracked) + the top-center controls.
    return (
      <>
        {teleprompterEnabled && teleprompterScript.trim() && (
          <Teleprompter
            script={teleprompterScript}
            active={status === "recording"}
            onClose={() => setTeleprompter({ enabled: false })}
          />
        )}
        <RecordingControls
          onStop={handleStopRecording}
          onPause={pauseRecording}
          onResume={resumeRecording}
          onCancel={handleCancel}
        />
      </>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="max-w-2xl p-0 gap-0 bg-background-secondary border-border overflow-hidden flex flex-col max-h-[90vh]">
        <DialogHeader className="p-4 border-b border-border bg-background-tertiary space-y-0 flex-shrink-0">
          <div className="flex items-center gap-3">
            <Circle size={20} className="text-error fill-error animate-pulse" />
            <DialogTitle className="text-lg font-bold text-text-primary">
              Record
            </DialogTitle>
          </div>
        </DialogHeader>

        {/* Scrollable body — the dialog can be taller than the viewport
            (webcam mode shows mode + audio + camera + preview + teleprompter);
            without this the fixed-centered Radix content overflows top AND
            bottom and the footer's Start Recording button is unreachable. */}
        <div className="p-6 space-y-6 flex-1 overflow-y-auto min-h-0">
          {!isSupported && (
            <div className="flex items-start gap-3 p-4 bg-error/10 border border-error/30 rounded-lg">
              <AlertCircle
                size={20}
                className="text-error flex-shrink-0 mt-0.5"
              />
              <div>
                <p className="text-sm font-medium text-error">
                  Screen recording not supported
                </p>
                <p className="text-xs text-text-muted mt-1">
                  Your browser doesn't support screen recording. Please use
                  Chrome, Edge, or Firefox.
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-3 p-4 bg-error/10 border border-error/30 rounded-lg">
              <AlertCircle
                size={20}
                className="text-error flex-shrink-0 mt-0.5"
              />
              <div>
                <p className="text-sm font-medium text-error">
                  Recording Error
                </p>
                <p className="text-xs text-text-muted mt-1">{error}</p>
              </div>
            </div>
          )}

          {/* What to record — screen / webcam / both / audio */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Circle size={14} className="text-error fill-error" />
              <span>What to record</span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {MODE_OPTIONS.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  onClick={() => setMode(value)}
                  className={`flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg border transition-all ${
                    mode === value
                      ? "bg-primary/10 border-primary text-primary"
                      : "bg-background-tertiary border-border text-text-secondary hover:border-text-muted"
                  }`}
                >
                  <Icon size={18} />
                  <span className="text-xs font-medium">{label}</span>
                </button>
              ))}
            </div>
            {showAudioOnly && (
              <p className="text-[10px] text-text-muted">
                Audio-only — records your microphone as a voiceover track. No video, no screen prompt.
              </p>
            )}
          </div>

          {showScreenSettings && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Monitor size={16} />
              <span>Video Settings</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-text-muted mb-2">
                  Resolution
                </label>
                <Select
                  value={options.video.resolution}
                  onValueChange={(v) => setVideoOption("resolution", v as VideoResolution)}
                  disabled={!isSupported}
                >
                  <SelectTrigger className="w-full bg-background-tertiary border-border text-text-primary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-background-secondary border-border">
                    {RESOLUTION_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-text-muted mt-1">
                  {
                    RESOLUTION_OPTIONS.find(
                      (o) => o.value === options.video.resolution,
                    )?.desc
                  }
                </p>
              </div>

              <div>
                <label className="block text-xs text-text-muted mb-2">
                  Frame Rate
                </label>
                <Select
                  value={String(options.video.frameRate)}
                  onValueChange={(v) => setVideoOption("frameRate", parseInt(v) as FrameRate)}
                  disabled={!isSupported}
                >
                  <SelectTrigger className="w-full bg-background-tertiary border-border text-text-primary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-background-secondary border-border">
                    {FRAMERATE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={String(opt.value)}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          )}

          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Settings size={16} />
              <span>Audio Settings</span>
            </div>

            <div className="flex gap-4">
              {showScreenSettings && (
              <button
                onClick={() =>
                  setAudioOption("systemAudio", !options.audio.systemAudio)
                }
                disabled={!isSupported || !features.systemAudio}
                className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border transition-all ${
                  options.audio.systemAudio
                    ? "bg-primary/10 border-primary text-primary"
                    : "bg-background-tertiary border-border text-text-secondary hover:border-text-muted"
                } ${(!isSupported || !features.systemAudio) && "opacity-50 cursor-not-allowed"}`}
              >
                {options.audio.systemAudio ? (
                  <Volume2 size={18} />
                ) : (
                  <VolumeX size={18} />
                )}
                <span className="text-sm">System Audio</span>
              </button>
              )}

              <button
                onClick={() =>
                  setAudioOption("microphone", !options.audio.microphone)
                }
                disabled={!isSupported}
                className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border transition-all ${
                  options.audio.microphone
                    ? "bg-primary/10 border-primary text-primary"
                    : "bg-background-tertiary border-border text-text-secondary hover:border-text-muted"
                } ${!isSupported && "opacity-50 cursor-not-allowed"}`}
              >
                {options.audio.microphone ? (
                  <Mic size={18} />
                ) : (
                  <MicOff size={18} />
                )}
                <span className="text-sm">Microphone</span>
              </button>
            </div>

            {micUsed && audioDevices.length > 0 && (
              <div>
                <label className="block text-xs text-text-muted mb-2">
                  Microphone device
                </label>
                <Select
                  value={options.audioDeviceId || "default"}
                  onValueChange={(v) => setMic(v === "default" ? "" : v)}
                >
                  <SelectTrigger className="w-full bg-background-tertiary border-border text-text-primary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-background-secondary border-border">
                    <SelectItem value="default">System default</SelectItem>
                    {audioDevices.map((d) => (
                      <SelectItem key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {!features.systemAudio && (
              <p className="text-[10px] text-text-muted">
                System audio capture is only available in Chrome and Edge
                browsers.
              </p>
            )}
          </div>

          {showWebcam && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Camera size={16} />
              <span>Webcam{mode === "both" ? " (separate file)" : ""}</span>
            </div>

            {videoDevices.length > 0 && (
              <div>
                <label className="block text-xs text-text-muted mb-2">Camera</label>
                <Select
                  value={options.videoDeviceId || "default"}
                  onValueChange={(v) => setCamera(v === "default" ? "" : v)}
                >
                  <SelectTrigger className="w-full bg-background-tertiary border-border text-text-primary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-background-secondary border-border">
                    <SelectItem value="default">System default</SelectItem>
                    {videoDevices.map((d) => (
                      <SelectItem key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex gap-4 items-end">
              <div className="flex-1">
                <label className="block text-xs text-text-muted mb-2">
                  Webcam Resolution
                </label>
                <Select
                  value={options.webcam.resolution}
                  onValueChange={(v) => setWebcamOption("resolution", v as WebcamResolution)}
                >
                  <SelectTrigger className="w-full bg-background-tertiary border-border text-text-primary">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-background-secondary border-border">
                    {WEBCAM_RESOLUTION_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="w-40 h-28 bg-background-tertiary rounded-lg overflow-hidden border border-border flex items-center justify-center">
                {previewStream ? (
                  <video
                    ref={webcamVideoRef}
                    autoPlay
                    muted
                    playsInline
                    className="w-full h-full object-cover"
                    style={{ transform: "scaleX(-1)" }}
                  />
                ) : (
                  <span className="text-[10px] text-text-muted px-2 text-center">
                    Camera preview
                  </span>
                )}
              </div>
            </div>

            <p className="text-[10px] text-text-muted">
              {mode === "both"
                ? "Your webcam is saved as a separate file alongside the screen recording, giving you full control in the editor."
                : "Records your webcam (and mic) as a talking-head clip — no screen-share prompt."}
            </p>
          </div>
          )}

          {showWebcam && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <ScrollText size={16} />
                  <span>Teleprompter</span>
                </div>
                <button
                  type="button"
                  onClick={() => setTeleprompter({ enabled: !teleprompterEnabled })}
                  className={`relative w-12 h-6 rounded-full transition-colors ${
                    teleprompterEnabled ? "bg-primary" : "bg-background-tertiary"
                  }`}
                >
                  <div
                    className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${
                      teleprompterEnabled ? "translate-x-7" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
              {teleprompterEnabled && (
                <textarea
                  value={teleprompterScript}
                  onChange={(e) => setTeleprompter({ script: e.target.value })}
                  placeholder="Paste or write your script here…"
                  rows={4}
                  className="w-full bg-background-tertiary border border-border rounded-lg p-3 text-sm text-text-primary placeholder:text-text-muted resize-y focus:outline-none focus:border-primary"
                />
              )}
              <p className="text-[10px] text-text-muted">
                Projects on screen while you record and auto-scrolls to your
                speech. Drag it near your camera; adjust text size live.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between p-4 border-t border-border bg-background-tertiary flex-shrink-0">
          <p className="text-xs text-text-muted">
            Recording will start after a 3-second countdown
          </p>

          <div className="flex gap-3">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleStartRecording}
              disabled={!isSupported || status === "requesting"}
              className="flex items-center gap-2 px-6 py-2 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status === "requesting" ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Requesting Access...</span>
                </>
              ) : (
                <>
                  <Circle size={14} className="fill-current" />
                  <span>Start Recording</span>
                </>
              )}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
