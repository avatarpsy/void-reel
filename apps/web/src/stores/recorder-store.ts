import { create } from "zustand";
import {
  screenRecorderService,
  ScreenRecorderService,
  DEFAULT_RECORDING_OPTIONS,
  acquireHealthyWebcam,
  type RecordingOptions,
  type RecordingStatus,
  type RecordingResult,
  type RecordingMode,
  type MediaDeviceOption,
} from "../services/screen-recorder";

interface RecorderState {
  status: RecordingStatus;
  duration: number;
  error: string | null;
  options: RecordingOptions;
  screenStream: MediaStream | null;
  webcamStream: MediaStream | null;
  result: RecordingResult | null;
  isModalOpen: boolean;
  isControlsMinimized: boolean;
  /** Optional teleprompter: the user's script + whether it's projected while recording. */
  teleprompterEnabled: boolean;
  teleprompterScript: string;
  /** Device pickers: a live config preview + the available mics/cameras. */
  previewStream: MediaStream | null;
  audioDevices: MediaDeviceOption[];
  videoDevices: MediaDeviceOption[];

  setOptions: (options: Partial<RecordingOptions>) => void;
  setTeleprompter: (patch: { enabled?: boolean; script?: string }) => void;
  setMic: (deviceId: string) => void;
  setCamera: (deviceId: string) => void;
  /** Acquire a live config preview for the mode (unlocks device labels). */
  startPreview: (mode: RecordingMode) => Promise<void>;
  stopPreview: () => void;
  setVideoOption: <K extends keyof RecordingOptions["video"]>(
    key: K,
    value: RecordingOptions["video"][K],
  ) => void;
  setAudioOption: <K extends keyof RecordingOptions["audio"]>(
    key: K,
    value: RecordingOptions["audio"][K],
  ) => void;
  setWebcamOption: <K extends keyof RecordingOptions["webcam"]>(
    key: K,
    value: RecordingOptions["webcam"][K],
  ) => void;

  requestPermissions: () => Promise<boolean>;
  startRecording: () => Promise<void>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  stopRecording: () => Promise<RecordingResult | null>;
  cancelRecording: () => void;
  reset: () => void;

  openModal: () => void;
  closeModal: () => void;
  minimizeControls: () => void;
  expandControls: () => void;
}

