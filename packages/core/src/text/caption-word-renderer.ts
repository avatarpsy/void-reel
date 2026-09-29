/**
 * Kinetic caption canvas renderer — draws a caption phrase onto a 2D context
 * with a per-style word animation (the "viral" CapCut/TikTok look).
 *
 * The per-word ANIMATION MATH is NOT duplicated here: it is computed by the
 * shared `renderAnimatedCaption` (caption-animation-renderer.ts) which is also
 * used by the legacy subtitle path. This file only owns LAYOUT + DRAWING for
 * the native text-clip caption path. Both the live preview (apps/web
 * canvas-renderers) and the export pipeline (core title-engine) call this with
 * clip-local time, so preview and export are pixel-identical.
 */
import type { CaptionWord } from "./types";
import type { CaptionAnimationStyle, Subtitle } from "../types/timeline";
import { renderAnimatedCaption, type WordSegment } from "./caption-animation-renderer";

type DrawingContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

export interface CaptionWordDrawOptions {
  /** Base (not-active) word colour. */
  color: string;
  /** Active (currently-spoken) word colour. */
  highlightColor: string;
  /** Outline colour; outline is skipped when width <= 0. */
  strokeColor?: string;
  strokeWidth?: number;
  /** Font size in px — used to derive the inter-word gap. */
  fontSize: number;
  /** Vertical centre of the caption line in the translated ctx space. */
  centerY: number;
  /** Composition width in px for fit-to-width clamping; omit to skip. */
  canvasWidth?: number;
  /** Caption background box colour; skipped when absent or "transparent". */
  backgroundColor?: string;
  /** Which kinetic animation to draw (default "word-highlight"). */
  animationStyle?: CaptionAnimationStyle;
}

/** Resolve a word segment's draw colour (mirrors the subtitle renderer). */
function segmentColor(
  seg: WordSegment,
  base: string,
  highlight: string,
): string | null {
  if (seg.color) {
    if (seg.color.startsWith("linear-gradient")) return highlight; // karaoke
    if (seg.color === "transparent") return null;
    return seg.color;
  }
  if (seg.style === "highlighted" || seg.style === "active") return highlight;
  return base;
}

/**
 * Draw `words` as a single centred line, animated per `opts.animationStyle`.
 * Assumes the phrase fits on one line (caption chunks are short). The caller's
 * ctx font is used for measurement and drawing.
 */
export function renderCaptionWordHighlight(
  ctx: DrawingContext,
  words: readonly CaptionWord[],
  clipLocalTime: number,
  opts: CaptionWordDrawOptions,
): void {
  if (!words.length) return;

  const prevAlign = ctx.textAlign;
  const prevBaseline = ctx.textBaseline;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Drive the per-word visuals through the shared animation engine. Build a
  // pseudo-subtitle whose word times are this clip's (clip-relative) word times,
  // matched against clipLocalTime. endTime is open so the caption stays drawn
  // for the whole active clip (the clip is only rendered while active anyway).
  const pseudo: Subtitle = {
    id: "caption",
    text: words.map((w) => w.text).join(" "),
    startTime: 0,
    endTime: Number.MAX_SAFE_INTEGER,
    words: words.map((w) => ({
      text: w.text,
      startTime: w.start,
      endTime: w.end,
    })),
    animationStyle: opts.animationStyle ?? "word-highlight",
    style: {
      fontFamily: "",
      fontSize: opts.fontSize,
      color: opts.color,
      backgroundColor: "transparent",
      position: "bottom",
      highlightColor: opts.highlightColor,
    },
  };

  const frame = renderAnimatedCaption(pseudo, clipLocalTime);
  if (!frame.visible || frame.segments.length === 0) {
    ctx.textAlign = prevAlign;
    ctx.textBaseline = prevBaseline;
    return;
  }

  const gap = opts.fontSize * 0.28;
  const segs = frame.segments;
  // Measure every returned segment (hidden ones reserve their slot, e.g. bounce
  // before a word starts) so the line stays centred and stable.
  const widths = segs.map((s) => ctx.measureText(s.text).width);
  const totalWidth =
    widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, segs.length - 1);

  // Fit-to-width: viral captions are sized large (~7% of comp height), so a long
  // phrase can exceed the frame on a 9:16 comp. Scale the whole line down to fit.
  const maxWidth = opts.canvasWidth ? opts.canvasWidth * 0.9 : Infinity;
  const needed = totalWidth * 1.04; // headroom for active-word pop
  const fit = needed > maxWidth && needed > 0 ? maxWidth / needed : 1;

  ctx.save();
  // finally-restore below: a throw mid-draw must not leak the save (or the
  // align/baseline overrides) into the caller's ctx — preview AND export
  // share this renderer, and an unbalanced save corrupts every later layer.
  try {
  if (fit !== 1) ctx.scale(fit, fit);

  if (opts.backgroundColor && opts.backgroundColor !== "transparent") {
    const padX = opts.fontSize * 0.3;
    const boxH = opts.fontSize * 1.3;
    ctx.fillStyle = opts.backgroundColor;
    ctx.fillRect(
      -totalWidth / 2 - padX,
      opts.centerY - boxH / 2,
      totalWidth + padX * 2,
      boxH,
    );
  }

  let x = -totalWidth / 2;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const w = widths[i];
    const color =
      seg.style === "hidden"
        ? null
        : segmentColor(seg, opts.color, opts.highlightColor);

    if (color !== null && seg.opacity > 0) {
      ctx.save();
      ctx.globalAlpha = seg.opacity;
      ctx.translate(x + w / 2, opts.centerY + seg.offsetY);
      if (seg.scale !== 1) ctx.scale(seg.scale, seg.scale);

      if (opts.strokeColor && opts.strokeWidth && opts.strokeWidth > 0) {
        ctx.strokeStyle = opts.strokeColor;
        ctx.lineWidth = opts.strokeWidth;
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.strokeText(seg.text, 0, 0);
      }
      ctx.fillStyle = color;
      ctx.fillText(seg.text, 0, 0);
      ctx.restore();
    }
    x += w + gap;
  }

  } finally {
    ctx.restore();
    ctx.textAlign = prevAlign;
    ctx.textBaseline = prevBaseline;
  }
}

/**
 * Wrap plain text to a width by turning the space at each break into "\n".
 *
 * Neither the preview nor the export renderer wrapped text — they split on
 * "\n" only — so a caption the agent typed as one sentence ran off both edges
 * of a 9:16 frame (Grok tests #5 and #6, 29 Sep; in #6 it even undid the
 * add_text split by writing the whole sentence back with text-content). Fitting
 * at draw time covers every way text reaches a clip.
 *
 * The result has the SAME length as the input (a space becomes a newline), so
 * per-character animation state stays aligned. A single word wider than the
 * limit stays on its own line rather than being broken.
 */
export function wrapTextToWidth(
  measure: (s: string) => number,
  text: string,
  maxWidth: number,
): string {
  if (!(maxWidth > 0) || !text) return text;
  return text
    .split("\n")
    .map((para) => {
      if (measure(para) <= maxWidth) return para;
      const words = para.split(" ");
      const out: string[] = [];
      let line = "";
      let started = false;
      for (const w of words) {
        const trial = started ? `${line} ${w}` : w;
        if (started && line && measure(trial) > maxWidth) {
          out.push(line);
          line = w;
        } else {
          line = trial;
        }
        started = true;
      }
      out.push(line);
      return out.join("\n");
    })
    .join("\n");
}
