import React, { useRef, useState, useEffect } from "react";
import { Type } from "lucide-react";
import type { TextClip } from "@openreel/core";
import { ContextMenu, ContextMenuTrigger } from "@openreel/ui";
import { GraphicsClipContextMenu } from "./GraphicsClipContextMenu";
import { calculateSnap } from "./utils";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { useUIStore } from "../../../stores/ui-store";

interface TextClipComponentProps {
  textClip: TextClip;
  trackId: string;
  pixelsPerSecond: number;
  isSelected: boolean;
  onSelect: (clipId: string, addToSelection: boolean) => void;
  onTrim: (clipId: string, edge: "left" | "right", newTime: number) => void;
  onMoveClip?: (clipId: string, newStartTime: number) => void;
}

export const TextClipComponent: React.FC<TextClipComponentProps> = ({
  textClip,
  trackId,
  pixelsPerSecond,
  isSelected,
  onSelect,
  onTrim,
  onMoveClip,
}) => {
  const clipRef = useRef<HTMLDivElement>(null);
  const [isTrimming, setIsTrimming] = useState<"left" | "right" | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  // True once the pointer actually moved during a press — lets the trailing
  // click distinguish a real drag (keep the selection) from a plain click.
  const didDragRef = useRef(false);
  const { snapSettings } = useUIStore();
  const { playheadPosition } = useTimelineStore();
  const trimStartRef = useRef<{
    mouseX: number;
    startTime: number;
    duration: number;
  }>({
    mouseX: 0,
    startTime: textClip.startTime,
    duration: textClip.duration,
  });

  const left = textClip.startTime * pixelsPerSecond;
  const width = textClip.duration * pixelsPerSecond;

  const handleClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (isTrimming || isDragging) return;
    // Always stop the click here so it can't bubble to the timeline background
    // (whose handler clears the selection). A click that ended a drag must NOT
    // narrow the selection either — otherwise a marquee group would collapse to
    // this one caption after the first move, breaking the next group drag.
    e.stopPropagation();
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    onSelect(textClip.id, e.shiftKey || e.metaKey);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (isTrimming) return;
    e.stopPropagation();

    const rect = clipRef.current?.parentElement?.getBoundingClientRect();
    if (!rect) return;

    const clickX = e.clientX - rect.left;
    const clipStartX = textClip.startTime * pixelsPerSecond;
    setDragOffset(clickX - clipStartX);
    didDragRef.current = false;
    setIsDragging(true);

    // Only (re)select when this caption ISN'T already selected. If it's part of
    // a marquee group, preserve the group so the drag moves everything together
    // (mirrors ClipComponent, which defers selection to a real click).
    if (!isSelected) onSelect(textClip.id, e.shiftKey || e.metaKey);
  };

  useEffect(() => {
    if (!isDragging || !onMoveClip) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = clipRef.current?.parentElement?.getBoundingClientRect();
      if (!rect) return;
      didDragRef.current = true;

      const x = e.clientX - rect.left - dragOffset;
      const rawTime = Math.max(0, x / pixelsPerSecond);
      const allTracks = useProjectStore.getState().project.timeline.tracks;
      const dragSnapSettings = { ...snapSettings, snapToPlayhead: false };
      const snapResult = calculateSnap(
        rawTime,
        textClip.id,
        allTracks,
        playheadPosition,
        dragSnapSettings,
        pixelsPerSecond,
        textClip.duration,
      );
      onMoveClip(textClip.id, snapResult.time);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, textClip.id, textClip.duration, pixelsPerSecond, dragOffset, onMoveClip, snapSettings, playheadPosition]);

  const handleTrimStart = (e: React.MouseEvent, edge: "left" | "right") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setIsTrimming(edge);
    trimStartRef.current = {
      mouseX: e.clientX,
      startTime: textClip.startTime,
      duration: textClip.duration,
    };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    if (!isTrimming) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - trimStartRef.current.mouseX;
      const deltaTime = deltaX / pixelsPerSecond;

      if (isTrimming === "left") {
        const newStartTime = Math.max(
          0,
          trimStartRef.current.startTime + deltaTime,
        );
        const maxStartTime =
          trimStartRef.current.startTime + trimStartRef.current.duration - 0.1;
        const clampedStartTime = Math.min(newStartTime, maxStartTime);
        onTrim(textClip.id, "left", clampedStartTime);
      } else {
        const newEndTime =
          trimStartRef.current.startTime +
          trimStartRef.current.duration +
          deltaTime;
        const minEndTime = trimStartRef.current.startTime + 0.1;
        const clampedEndTime = Math.max(newEndTime, minEndTime);
        onTrim(textClip.id, "right", clampedEndTime);
      }
    };

    const handleMouseUp = () => {
      setIsTrimming(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isTrimming, textClip.id, pixelsPerSecond, onTrim]);

  const isInteracting = isDragging || isTrimming;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={clipRef}
          data-clip-id={textClip.id}
          data-track-id={trackId}
          data-clip-kind="text-clip"
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          className={`clip-component absolute top-1 bottom-1 rounded-lg overflow-hidden cursor-grab group ${
            isDragging ? "cursor-grabbing opacity-75" : ""
          } ${
            isSelected
              ? "ring-2 ring-amber-400 border-amber-400 z-10"
              : "border-amber-500/30 hover:border-amber-500/60 hover:brightness-110"
          } bg-amber-500/20 border`}
          style={{
            transform: `translateX(${left}px)`,
            width: `${Math.max(width, 40)}px`,
            willChange: isInteracting ? 'transform, width' : 'auto',
            transition: isInteracting ? 'none' : 'opacity 150ms, box-shadow 150ms',
          }}
        >
          <div
            className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-amber-400/50 z-20 opacity-0 group-hover:opacity-100 transition-opacity"
            onMouseDown={(e) => handleTrimStart(e, "left")}
            title="Drag to trim start"
          />
          <div
            className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-amber-400/50 z-20 opacity-0 group-hover:opacity-100 transition-opacity"
            onMouseDown={(e) => handleTrimStart(e, "right")}
            title="Drag to trim end"
          />
          <div className="w-full h-full flex items-center gap-1 px-3">
            <Type size={12} className="text-amber-700 dark:text-amber-400 flex-shrink-0" />
            <span className="text-[10px] font-medium text-amber-900 dark:text-amber-200 truncate">
              {textClip.text || "Text"}
            </span>
          </div>
          {isSelected && (
            <>
              <div className="absolute inset-0 border-2 border-amber-400 rounded-lg pointer-events-none" />
              <div
                className="absolute left-0 top-1/2 -translate-y-1/2 w-1.5 h-6 bg-amber-400 rounded-r cursor-ew-resize"
                onMouseDown={(e) => handleTrimStart(e, "left")}
              />
              <div
                className="absolute right-0 top-1/2 -translate-y-1/2 w-1.5 h-6 bg-amber-400 rounded-l cursor-ew-resize"
                onMouseDown={(e) => handleTrimStart(e, "right")}
              />
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <GraphicsClipContextMenu clip={textClip} clipType="text" />
    </ContextMenu>
  );
};
