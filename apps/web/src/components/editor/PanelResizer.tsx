import React, { useEffect, useRef } from "react";
import { useUIStore } from "../../stores/ui-store";

interface PanelResizerProps {
  /** Which side panel this handle resizes. Maps to the ui-store panel id
   *  whose `.width` is read/written (persisted, clamped 200–800 by the
   *  store). */
  panelId: "mediaLibrary" | "inspector";
  /** Which panel the handle sits NEXT TO:
   *   • "right" — handle is on the RIGHT of the panel (Assets, left column):
   *     dragging right widens the panel.
   *   • "left"  — handle is on the LEFT of the panel (Inspector, right
   *     column): dragging left widens the panel. */
  side: "right" | "left";
  min?: number;
  max?: number;
}

/**
 * Thin vertical drag handle that lives BETWEEN panels as a flex sibling
 * (NOT absolutely positioned inside a panel — the Inspector scrolls, so an
 * in-panel absolute handle would scroll away). It reads/writes the panel's
 * persisted width via the existing `panels.<id>.width` + `setPanelWidth`
 * store API — no new state model.
 */
export const PanelResizer: React.FC<PanelResizerProps> = ({
  panelId,
  side,
  min = 240,
  max = 640,
}) => {
  const setPanelWidth = useUIStore((s) => s.setPanelWidth);
  const startX = useRef(0);
  const startW = useRef(0);
  const dragging = useRef(false);

  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = useUIStore.getState().panels[panelId].width ?? 320;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - startX.current;
      const delta = side === "right" ? dx : -dx;
      setPanelWidth(panelId, Math.max(min, Math.min(max, startW.current + delta)));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [panelId, side, min, max, setPanelWidth]);

  return (
    <div
      onMouseDown={onDown}
      title="Drag to resize"
      className="group relative w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-primary/10 transition-colors z-30 flex items-center justify-center"
    >
      {/* tall invisible hit-band so the 1.5px bar is still easy to grab */}
      <div className="absolute inset-y-0 -left-1 -right-1" />
      <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors pointer-events-none" />
    </div>
  );
};

export default PanelResizer;
