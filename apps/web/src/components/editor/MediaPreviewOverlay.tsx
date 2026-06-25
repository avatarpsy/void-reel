import { useEffect } from "react";
import { X, Music } from "lucide-react";

export type PreviewKind = "image" | "video" | "audio";

interface MediaPreviewOverlayProps {
  url: string;
  kind: PreviewKind;
  name?: string;
  onClose: () => void;
}

/**
 * Fullscreen preview for an Assets-panel item. Clicking a Media/Library tile
 * opens this (it does NOT add the item to the project); items only land on the
 * timeline when dragged there. Backdrop click / Close button / Escape dismiss.
 */
export function MediaPreviewOverlay({ url, kind, name, onClose }: MediaPreviewOverlayProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-8"
      onClick={onClose}
    >
      <button
        type="button"
        className="absolute top-4 right-4 inline-flex items-center gap-1.5 px-4 h-9 rounded-full bg-black/70 text-white text-sm font-medium border border-white/20 hover:bg-black/90 transition-colors"
        onClick={onClose}
      >
        <X size={14} /> Close
      </button>
      <div
        className="flex items-center justify-center max-w-[90vw] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {kind === "image" && (
          <img src={url} alt={name || ""} className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg" />
        )}
        {kind === "video" && (
          <video src={url} className="max-w-[90vw] max-h-[90vh] rounded-lg bg-black" controls autoPlay playsInline />
        )}
        {kind === "audio" && (
          <div className="flex flex-col items-center gap-6 px-14 py-12 rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 border border-white/10">
            <Music size={64} className="text-primary drop-shadow" />
            {name ? <p className="text-sm text-white/80 max-w-xs truncate">{name}</p> : null}
            <audio src={url} controls autoPlay className="w-[360px] max-w-[80vw]" />
          </div>
        )}
      </div>
    </div>
  );
}
