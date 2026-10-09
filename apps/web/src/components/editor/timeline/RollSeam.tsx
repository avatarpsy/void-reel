import React, { useRef, useState } from "react";
import type { Clip } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";
import { useEditMonitorStore, formatFrameDelta } from "../../../stores/edit-monitor-store";
import {
  clampRollDelta,
  commitRoll,
  geomOf,
  patchClips,
  sourceDurationOf,
  useFineEditDrag,
  ROLL_CURSOR,
  type ClipGeom,
} from "./fine-edit";

/**
 * The cut between two butted clips. Drag it to ROLL the edit: the outgoing
 * clip gets longer and the incoming one shorter by the same amount (or the
 * reverse), so nothing else on the timeline moves — "cut one beat later".
 *
 * Sits ON the seam, 10px wide, above both clips' trim handles; the outer part
 * of each clip's handle still trims that clip alone. The viewer shows the last
 * frame out and the first frame in while dragging.
 */
export const RollSeam: React.FC<{ left: Clip; right: Clip; pixelsPerSecond: number }> = ({
  left,
  right,
  pixelsPerSecond,
}) => {
  const fps = useProjectStore((s) => s.project.settings.frameRate) || 30;
  const setMonitor = useEditMonitorStore((s) => s.setMonitor);
  const [active, setActive] = useState(false);
  const sess = useRef({ mouseX: 0, origL: geomOf(left) as ClipGeom, origR: geomOf(right) as ClipGeom, delta: 0, srcDurL: Infinity });

  const show = (delta: number) => {
    const { origL, origR } = sess.current;
    setMonitor({
      title: "Roll cut",
      badge: formatFrameDelta(delta, fps),
      frames: [
        { mediaId: left.mediaId, time: Math.max(origL.inPoint, origL.outPoint + delta - 1 / fps), label: "Outgoing" },
        { mediaId: right.mediaId, time: origR.inPoint + delta, label: "Incoming" },
      ],
    });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    sess.current = {
      mouseX: e.clientX,
      origL: geomOf(left),
      origR: geomOf(right),
      delta: 0,
      srcDurL: sourceDurationOf(useProjectStore.getState().getMediaItem(left.mediaId)),
    };
    setActive(true);
    show(0);
  };

  useFineEditDrag(
    active,
    ROLL_CURSOR,
    (e) => {
      const s = sess.current;
      const want = Math.round(((e.clientX - s.mouseX) / pixelsPerSecond) * fps) / fps;
      const base = { ...left, ...s.origL } as Clip;
      const delta = clampRollDelta(want, base, { ...right, ...s.origR } as Clip, s.srcDurL);
      if (Math.abs(delta - s.delta) < 1e-9) return;
      s.delta = delta;
      patchClips({
        [left.id]: { duration: s.origL.duration + delta, outPoint: s.origL.outPoint + delta },
        [right.id]: {
          startTime: s.origR.startTime + delta,
          inPoint: s.origR.inPoint + delta,
          duration: s.origR.duration - delta,
        },
      });
      show(delta);
    },
    (commit) => {
      const s = sess.current;
      setActive(false);
      setMonitor(null);
      void commitRoll(left.id, right.id, s.origL, s.origR, commit ? s.delta : 0);
    },
  );

  const x = (left.startTime + left.duration) * pixelsPerSecond;
  return (
    <div
      data-roll-seam={`${left.id}|${right.id}`}
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      title="Drag to roll the cut — one clip gets longer, the other shorter"
      className="absolute top-1 bottom-1 w-2.5 -ml-[5px] z-30 group/seam"
      style={{ left: `${x}px`, cursor: ROLL_CURSOR }}
    >
      <div
        className={`mx-auto h-full w-0.5 rounded-full transition-opacity ${
          active ? "bg-primary opacity-100" : "bg-white/80 opacity-0 group-hover/seam:opacity-100"
        }`}
      />
      {active && (
        <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 -translate-y-full px-1.5 py-0.5 rounded bg-black/80 text-white text-[10px] font-mono whitespace-nowrap pointer-events-none">
          Roll {formatFrameDelta(sess.current.delta, fps)}
        </div>
      )}
    </div>
  );
};
