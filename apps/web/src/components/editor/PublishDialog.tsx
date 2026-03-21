/**
 * PublishDialog — Full-screen publish flow shown after video export is complete.
 *
 * Flow:
 *   1. Video rendered to blob (by Toolbar export-to-blob)
 *   2. User previews the full video in this dialog
 *   3. User selects platforms, writes caption, optionally picks schedule time
 *   4. Upload to Firebase Storage → create draft → approve/schedule
 *
 * Mirrors Flutter's PublishPlatformDialog + scheduling flow.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Button,
  Switch,
  Progress,
} from "@openreel/ui";
import {
  Upload,
  Send,
  Calendar,
  Clock,
  Check,
  Loader2,
  AlertCircle,
  Sparkles,
  Globe,
  Play,
  Download,
} from "lucide-react";
import {
  FaTiktok,
  FaInstagram,
  FaYoutube,
  FaFacebook,
  FaXTwitter,
  FaThreads,
  FaLinkedin,
  FaPinterestP,
  FaRedditAlien,
} from "react-icons/fa6";
import type { IconType } from "react-icons";
import { useVoidspaceStore, SOCIAL_PLATFORMS } from "../../stores/voidspace-store";
import {
  uploadRenderedVideo,
  createSocialDraft,
  publishDraft,
  publishToVoidspaceNative,
  scheduleDraft,
  getOptimalTimes,
  type ScheduleSlot,
} from "../../services/voidspace-publish";
import { toast } from "../../stores/notification-store";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PublishMode = "publish" | "schedule";
type PublishStep = "preview" | "configure" | "uploading" | "submitting" | "done" | "error";

interface PublishDialogProps {
  isOpen: boolean;
  onClose: () => void;
  videoBlob: Blob | null;
  videoFilename: string;
  /** Project width for aspect ratio calculation */
  projectWidth?: number;
  /** Project height for aspect ratio calculation */
  projectHeight?: number;
  /** Allow downloading the rendered video even from publish dialog */
  onDownload?: () => void;
}

// ---------------------------------------------------------------------------
// Platform icon helper (inline SVG for well-known platforms)
// ---------------------------------------------------------------------------

const PLATFORM_ICON_MAP: Record<string, { Icon: IconType; color: string }> = {
  tiktok: { Icon: FaTiktok, color: "#ffffff" },
  instagram: { Icon: FaInstagram, color: "#E4405F" },
  youtube: { Icon: FaYoutube, color: "#FF0000" },
  facebook: { Icon: FaFacebook, color: "#1877F2" },
  x: { Icon: FaXTwitter, color: "#ffffff" },
  threads: { Icon: FaThreads, color: "#ffffff" },
  linkedin: { Icon: FaLinkedin, color: "#0A66C2" },
  pinterest: { Icon: FaPinterestP, color: "#BD081C" },
  reddit: { Icon: FaRedditAlien, color: "#FF4500" },
};

