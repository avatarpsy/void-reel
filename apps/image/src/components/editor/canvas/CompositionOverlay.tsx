import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../../../stores/project-store';
import { useUIStore } from '../../../stores/ui-store';
import { prepareFromSource } from '../../../services/composition/document';
import { CompositionHost } from '../../../services/composition/frame-host';
import { resolveComposition } from '../../../services/composition/block-source';
import {
  liveCompositionFor,
  liveFrameIdentity,
  type CompositionLayerRef,
} from '../../../services/composition/overlay-model';
import { compositionPlacement, type Viewport } from '../../../services/composition/overlay-placement';
import type { CompositionSource } from '../../../types/project';

interface CompositionOverlayProps {
  /** The canvas element's size in CSS pixels. The canvas fills its container
   *  exactly and sizes its backing store 1:1 from that, so one number serves
   *  both the element and the coordinates drawn into it. */
  containerWidth: number;
  containerHeight: number;
}

/**
 * The live composition, sitting over the canvas.
 *
 * A composition layer's pixels come from a HyperFrames block — an HTML document
 * that lays itself out and animates. The canvas cannot draw one: rasterising it
 * in the browser was measured to taint the canvas outright (a `foreignObject`
 * does, even holding one plain div with no external reference), so those pixels
 * have to come from a server renderer that is not built yet. What CAN be shown,
 * and is the better thing to show while editing anyway, is the document itself —
 * running, sandboxed, landed exactly on the pixels its layer occupies.
 *
 * ── THIS IS A PREVIEW, NOT A SURFACE ────────────────────────────────────────
 * `pointer-events: none` on the whole overlay, and it is not optional. An iframe
 * eats every mouse event that reaches it, so without this the one thing you
 * could not do to a composition layer is click it — no selection, no drag, no
 * marquee, because the canvas's own mousedown never fires. Every interaction
 * stays with the canvas underneath, which already knows how to hit-test the
 * layer's box.
 *
 * ── WHY THIS IS A SIBLING OF THE CANVAS AND NOT PART OF IT ──────────────────
 * It renders immediately after `<canvas>` and carries no z-index, so it stacks
 * above the artwork by document order while the rulers (z-10/z-20) and the drop
 * affordance (z-30) stay above it. Layers stacked ABOVE the composition are not
 * painted by that canvas; `LayersAboveComposition` paints them over this frame,
 * so the layer order on screen is the layer order in the file. Canvas.tsx therefore gains one element and
 * nothing else — no new state, no change to the draw path — and the composition
 * machinery stays out of a 4,300-line component.
 *
 * WHAT A LIVE FRAME CANNOT HONOUR: blend mode. The frame composites against the
 * page, not against the layers below it, so a multiply that is correct in the
 * export could not be correct here. Opacity and rotation are applied because
 * they can be. That gap is the honest limit of an overlay, and it is exactly why
 * the design keeps a bitmap as the layer's real content instead of making the
 * frame the layer.
 */
export function CompositionOverlay({ containerWidth, containerHeight }: CompositionOverlayProps) {
  const { project, selectedArtboardId, selectedLayerIds } = useProjectStore();
  const { zoom, panX, panY } = useUIStore();

  const mountRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<CompositionHost | null>(null);
  const [failed, setFailed] = useState('');

  const artboard = project?.artboards.find((a) => a.id === selectedArtboardId);

  const viewport: Viewport = {
    canvasWidth: containerWidth,
    canvasHeight: containerHeight,
    zoom,
    panX,
    panY,
  };

  const live: CompositionLayerRef | null = liveCompositionFor(project, artboard, viewport, selectedLayerIds);

  /**
   * The frame is rebuilt when the COMPOSITION changes, never when the view does.
   *
   * Pan and zoom move an existing frame with a transform. Rebuilding on those
   * would restart the animation and re-run the settle wait on every click of the
   * scroll wheel — a slide that flickers back to its first frame while you look
   * at it. So the effect depends on an identity string over the composition's
   * own inputs, and the source is read through a ref rather than closed over:
   * the store hands back a new object on every unrelated edit, and a dependency
   * on that reference would rebuild the frame when a neighbouring layer moved.
   */
  const identity = liveFrameIdentity(live);
  const sourceRef = useRef<CompositionSource | null>(null);
  sourceRef.current = live?.source ?? null;

  useEffect(() => {
    const mount = mountRef.current;
    const source = sourceRef.current;
    if (!mount || !source) return;

    let cancelled = false;
    setFailed('');

    void (async () => {
      const resolved = await resolveComposition(source);
      /**
       * The identity may have moved on while the block was being fetched — the
       * user selected another slide, or edited a slot. A frame built from an
       * answer nobody is waiting for is a leaked iframe AND a document animating
       * over the wrong layer, so the flag is checked on both sides of the build.
       */
      if (cancelled) return;
      if (!resolved) {
        setFailed(
          source.block
            ? `Could not load the block "${source.block}".`
            : 'This composition has no block and no html.',
        );
        return;
      }

      const prepared = prepareFromSource(resolved.html, source, resolved.manifest);
      const host = new CompositionHost(mount, {
        html: prepared.html,
        frameWidth: prepared.width,
        frameHeight: prepared.height,
      });
      hostRef.current = host;
      void host.mount();
      if (cancelled) {
        host.destroy();
        hostRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
      hostRef.current?.destroy();
      hostRef.current = null;
    };
  }, [identity]);

  if (!live || !artboard) return null;

  const placement = compositionPlacement(viewport, artboard.size, live.rect, {
    width: live.source.frameWidth,
    height: live.source.frameHeight,
  });
  const transform = project?.layers[live.layerId]?.transform;

  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: placement.left,
        top: placement.top,
        /**
         * The layer's box on screen. The document inside is laid out at its own
         * frame size and scaled into this, so a composition whose frame is a
         * different shape from its layer is CLIPPED here — the same thing the
         * canvas does to an image layer, rather than bleeding over its
         * neighbours.
         */
        width: live.rect.width * zoom,
        height: live.rect.height * zoom,
        overflow: 'hidden',
        transform: transform?.rotation ? `rotate(${transform.rotation}deg)` : undefined,
        opacity: transform?.opacity ?? 1,
      }}
      data-composition-layer={live.layerId}
    >
      {/* Scaling the WRAPPER rather than the iframe keeps this declarative: the
          frame keeps the size it was laid out at, React owns the transform, and
          nothing has to reach into the host's element on every pan. */}
      <div ref={mountRef} style={{ transform: `scale(${placement.scale})`, transformOrigin: '0 0' }} />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-destructive/10 p-3 text-center text-[11px] text-destructive">
          {failed}
        </div>
      )}
    </div>
  );
}
