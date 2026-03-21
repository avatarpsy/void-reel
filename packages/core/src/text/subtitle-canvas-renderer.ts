/**
 * Shared subtitle canvas renderer used by BOTH preview and export.
 * This is the single source of truth for subtitle rendering.
 * Any changes here will be reflected in both preview and exported video.
 */
import type { Subtitle } from "../types/timeline";
import { renderAnimatedCaption, type WordSegment } from "./caption-animation-renderer";

// Accept either CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D
type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Render a subtitle (static or animated) to a canvas context.
 * Called by both the preview canvas and the export engine.
 */
export function renderSubtitleToCanvasCtx(
  ctx: DrawingContext,
  subtitle: Subtitle,
  canvasWidth: number,
  canvasHeight: number,
  currentTime?: number,
): void {
  const { text, animationStyle, words } = subtitle;
  if (!text || text.trim().length === 0) return;

  const hasAnimation =
    animationStyle && animationStyle !== "none" && words && words.length > 0;
  const time = currentTime ?? subtitle.startTime;

  if (hasAnimation) {
    renderAnimatedSubtitle(ctx, subtitle, canvasWidth, canvasHeight, time);
  } else {
    renderStaticSubtitle(ctx, subtitle, canvasWidth, canvasHeight);
  }
}

function renderStaticSubtitle(
  ctx: DrawingContext,
  subtitle: Subtitle,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const { text, style } = subtitle;

  ctx.save();

  const fontSize = style?.fontSize || 24;
  const fontFamily = style?.fontFamily || "Inter";
  const color = style?.color || "#ffffff";
  const backgroundColor = style?.backgroundColor || "rgba(0, 0, 0, 0.7)";
  const position = style?.position || "bottom";
  const isRemotionLook = fontFamily.toLowerCase().includes("anton");
  const outlineWidth = isRemotionLook ? 5 : 0;
  const outlineColor = "#000000";

  const fontWeight = isRemotionLook ? 400 : 700;
  ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (isRemotionLook) {
    ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
    ctx.shadowBlur = 16;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 8;
  }

  const lines = text.split("\n");
  const lineHeight = fontSize * 1.3;
  const totalHeight = lines.length * lineHeight;

  let baseY: number;
  if (position === "top") {
    baseY = fontSize * 2;
  } else if (position === "center") {
    baseY = (isRemotionLook ? canvasHeight * 0.58 : canvasHeight / 2) -
      totalHeight / 2;
  } else {
    baseY = canvasHeight - fontSize * 2 - totalHeight;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    const y = baseY + i * lineHeight + lineHeight / 2;
    const metrics = ctx.measureText(line);
    const bgWidth = metrics.width + 20;
    const bgHeight = lineHeight;

    if (backgroundColor !== "transparent") {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(
        canvasWidth / 2 - bgWidth / 2,
        y - bgHeight / 2,
        bgWidth,
        bgHeight,
      );
    }

    const normalizedLine = isRemotionLook ? line.toUpperCase() : line;
    if (outlineWidth > 0) {
      ctx.strokeStyle = outlineColor;
      ctx.lineWidth = outlineWidth;
      ctx.strokeText(normalizedLine, canvasWidth / 2, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(normalizedLine, canvasWidth / 2, y);
  }

  ctx.restore();
}

function renderAnimatedSubtitle(
  ctx: DrawingContext,
  subtitle: Subtitle,
  canvasWidth: number,
  canvasHeight: number,
  currentTime: number,
): void {
  const frame = renderAnimatedCaption(subtitle, currentTime);

  if (!frame.visible || frame.segments.length === 0) {
    return;
  }

  ctx.save();

  const style = subtitle.style;
  const fontSize = style?.fontSize || 24;
  const fontFamily = style?.fontFamily || "Inter";
  const baseColor = style?.color || "#ffffff";
  const backgroundColor = style?.backgroundColor || "rgba(0, 0, 0, 0.7)";
  const position = style?.position || "bottom";
  const isRemotionLook = fontFamily.toLowerCase().includes("anton");
  const outlineWidth = isRemotionLook ? 5 : 0;
  const outlineColor = "#000000";

  const fontWeight = isRemotionLook ? 400 : 700;
  ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}"`;
  ctx.textBaseline = "middle";
  if (isRemotionLook) {
    ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
    ctx.shadowBlur = 16;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 8;
  }

  const lineHeight = fontSize * 1.3;
  const wordGap = fontSize * 0.25;
  const maxLineWidth = canvasWidth * 0.70;

  // Measure all segments and apply word-level transforms (uppercase for Anton)
  const measuredSegments = frame.segments.map((segment) => {
    const displayText = isRemotionLook ? segment.text.toUpperCase() : segment.text;
    return {
      ...segment,
      displayText,
      width: ctx.measureText(displayText).width,
    };
  });

  // Word-wrap: split into lines at 70% canvas width
  const lines: Array<{ segments: typeof measuredSegments; width: number }> = [];
  let currentLine: typeof measuredSegments = [];
  let currentLineWidth = 0;

  for (const seg of measuredSegments) {
    const nextWidth = currentLine.length === 0
      ? seg.width
      : currentLineWidth + wordGap + seg.width;

    if (currentLine.length > 0 && nextWidth > maxLineWidth) {
      lines.push({ segments: currentLine, width: currentLineWidth });
      currentLine = [seg];
      currentLineWidth = seg.width;
    } else {
      currentLine.push(seg);
      currentLineWidth = nextWidth;
    }
  }
  if (currentLine.length > 0) {
    lines.push({ segments: currentLine, width: currentLineWidth });
  }

  // Calculate block position
  const blockHeight = lines.length * lineHeight;
  let blockTop: number;
  if (position === "top") {
    blockTop = fontSize * 2;
  } else if (position === "center") {
    blockTop = (isRemotionLook ? canvasHeight * 0.58 : canvasHeight / 2) - blockHeight / 2;
  } else {
    blockTop = canvasHeight - fontSize * 2 - blockHeight;
  }

  // Draw each line
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineY = blockTop + lineIdx * lineHeight + lineHeight / 2;
    const bgWidth = line.width + 30;
    const bgHeight = lineHeight + 10;

    if (backgroundColor !== "transparent") {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(
        canvasWidth / 2 - bgWidth / 2,
        lineY - bgHeight / 2,
        bgWidth,
        bgHeight,
      );
    }

    let xOffset = canvasWidth / 2 - line.width / 2;

    for (const segment of line.segments) {
      ctx.save();
      ctx.globalAlpha = segment.opacity;

      const segmentColor = getSegmentColor(
        segment,
        baseColor,
        style?.highlightColor,
      );

      if (outlineWidth > 0) {
        ctx.strokeStyle = outlineColor;
        ctx.lineWidth = outlineWidth;
        ctx.textAlign = "left";
        ctx.strokeText(segment.displayText, xOffset, lineY + segment.offsetY);
      }
      ctx.fillStyle = segmentColor;
      ctx.textAlign = "left";
      ctx.fillText(segment.displayText, xOffset, lineY + segment.offsetY);

      ctx.restore();

      xOffset += segment.width + wordGap;
    }
  }

  ctx.restore();
}

function getSegmentColor(
  segment: WordSegment,
  baseColor: string,
  highlightColor?: string,
): string {
  const effectiveHighlight =
    highlightColor || (baseColor.toLowerCase() === "#ffffff" ? "#ff0000" : "#ffff00");

  if (segment.color) {
    if (segment.color.startsWith("linear-gradient")) {
      return effectiveHighlight;
    }
    if (segment.color === "transparent") {
      return "rgba(0,0,0,0)";
    }
    return segment.color;
  }

  switch (segment.style) {
    case "highlighted":
    case "active":
      return effectiveHighlight;
    case "hidden":
      return "rgba(0,0,0,0)";
    default:
      return baseColor;
  }
}