export const useRecorderStore = create<RecorderState>((set, get) => {
  screenRecorderService.on("duration", (duration) => {
    set({ duration: duration as number });
  });

  screenRecorderService.on("stop", () => {
    set({ status: "processing" });
  });

  screenRecorderService.on("error", (error) => {
    const errorMessage =
      error instanceof Error ? error.message : "Recording error occurred";
    set({ status: "error", error: errorMessage });
  });

  return {
    status: "idle",
    duration: 0,
    error: null,
    options: DEFAULT_RECORDING_OPTIONS,
    screenStream: null,
    webcamStream: null,
    result: null,
    isModalOpen: false,
    isControlsMinimized: false,
    teleprompterEnabled: false,
    teleprompterScript: "",
    previewStream: null,
    audioDevices: [],
    videoDevices: [],

    setTeleprompter: (patch) =>
      set((state) => ({
        teleprompterEnabled: patch.enabled ?? state.teleprompterEnabled,
        teleprompterScript: patch.script ?? state.teleprompterScript,
      })),

    setMic: (deviceId) => {
      set((s) => ({ options: { ...s.options, audioDeviceId: deviceId } }));
      const mode = get().options.mode ?? "screen";
      // Re-acquire the preview with the newly chosen mic so it takes effect live.
      if (get().previewStream || mode === "camera" || mode === "both" || mode === "audio") {
        void get().startPreview(mode);
      }
    },
    setCamera: (deviceId) => {
      set((s) => ({ options: { ...s.options, videoDeviceId: deviceId } }));
      const mode = get().options.mode ?? "screen";
      if (mode === "camera" || mode === "both") void get().startPreview(mode);
    },

    startPreview: async (mode) => {
      const { options } = get();
      get().stopPreview();
      const wantsVideo = mode === "camera" || mode === "both";
      const wantsAudio =
        options.audio.microphone || mode === "camera" || mode === "both" || mode === "audio";
      if (!wantsVideo && !wantsAudio) return;
      try {
        // The preview must go through the SAME measured selection as the real
        // capture (acquireHealthyWebcam), or it stops predicting the take — and
        // worse, a preview stuck on a 0.7 fps mode is exactly what "the video
        // was extremely laggy while recording" looked like. The picture on
        // screen was the problem, not the encoder.
        let stream: MediaStream;
        if (wantsVideo) {
          const picked = await acquireHealthyWebcam(options);
          if (!picked) throw new Error("Could not open the camera");
          stream = picked.stream;
          if (wantsAudio) {
            // Video came from the measured pass; add the mic alongside it.
            const mic = await navigator.mediaDevices.getUserMedia({
              audio: options.audioDeviceId ? { deviceId: { exact: options.audioDeviceId } } : true,
            });
            mic.getAudioTracks().forEach((t) => stream.addTrack(t));
          }
        } else {
          stream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: options.audioDeviceId ? { deviceId: { exact: options.audioDeviceId } } : true,
          });
        }
        set({ previewStream: stream, error: null });
        // Labels are only available once permission is granted — refresh now.
        const { mics, cameras } = await ScreenRecorderService.listMediaDevices();
        set({ audioDevices: mics, videoDevices: cameras });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not access the selected device";
        set({ previewStream: null, error: message });
      }
    },
    stopPreview: () => {
      const { previewStream } = get();
      previewStream?.getTracks().forEach((t) => t.stop());
      set({ previewStream: null });
    },

    setOptions: (newOptions) => {
      set((state) => ({
        options: {
          ...state.options,
          ...newOptions,
          video: { ...state.options.video, ...newOptions.video },
          audio: { ...state.options.audio, ...newOptions.audio },
          webcam: { ...state.options.webcam, ...newOptions.webcam },
        },
      }));
    },

    setVideoOption: (key, value) => {
      set((state) => ({
        options: {
          ...state.options,
          video: { ...state.options.video, [key]: value },
        },
      }));
    },

    setAudioOption: (key, value) => {
      set((state) => ({
        options: {
          ...state.options,
          audio: { ...state.options.audio, [key]: value },
        },
      }));
    },

    setWebcamOption: (key, value) => {
      set((state) => ({
        options: {
          ...state.options,
          webcam: { ...state.options.webcam, [key]: value },
        },
      }));
    },

    requestPermissions: async () => {
      const { options } = get();
      set({ status: "requesting", error: null });

      try {
        const streams = await screenRecorderService.requestPermissions(options);
        set({
          screenStream: streams.screenStream,
          webcamStream: streams.webcamStream || null,
          status: "idle",
        });
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Permission denied";
        set({ status: "error", error: message });
        return false;
      }
    },

    startRecording: async () => {
      const { options, screenStream } = get();

      if (!screenStream) {
        set({ status: "error", error: "No screen stream available" });
        return;
      }

      set({ status: "countdown" });

      await new Promise((resolve) => setTimeout(resolve, 3000));

      try {
        await screenRecorderService.startRecording(options);
        set({ status: "recording", duration: 0 });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to start recording";
        set({ status: "error", error: message });
      }
    },

    pauseRecording: () => {
      screenRecorderService.pauseRecording();
      set({ status: "paused" });
    },

    resumeRecording: () => {
      screenRecorderService.resumeRecording();
      set({ status: "recording" });
    },

    stopRecording: async () => {
      set({ status: "processing" });

      try {
        const result = await screenRecorderService.stopRecording();
        set({ result, status: "idle" });
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to stop recording";
        set({ status: "error", error: message });
        return null;
      }
    },

    cancelRecording: () => {
      screenRecorderService.cancelRecording();
      get().stopPreview();
      set({
        status: "idle",
        duration: 0,
        screenStream: null,
        webcamStream: null,
        result: null,
      });
    },

    reset: () => {
      screenRecorderService.cancelRecording();
      get().stopPreview();
      set({
        status: "idle",
        duration: 0,
        error: null,
        screenStream: null,
        webcamStream: null,
        result: null,
        isModalOpen: false,
        isControlsMinimized: false,
      });
    },

    openModal: () => {
      set({ isModalOpen: true });
    },

    closeModal: () => {
      const { status } = get();
      if (status === "idle" || status === "error") {
        set({ isModalOpen: false, error: null });
      }
    },

    minimizeControls: () => {
      set({ isControlsMinimized: true });
    },

    expandControls: () => {
      set({ isControlsMinimized: false });
    },
  };
});
