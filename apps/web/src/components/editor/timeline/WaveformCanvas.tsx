import React, { useEffect, useRef } from "react";

interface WaveformCanvasProps {
  /** Full-source peak samples (abs amplitude, ~100/s) from MediaItem.waveformData. */
  peaks: Float32Array;
  /** Trim window as fractions of the source (clip.inPoint/outPoint ÷ duration). */
  startFrac: number;
  endFrac: number;
  /** Accent color (CSS rgb/hex). Body is drawn translucent, core opaque. */
  color: string;
  className?: string;
}

/**
 * Pro-grade audio waveform — a dense, device-pixel-resolution canvas
 * render: one min/max column per physical pixel, a translucent peak body
 * with a darker RMS-style core, mirrored around the centre line. Replaces
 * the old low-res SVG envelope (which stretched ~1 bar/2px through a
 * `preserveAspectRatio="none"` viewBox, producing the blocky "diamond"
 * silhouette). Reads the peaks already cached on MediaItem (sliced to the
 * clip's trimmed window) — no new data model, fully backward-compatible.
 *
 * Sizes its backing store to the parent's box × devicePixelRatio and
 * redraws (rAF-coalesced) whenever the box, peaks, or trim change, so it
 * stays crisp across zoom and trim-drag without thrashing.
 */
export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
  peaks,
  startFrac,
  endFrac,
  color,
  className,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const cssW = Math.max(1, Math.round(parent.clientWidth));
      const cssH = Math.max(1, Math.round(parent.clientHeight));
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.round(cssW * dpr);
      const bh = Math.round(cssH * dpr);
      // Only reassign (which clears + reallocates the backing store) when
      // the size actually changed — avoids GC/realloc churn when the RO
      // fires for unrelated reasons during zoom/trim.
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      // Scale from the real backing/CSS ratio (not raw dpr) so there's no
      // sub-pixel seam at fractional display scaling (common on Windows).
      ctx.setTransform(bw / cssW, 0, 0, bh / cssH, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const len = peaks.length;
      if (!len) return;
      const s0 = Math.max(0, Math.min(1, startFrac));
      const e0 = Math.max(s0, Math.min(1, endFrac || 1));
      const startIdx = Math.floor(s0 * len);
      const endIdx = Math.max(startIdx + 1, Math.floor(e0 * len));
      const span = endIdx - startIdx;
      const per = span / cssW;
      const mid = cssH / 2;
      const maxH = (cssH / 2) * 0.92;

      // One peak column per physical-ish (CSS) pixel — dense, no stretch.
      const cols = new Float32Array(cssW);
      for (let x = 0; x < cssW; x++) {
        const from = startIdx + Math.floor(x * per);
        const to = Math.min(
          endIdx,
          Math.max(from + 1, startIdx + Math.floor((x + 1) * per)),
        );
        let m = 0;
        for (let j = from; j < to; j++) {
          const v = Math.abs(peaks[j] || 0);
          if (v > m) m = v;
        }
        cols[x] = m > 1 ? 1 : m;
      }

      const fillEnvelope = (scale: number, alpha: number) => {
        ctx.beginPath();
        ctx.moveTo(0, mid - cols[0] * maxH * scale);
        for (let x = 1; x < cssW; x++) ctx.lineTo(x, mid - cols[x] * maxH * scale);
        for (let x = cssW - 1; x >= 0; x--) ctx.lineTo(x, mid + cols[x] * maxH * scale);
        ctx.closePath();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fill();
      };

      // Translucent full-peak body + opaque RMS-style core = two-tone pro look.
      fillEnvelope(1, 0.45);
      fillEnvelope(0.55, 0.95);
      ctx.globalAlpha = 1;
    };

    const schedule = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        draw();
      });
    };

    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(parent);
    return () => {
      ro.disconnect();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        // MUST reset — otherwise the next effect run's schedule() sees a
        // stale non-null id, early-returns, and draw() never runs again.
        // That froze the backing store mid-trim while the width:100% canvas
        // CSS-stretched it → "waveform scales instead of cropping".
        rafRef.current = null;
      }
    };
  }, [peaks, startFrac, endFrac, color]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
};
