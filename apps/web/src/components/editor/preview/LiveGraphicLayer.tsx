/**
 * A HyperFrames graphic clip, drawn LIVE over the preview canvas.
 *
 * The same sandboxed live renderer the Library tiles use (`mountBlockPreview`),
 * held at the playhead instead of playing on its own, sized and placed exactly
 * where the clip sits on the canvas. While it is up, the canvas skips this
 * clip's rendered frame (see `useLiveGraphicStore`), so what the person sees is
 * the composition with the values they are typing — no render wait.
 *
 * Mounted by `Preview` only while the clip is selected and playback is paused;
 * during playback the rendered file plays, which is what exports.
 */
import React, { useEffect, useMemo, useRef } from "react";
import {
  mountBlockPreview,
  ensureBlockPreviewStyles,
  type PreviewHandle,
  type SlotFill,
  type BlockInfo,
} from "@openreel/asset-browser";
import type { Clip } from "@openreel/core";
import { findBlock } from "../../../services/blocks";
import { useLiveGraphicStore } from "../../../stores/live-graphic-store";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Values → what the live renderer takes. A slot with a selector or a CSS
 * variable is patched in place (instant, animation intact); a catalog block's
 * word is keyed BY its selector; everything else is a variable the block reads.
 */
function toFills(block: BlockInfo | null, values: Record<string, string>): { vars: Record<string, string>; fills: SlotFill[] } {
  const vars: Record<string, string> = {};
  const fills: SlotFill[] = [];
  const declared = new Map((block?.slots ?? []).map((s) => [s.key, s]));
  for (const [key, value] of Object.entries(values)) {
    if (!String(value ?? "").trim()) continue;
    const slot = declared.get(key);
    const kind = slot?.kind ?? "text";
    if (/^[#.]/.test(key)) fills.push({ key, kind, value, sel: key });
    else if (slot?.sel || slot?.cssVar) fills.push({ key, kind, value, sel: slot.sel, cssVar: slot.cssVar });
    else vars[key] = value;
  }
  return { vars, fills };
}

let noteStyle = false;
function hideLoadingNote() {
  if (noteStyle || typeof document === "undefined") return;
  noteStyle = true;
  const s = document.createElement("style");
  // The tile's "Loading preview…" line has no place over a video frame: the
  // rendered frame stays visible underneath until the live one has painted.
  s.textContent = "[data-live-graphic] > .vs-blockprev__note{display:none}";
  document.head.append(s);
}

export const LiveGraphicLayer: React.FC<{
  clip: Clip;
  bounds: Bounds;
  /** Playhead, in timeline seconds. */
  time: number;
  rotation: number;
  opacity: number;
}> = ({ clip, bounds, time, rotation, opacity }) => {
  const host = useRef<HTMLDivElement | null>(null);
  const handle = useRef<PreviewHandle | null>(null);
  const blockRef = useRef<BlockInfo | null>(null);
  const graphic = clip.metadata?.graphic;
  const draft = useLiveGraphicStore((s) => s.drafts[clip.id]);
  const setLiveClip = useLiveGraphicStore((s) => s.setLiveClip);
  const values = useMemo(() => ({ ...(graphic?.slots ?? {}), ...(draft ?? {}) }), [graphic?.slots, draft]);
  // Composition time: the clip's own clock, from its in-point.
  const local = Math.max(0, time - clip.startTime + (clip.inPoint ?? 0));
  const localRef = useRef(local);
  localRef.current = local;
  const valuesRef = useRef(values);
  valuesRef.current = values;

  useEffect(() => {
    if (!graphic?.block || !host.current) return;
    ensureBlockPreviewStyles();
    hideLoadingNote();
    let live = true;
    const el = host.current;
    void findBlock(graphic.block, graphic.source).then((block) => {
      if (!live) return;
      blockRef.current = block;
      const { vars, fills } = toFills(block, valuesRef.current);
      handle.current = mountBlockPreview(el, graphic.block, vars, fills, {
        source: graphic.source,
        seek: localRef.current,
        onSettled: (ok) => { if (live && ok) setLiveClip(clip.id); },
      });
    });
    return () => {
      live = false;
      handle.current?.destroy();
      handle.current = null;
      setLiveClip(null);
    };
  }, [clip.id, graphic?.block, graphic?.source, setLiveClip]);

  useEffect(() => {
    const { vars, fills } = toFills(blockRef.current, values);
    handle.current?.update(vars, fills);
  }, [values]);

  useEffect(() => {
    handle.current?.seek(local);
  }, [local]);

  if (!graphic?.block) return null;
  return (
    <div
      ref={host}
      data-block-preview
      data-live-graphic
      className="absolute pointer-events-none z-[25]"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
        opacity,
      }}
    />
  );
};

export default LiveGraphicLayer;