const PlatformIcon: React.FC<{ platform: string; socialImage?: string; size?: number }> = ({
  platform,
  socialImage,
  size = 20,
}) => {
  if (socialImage) {
    return (
      <img
        src={socialImage}
        alt=""
        className="rounded-sm object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  if (platform === "voidspace") {
    return (
      <img
        src="/studio/images/logo.png"
        alt=""
        className="rounded-sm object-contain"
        style={{ width: size, height: size }}
      />
    );
  }

  const mapped = PLATFORM_ICON_MAP[platform];
  if (!mapped) {
    return <Globe size={size} className="text-text-muted" />;
  }

  return <mapped.Icon size={size} color={mapped.color} aria-hidden />;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PublishDialog: React.FC<PublishDialogProps> = ({
  isOpen,
  onClose,
  videoBlob,
  videoFilename,
  projectWidth = 1920,
  projectHeight = 1080,
  onDownload,
}) => {
  // Voidspace context
  const { userId, avatar, sceneList, platformsLoaded, loadingPlatforms, fetchConnectedPlatforms } = useVoidspaceStore();

  // Steps
  const [step, setStep] = useState<PublishStep>("preview");
  const [mode, setMode] = useState<PublishMode>("publish");

  // Platform selection
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set(["voidspace"]));

  // Caption
  const [caption, setCaption] = useState("");

  // Schedule
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [optimalSlots, setOptimalSlots] = useState<ScheduleSlot[]>([]);
  const [loadingOptimal, setLoadingOptimal] = useState(false);

  // Upload / submit progress
  const [uploadProgress, setUploadProgress] = useState(0);
  const uploadedVideoUrlRef = useRef<string | null>(null);
  const draftIdRef = useRef<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  // Video preview
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoBlobUrl, setVideoBlobUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [manualVideoBlob, setManualVideoBlob] = useState<Blob | null>(null);
  const [manualVideoFilename, setManualVideoFilename] = useState<string>("");
  const [captionTouched, setCaptionTouched] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resolvedVideoBlob = manualVideoBlob || videoBlob;
  const resolvedVideoFilename = manualVideoFilename || videoFilename;
  const previewThumbnailUrl = sceneList?.thumbnailUrl || null;
  const initialCaption = useMemo(
    () => (sceneList?.caption || sceneList?.name || "").trim(),
    [sceneList?.caption, sceneList?.name],
  );

  // ---------------------------------------------------------------------------
  // Available platforms: Voidspace (always) + connected external
  // ---------------------------------------------------------------------------

  const availablePlatforms = useMemo(() => {
    const connected = avatar?.connectedPlatforms?.map((p) => p.platformId) ?? [];
    return SOCIAL_PLATFORMS.filter(
      (p) => ("alwaysAvailable" in p && p.alwaysAvailable) || connected.includes(p.id),
    );
  }, [avatar]);

  /** Map platform ID → account details for quick lookup */
  const platformDetails = useMemo(() => {
    const map = new Map<string, { username?: string; displayName?: string; status?: string; socialImage?: string }>();
    for (const p of avatar?.connectedPlatforms ?? []) {
      map.set(p.platformId, {
        username: p.username,
        displayName: p.displayName,
        status: p.status,
        socialImage: p.socialImage,
      });
    }
    return map;
  }, [avatar]);

  const hasExternalPlatforms = useMemo(
    () => availablePlatforms.some((p) => !("alwaysAvailable" in p)),
    [availablePlatforms],
  );

  // ---------------------------------------------------------------------------
  // Init / reset
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (isOpen) {
      setStep("preview");
      setMode("publish");
      setSelectedPlatforms(new Set(["voidspace"]));
      setCaption(initialCaption);
      setCaptionTouched(false);
      setScheduleDate("");
      setScheduleTime("");
      setOptimalSlots([]);
      setUploadProgress(0);
      setManualVideoBlob(null);
      setManualVideoFilename("");
      uploadedVideoUrlRef.current = null;
      draftIdRef.current = null;
      setErrorMessage(null);
      setResultMessage(null);

      // Create blob URL for preview (from rendered blob or scene list video URL)
      if (resolvedVideoBlob) {
        const url = URL.createObjectURL(resolvedVideoBlob);
        setVideoBlobUrl(url);
        return () => URL.revokeObjectURL(url);
      } else if (sceneList?.videoUrl) {
        setVideoBlobUrl(sceneList.videoUrl);
      }
    } else {
      if (videoBlobUrl && resolvedVideoBlob) {
        // Only revoke if it's a blob URL we created
        URL.revokeObjectURL(videoBlobUrl);
      }
      setVideoBlobUrl(null);
    }
  }, [isOpen, resolvedVideoBlob, sceneList?.videoUrl, initialCaption]);

  useEffect(() => {
    if (!isOpen || captionTouched) {
      return;
    }
    if (initialCaption.length > 0) {
      setCaption(initialCaption);
    }
  }, [isOpen, captionTouched, initialCaption]);

  const handleSelectRenderedVideo = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      setManualVideoBlob(file);
      setManualVideoFilename(file.name);
      if (event.target) {
        event.target.value = "";
      }
    },
    [],
  );

  // Fetch platforms on open if needed
  useEffect(() => {
    if (isOpen && !platformsLoaded && userId) {
      fetchConnectedPlatforms();
    }
  }, [isOpen, platformsLoaded, userId, fetchConnectedPlatforms]);

  // ---------------------------------------------------------------------------
  // Platform toggle
  // ---------------------------------------------------------------------------

  const togglePlatform = useCallback((platformId: string) => {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (platformId === "voidspace") {
        // Voidspace always stays selected
        return next;
      }
      if (next.has(platformId)) {
        next.delete(platformId);
      } else {
        next.add(platformId);
      }
      return next;
    });
  }, []);

  const selectAllPlatforms = useCallback(() => {
    setSelectedPlatforms(new Set(availablePlatforms.map((p) => p.id)));
  }, [availablePlatforms]);

  // ---------------------------------------------------------------------------
  // Fetch optimal times
  // ---------------------------------------------------------------------------

  const fetchOptimalTimes = useCallback(async () => {
    if (!userId) return;
    setLoadingOptimal(true);
    try {
      const platforms = Array.from(selectedPlatforms).filter((p) => p !== "voidspace");
      if (platforms.length === 0) platforms.push("voidspace");
      const result = await getOptimalTimes({
        userId,
        platforms,
        avatarId: sceneList?.avatarId || avatar?.avatarId,
        count: 5,
      });
      setOptimalSlots(result.recommended_slots ?? []);
    } catch (err) {
      console.warn("[PublishDialog] Failed to fetch optimal times:", err);
    } finally {
      setLoadingOptimal(false);
    }
  }, [userId, selectedPlatforms]);

  useEffect(() => {
    if (mode === "schedule" && step === "configure" && optimalSlots.length === 0 && !loadingOptimal) {
      fetchOptimalTimes();
    }
  }, [mode, step, optimalSlots.length, loadingOptimal, fetchOptimalTimes]);

  // ---------------------------------------------------------------------------
  // Apply optimal slot
  // ---------------------------------------------------------------------------

  const applyOptimalSlot = useCallback((slot: ScheduleSlot) => {
    const dt = new Date(slot.publishAtUtc);
    setScheduleDate(dt.toISOString().slice(0, 10));
    setScheduleTime(dt.toISOString().slice(11, 16));
  }, []);

  // ---------------------------------------------------------------------------
  // Handle publish / schedule
  // ---------------------------------------------------------------------------

  const handleSubmit = useCallback(async () => {
    if (!userId) return;
    // Need either a rendered blob or an existing scene list video URL
    if (!resolvedVideoBlob && !sceneList?.videoUrl) {
      toast.error("No video", "Please render your video first using the Render button.");
      return;
    }

    const platforms = Array.from(selectedPlatforms);
    if (platforms.length === 0) {
      toast.error("Select platforms", "Please select at least one platform to publish to.");
      return;
    }

    if (mode === "schedule" && (!scheduleDate || !scheduleTime)) {
      toast.error("Schedule required", "Please select a date and time for scheduling.");
      return;
    }

    try {
      let videoUrl: string;

      if (resolvedVideoBlob) {
        // ── Upload rendered blob to Firebase Storage ──
        setStep("uploading");
        setUploadProgress(10);

        const result = await uploadRenderedVideo(userId, resolvedVideoBlob, resolvedVideoFilename);
        videoUrl = result.videoUrl;
        setUploadProgress(60);
      } else {
        // ── Use existing scene list video URL (no upload needed) ──
        videoUrl = sceneList!.videoUrl!;
        setUploadProgress(60);
      }

      uploadedVideoUrlRef.current = videoUrl;

      setStep("submitting");
      setUploadProgress(70);

      const effectiveCaption = caption.trim() || initialCaption || resolvedVideoFilename;
      const avatarId = sceneList?.avatarId || avatar?.avatarId || "";
      const avatarName = sceneList?.avatarName || avatar?.avatarName || "Studio";

      const scheduledTime = mode === "schedule" && scheduleDate && scheduleTime
        ? new Date(`${scheduleDate}T${scheduleTime}:00Z`).toISOString()
        : undefined;

      const includesVoidspace = platforms.includes("voidspace");
      const externalPlatforms = platforms.filter((p) => p !== "voidspace");

      if (mode === "schedule") {
        // ── Schedule flow (external scheduler path) ──
        const newDraftId = `studio-${uuidv4()}`;
        draftIdRef.current = newDraftId;

        await createSocialDraft({
          userId,
          draftId: newDraftId,
          avatarId,
          avatarName,
          platforms,
          videoUrl,
          thumbnailUrl: previewThumbnailUrl || undefined,
          caption: effectiveCaption,
          uploadPostProfile: avatar?.uploadPostProfile || "",
          scheduledTime,
        });

        setUploadProgress(85);

        // Step 1: Approve as "schedule" — sets status to approved_scheduled
        const result = await publishDraft({
          userId,
          draftId: newDraftId,
          platforms,
          caption: effectiveCaption,
          decision: "schedule",
        });
        // Step 2: If user chose a specific time, override the auto-computed time
        if (scheduledTime) {
          await scheduleDraft({
            userId,
            draftId: newDraftId,
            publishAtUtc: scheduledTime,
          });
        }
        setResultMessage(
          scheduledTime
            ? `Video scheduled for ${new Date(scheduledTime).toLocaleString()}`
            : (result.message || "Video scheduled for optimal time!"),
        );
      } else {
        // ── Publish-now flow (Flutter parity): Voidspace native path + external path ──
        const messages: string[] = [];

        if (includesVoidspace) {
          await publishToVoidspaceNative({
            userId,
            avatarId,
            avatarName,
            caption: effectiveCaption,
            videoUrl,
            thumbnailUrl: previewThumbnailUrl || undefined,
          });
          messages.push("Published to Voidspace");
        }

        if (externalPlatforms.length > 0) {
          const newDraftId = `studio-${uuidv4()}`;
          draftIdRef.current = newDraftId;

          await createSocialDraft({
            userId,
            draftId: newDraftId,
            avatarId,
            avatarName,
            platforms: externalPlatforms,
            videoUrl,
            thumbnailUrl: previewThumbnailUrl || undefined,
            caption: effectiveCaption,
            uploadPostProfile: avatar?.uploadPostProfile || "",
          });

          setUploadProgress(85);

          const result = await publishDraft({
            userId,
            draftId: newDraftId,
            platforms: externalPlatforms,
            caption: effectiveCaption,
          });
          messages.push(result.message || `Published to ${externalPlatforms.join(", ")}`);
        }

        setResultMessage(messages.join(". ") || "Video published successfully!");
      }

      setUploadProgress(100);
      setStep("done");
      toast.success(
        mode === "schedule" ? "Scheduled!" : "Published!",
        mode === "schedule"
          ? "Your video has been scheduled for posting."
          : "Your video is being published to selected platforms.",
      );
    } catch (err) {
      console.error("[PublishDialog] Submit error:", err);
      setErrorMessage(err instanceof Error ? err.message : "An error occurred");
      setStep("error");
      toast.error("Publish failed", err instanceof Error ? err.message : "Unknown error");
    }
  }, [resolvedVideoBlob, userId, avatar, sceneList, selectedPlatforms, caption, initialCaption, resolvedVideoFilename, mode, scheduleDate, scheduleTime, previewThumbnailUrl]);

  // ---------------------------------------------------------------------------
  // Video preview play/pause
  // ---------------------------------------------------------------------------

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play();
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!isOpen) return null;

  const isWorking = step === "uploading" || step === "submitting";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isWorking && onClose()}>
      <DialogContent
        className="max-w-4xl w-[95vw] max-h-[90vh] overflow-y-auto bg-background-secondary border-border"
        hideCloseButton={isWorking}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-text-primary">
            <Send size={18} className="text-primary" />
            {step === "done"
              ? "Published!"
              : step === "error"
                ? "Error"
                : "Publish Video"}
          </DialogTitle>
          <DialogDescription className="text-text-muted">
            {step === "preview" && "Review your video and publish to platforms"}
            {step === "configure" && "Choose platforms and posting options"}
            {step === "uploading" && "Uploading your video..."}
            {step === "submitting" && "Submitting to platforms..."}
            {step === "done" && (resultMessage || "Your video has been submitted!")}
            {step === "error" && (errorMessage || "Something went wrong")}
          </DialogDescription>
        </DialogHeader>

        {/* ── STEP: PREVIEW ── */}
        {step === "preview" && (
          <div className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime,video/*"
              onChange={handleSelectRenderedVideo}
              className="hidden"
            />
            {/* Video player */}
            <div
              className="relative bg-black rounded-xl overflow-hidden max-h-[50vh]"
              style={{ aspectRatio: `${projectWidth} / ${projectHeight}` }}
            >
              {videoBlobUrl ? (
                <>
                  <video
                    ref={videoRef}
                    src={videoBlobUrl}
                    crossOrigin="anonymous"
                    className="w-full h-full object-contain"
                    controls
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                  />
                  {!isPlaying && (
                    <button
                      onClick={togglePlay}
                      className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors"
                    >
                      <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center shadow-xl">
                        <Play size={28} className="text-white ml-1" />
                      </div>
                    </button>
                  )}
                </>
              ) : previewThumbnailUrl ? (
                <img
                  src={previewThumbnailUrl}
                  alt="Video thumbnail"
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-48 text-text-muted gap-2">
                  <p>No video preview available</p>
                  <p className="text-xs">Use the Render button to create a video first, or publish the existing video</p>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex justify-between items-center gap-3">
              <div className="flex gap-2">
                {onDownload && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onDownload}
                    className="gap-2"
                  >
                    <Download size={14} />
                    Download
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="gap-2"
                >
                  <Upload size={14} />
                  Choose Rendered Video
                </Button>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  onClick={() => setStep("configure")}
                  className="gap-2 bg-primary hover:bg-primary-hover text-white"
                >
                  Continue to Publish
                  <Send size={14} />
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP: CONFIGURE ── */}
        {step === "configure" && (
          <div className="space-y-5">
            {/* Compact video thumbnail */}
            <div className="flex items-start gap-4">
              <div className="w-32 h-20 bg-black rounded-lg overflow-hidden flex-shrink-0">
                {videoBlobUrl && (
                  <video src={videoBlobUrl} crossOrigin="anonymous" className="w-full h-full object-cover" muted />
                )}
                {!videoBlobUrl && previewThumbnailUrl && (
                  <img src={previewThumbnailUrl} alt="Video thumbnail" className="w-full h-full object-cover" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">
                  {resolvedVideoFilename}
                </p>
                <p className="text-xs text-text-muted mt-1">
                  {resolvedVideoBlob
                    ? `${(resolvedVideoBlob.size / (1024 * 1024)).toFixed(1)} MB`
                    : sceneList?.videoUrl
                      ? "Using existing video"
                      : "No video"}
                </p>
              </div>
            </div>

            {/* Platform selection */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-text-primary flex items-center gap-2">
                  <Globe size={14} className="text-primary" />
                  Publish To
                </label>
                {hasExternalPlatforms && (
                  <button
                    onClick={selectAllPlatforms}
                    className="text-xs text-primary hover:text-primary-hover"
                  >
                    Select All
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {availablePlatforms.map((platform) => {
                  const isSelected = selectedPlatforms.has(platform.id);
                  const isVoidspace = platform.id === "voidspace";
                  const detail = platformDetails.get(platform.id);
                  const accountLabel =
                    detail?.username || detail?.displayName || null;
                  const isActive = !detail?.status || detail.status === "active";
                  return (
                    <button
                      key={platform.id}
                      onClick={() => togglePlatform(platform.id)}
                      disabled={!isVoidspace && !isActive}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-all text-left ${
                        isSelected
                          ? "border-primary bg-primary/10 text-text-primary"
                          : "border-border bg-background-tertiary text-text-muted hover:border-border-hover"
                      } ${isVoidspace ? "opacity-90" : ""} ${!isVoidspace && !isActive ? "opacity-50 cursor-not-allowed" : ""}`}
                    >
                      <PlatformIcon platform={platform.id} socialImage={detail?.socialImage} size={18} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {platform.name}
                        </div>
                        {isVoidspace && (
                          <div className="text-[10px] text-primary">Always included</div>
                        )}
                        {!isVoidspace && accountLabel && (
                          <div className="text-[10px] text-text-muted truncate">
                            {accountLabel}
                          </div>
                        )}
                        {!isVoidspace && !isActive && detail?.status && (
                          <div className="text-[10px] text-amber-400 truncate">
                            {detail.status === "manual_login_required"
                              ? "Needs re-login"
                              : detail.status.replace(/_/g, " ")}
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <Check size={14} className="text-primary flex-shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>

              {loadingPlatforms && (
                <p className="text-xs text-text-muted mt-2 flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" />
                  Loading connected accounts…
                </p>
              )}

              {!loadingPlatforms && !hasExternalPlatforms && (
                <p className="text-xs text-text-muted mt-2">
                  Connect social accounts in the dashboard to publish externally.
                </p>
              )}
            </div>

            {/* Caption */}
            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">
                Caption
              </label>
              <textarea
                value={caption}
                onChange={(e) => {
                  setCaption(e.target.value);
                  if (!captionTouched) {
                    setCaptionTouched(true);
                  }
                }}
                placeholder="Write a caption for your video..."
                rows={3}
                maxLength={2200}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-text-primary text-sm resize-none focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 placeholder:text-text-muted"
              />
              <div className="text-[10px] text-text-muted text-right mt-0.5">
                {caption.length} / 2200
              </div>
            </div>

            {/* Mode toggle: Publish Now vs Schedule */}
            <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-background-tertiary">
              <div className="flex-1">
                <div className="text-sm font-medium text-text-primary flex items-center gap-2">
                  <Calendar size={14} />
                  Schedule for later
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  {mode === "schedule"
                    ? "Choose when to publish"
                    : "Post will be published immediately"}
                </p>
              </div>
              <Switch
                checked={mode === "schedule"}
                onCheckedChange={(checked) => setMode(checked ? "schedule" : "publish")}
              />
            </div>

            {/* Schedule picker */}
            {mode === "schedule" && (
              <div className="space-y-3 p-3 rounded-lg border border-primary/20 bg-primary/5">
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs font-medium text-text-secondary block mb-1">Date</label>
                    <input
                      type="date"
                      value={scheduleDate}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setScheduleDate(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-border bg-background text-text-primary text-sm focus:outline-none focus:border-primary"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs font-medium text-text-secondary block mb-1">Time (UTC)</label>
                    <input
                      type="time"
                      value={scheduleTime}
                      onChange={(e) => setScheduleTime(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-border bg-background text-text-primary text-sm focus:outline-none focus:border-primary"
                    />
                  </div>
                </div>

                {/* Optimal time suggestions */}
                {loadingOptimal ? (
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <Loader2 size={12} className="animate-spin" />
                    Finding best posting times...
                  </div>
                ) : optimalSlots.length > 0 ? (
                  <div>
                    <p className="text-xs font-medium text-text-secondary mb-1.5 flex items-center gap-1">
                      <Sparkles size={12} className="text-primary" />
                      Recommended times
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {optimalSlots.map((slot, i) => (
                        <button
                          key={i}
                          onClick={() => applyOptimalSlot(slot)}
                          className="px-2.5 py-1 rounded-md bg-primary/10 border border-primary/20 text-xs text-primary hover:bg-primary/20 transition-colors"
                          title={slot.reason}
                        >
                          <Clock size={10} className="inline mr-1" />
                          {slot.day} {new Date(slot.publishAtUtc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-between items-center pt-2">
              <Button
                variant="outline"
                onClick={() => setStep("preview")}
                className="gap-2"
              >
                ← Back to Preview
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={isWorking}
                  className="gap-2 bg-primary hover:bg-primary-hover text-white"
                >
                  {mode === "schedule" ? (
                    <>
                      <Calendar size={14} />
                      Schedule
                    </>
                  ) : (
                    <>
                      <Send size={14} />
                      Publish Now
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP: UPLOADING / SUBMITTING ── */}
        {isWorking && (
          <div className="py-8 space-y-4 text-center">
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Upload size={28} className="text-primary animate-pulse" />
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">
                {step === "uploading" ? "Uploading video..." : "Publishing to platforms..."}
              </p>
              <p className="text-xs text-text-muted mt-1">
                This may take a moment depending on video size
              </p>
            </div>
            <div className="max-w-xs mx-auto">
              <Progress value={uploadProgress} className="h-2" />
              <p className="text-[10px] text-text-muted mt-1">{uploadProgress}%</p>
            </div>
          </div>
        )}

        {/* ── STEP: DONE ── */}
        {step === "done" && (
          <div className="py-8 space-y-4 text-center">
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Check size={28} className="text-primary" />
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">
                {mode === "schedule" ? "Video Scheduled!" : "Video Published!"}
              </p>
              <p className="text-xs text-text-muted mt-1">
                {resultMessage}
              </p>
              <div className="flex flex-wrap justify-center gap-1.5 mt-3">
                {Array.from(selectedPlatforms).map((pid) => {
                  const plat = SOCIAL_PLATFORMS.find((p) => p.id === pid);
                  return (
                    <span
                      key={pid}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-xs text-primary"
                    >
                      <PlatformIcon platform={pid} socialImage={platformDetails.get(pid)?.socialImage} size={12} />
                      {plat?.name || pid}
                    </span>
                  );
                })}
              </div>
            </div>
            <Button
              onClick={onClose}
              className="bg-primary hover:bg-primary-hover text-white"
            >
              Done
            </Button>
          </div>
        )}

        {/* ── STEP: ERROR ── */}
        {step === "error" && (
          <div className="py-8 space-y-4 text-center">
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center">
                <AlertCircle size={28} className="text-error" />
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">
                Publishing Failed
              </p>
              <p className="text-xs text-text-muted mt-1 max-w-md mx-auto">
                {errorMessage}
              </p>
            </div>
            <div className="flex justify-center gap-2">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button
                onClick={() => setStep("configure")}
                className="bg-primary hover:bg-primary-hover text-white gap-2"
              >
                Try Again
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default PublishDialog;
