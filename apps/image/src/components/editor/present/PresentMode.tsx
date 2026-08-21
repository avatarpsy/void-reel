/**
 * Show the deck.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The product's promise is a presentation you give from your laptop, and until
 * this there was no way to give one. Export produced a file to open in
 * something else; the editor showed a canvas with panels down both sides. The
 * last step of the job happened in another application.
 *
 * It also fixes a quieter hole. A slide can declare an entrance animation, and
 * the animation had no playback surface anywhere: the canvas overlay poses
 * every frame to its end so stills stay repeatable, page thumbnails are baked
 * images, and every export format is static. You could set an animation and
 * never once see it. Here the frame is mounted `live`, so a slide plays exactly
 * as it will when somebody is watching.
 *
 * ── THE RULE FOR WHAT GETS DRAWN ─────────────────────────────────────────────
 * EVERY designed block on the slide runs as its own live document; the ordinary
 * layers between them are drawn with the same renderer the export uses, grouped
 * into runs so the stacking order survives. See `presentPieces`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X, Maximize2, Minimize2 } from 'lucide-react';
import { useProjectStore } from '../../../stores/project-store';
import { renderLayersToDataURL } from '../../../services/export-service';
import { resolveComposition } from '../../../services/composition/block-source';
import { prepareFromSource } from '../../../services/composition/document';
import { CompositionHost } from '../../../services/composition/frame-host';
import type { Artboard, ImageLayer, Project } from '../../../types/project';

interface PresentModeProps {
  onClose: () => void;
  /** Page to open on, so presenting starts where the user was working. */
  startArtboardId?: string | null;
}

/**
 * One drawable piece of a slide, in z-order.
 *
 * `live` is a block, running as its own document so its entrance plays.
 * `raster` is a RUN of ordinary layers — text, photos, shapes — drawn together
 * into one image.
 */
export type PresentPiece =
  | { kind: 'live'; layerId: string }
  | { kind: 'raster'; layerIds: string[] };

/**
 * How to draw a slide, piece by piece.
 *
 * ── WHY THIS REPLACED "IS THIS PAGE ONE BLOCK?" ──────────────────────────────
 * The first version ran a live frame only when the page was EXACTLY one
 * full-page composition, and drew a flat still for anything else. That is fine
 * for a deck the agent built and wrong the moment a person touches it: drop a
 * logo onto a slide, or add a second block, and the slide silently stopped
 * animating — with nothing to say why, because a still of a posed block looks
 * very like the finished frame of an animated one. Reported from a real slide
 * with a block plus a graphic on it.
 *
 * So every composition on the page runs, and the ordinary layers between them
 * are grouped into runs and rasterised. Splitting into RUNS rather than one
 * image per layer is what preserves z-order exactly: a logo above the first
 * block and below the second stays there.
 *
 * ── THE ORDER IS TOP-FIRST ───────────────────────────────────────────────────
 * `artboard.layerIds` holds the TOP layer at index 0 — the canvas reverses it
 * before painting, and every add inserts at 0 so new work lands on top. Pieces
 * come out in that same order, so piece 0 is the frontmost and the renderer
 * gives it the highest z-index. Reading the array as bottom-to-top stacks the
 * slide upside-down, which is exactly how a block placed onto a slide ended up
 * hidden behind it.
 */
export function presentPieces(project: Project, artboard: Artboard): PresentPiece[] {
  const pieces: PresentPiece[] = [];
  for (const id of artboard.layerIds) {
    const layer = project.layers[id];
    if (!layer || layer.visible === false) continue;

    if ((layer as ImageLayer).composition) {
      pieces.push({ kind: 'live', layerId: id });
      continue;
    }

    const last = pieces[pieces.length - 1];
    if (last && last.kind === 'raster') last.layerIds.push(id);
    else pieces.push({ kind: 'raster', layerIds: [id] });
  }
  return pieces;
}

/** Scale that fits a slide into the viewport, letterboxed, allowed to enlarge. */
export function presentScale(
  slide: { width: number; height: number },
  view: { width: number; height: number },
): number {
  if (!(slide.width > 0) || !(slide.height > 0)) return 1;
  if (!(view.width > 0) || !(view.height > 0)) return 1;
  // Unlike the canvas overlay this MAY scale past 1: a 1920×1080 deck on a
  // larger display should fill it, which is the entire point of presenting.
  return Math.min(view.width / slide.width, view.height / slide.height);
}

export function PresentMode({ onClose, startArtboardId }: PresentModeProps) {
  const project = useProjectStore((s) => s.project);
  const artboards = useMemo(() => project?.artboards ?? [], [project]);

  const startIndex = Math.max(0, artboards.findIndex((a) => a.id === startArtboardId));
  const [index, setIndex] = useState(startIndex);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);

  const rootRef = useRef<HTMLDivElement>(null);
  /** One live frame per composition layer, and the node each mounts into. */
  const hostsRef = useRef<Map<string, CompositionHost>>(new Map());
  const mountsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = artboards[index];
  const pieces = useMemo(
    () => (project && current ? presentPieces(project, current) : []),
    [project, current],
  );
  /** Raster pieces, drawn once per slide and keyed by their position in the stack. */
  const [rasters, setRasters] = useState<Record<number, string>>({});

  const [view, setView] = useState({ width: 1, height: 1 });
  useEffect(() => {
    const measure = () => setView({ width: window.innerWidth, height: window.innerHeight });
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const scale = current ? presentScale(current.size, view) : 1;

  const go = useCallback((delta: number) => {
    setIndex((i) => Math.min(artboards.length - 1, Math.max(0, i + delta)));
  }, [artboards.length]);

  /**
   * Chrome hides itself while presenting and comes back on any pointer move.
   * A control strip sitting over somebody's slide during a talk is the thing
   * that makes home-made decks look home-made.
   */
  const wakeChrome = useCallback(() => {
    setChromeVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setChromeVisible(false), 2400);
  }, []);

  useEffect(() => {
    wakeChrome();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [wakeChrome]);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': case ' ': case 'PageDown': case 'Enter':
          e.preventDefault(); go(1); wakeChrome(); break;
        case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace':
          e.preventDefault(); go(-1); wakeChrome(); break;
        case 'Home': e.preventDefault(); setIndex(0); wakeChrome(); break;
        case 'End': e.preventDefault(); setIndex(artboards.length - 1); wakeChrome(); break;
        case 'Escape':
          // Browsers leave fullscreen on Escape themselves; closing as well
          // would exit presenting on the keypress meant to leave fullscreen.
          if (!document.fullscreenElement) onClose();
          break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose, artboards.length, wakeChrome]);

  // ── Fullscreen ────────────────────────────────────────────────────────────
  /**
   * PRESENTING GOES FULL SCREEN BY ITSELF.
   *
   * The editor runs inside an iframe on the website, so an overlay that is
   * merely `fixed inset-0` covers the editor pane and leaves the chat column
   * and the site's own sidebar on screen beside the slide. That is not
   * presenting, and asking the user to find a second button to make it so is
   * exactly the kind of step this product should not have.
   *
   * Requested on mount rather than from the Present button because the overlay
   * element does not exist until now; the click is still within the browser's
   * transient activation window, which is what makes the request legal.
   *
   * If it is refused — an embedding without the permission, or a browser that
   * has decided the gesture expired — presenting continues in the pane, and the
   * toggle in the corner is still there. `autoEntered` tracks whether we were
   * the ones who asked, so leaving fullscreen only ends the presentation when
   * entering it began one.
   */
  const autoEntered = useRef(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el?.requestFullscreen) return;
    el.requestFullscreen()
      .then(() => { autoEntered.current = true; })
      .catch(() => { autoEntered.current = false; });
  }, []);

  useEffect(() => {
    const sync = () => {
      const on = !!document.fullscreenElement;
      setIsFullscreen(on);
      // Escape leaves fullscreen before any keydown handler sees it, so this is
      // the only place that can treat "left fullscreen" as "done presenting".
      if (!on && autoEntered.current) {
        autoEntered.current = false;
        onClose();
      }
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [onClose]);

  // Leaving by any other route (the X, or Escape while not fullscreen) should
  // not stay fullscreen behind an editor nobody is presenting from.
  useEffect(() => () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    // Failures are swallowed: some embeddings refuse fullscreen outright, and
    // presenting in the pane still works.
    if (document.fullscreenElement) {
      // Asked for by hand, so leaving must NOT end the presentation — only the
      // automatic entry on mount carries that meaning.
      autoEntered.current = false;
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen?.().catch(() => {});
    }
  }, []);

  // ── The slide itself ──────────────────────────────────────────────────────
  /**
   * Every composition on the slide runs; the ordinary layers between them are
   * drawn as images. Both halves are rebuilt whenever the slide changes, and
   * every frame is torn down on the way out — a live document left mounted
   * behind the next slide keeps animating and keeps its memory.
   */
  useEffect(() => {
    let cancelled = false;
    for (const h of hostsRef.current.values()) h.destroy();
    hostsRef.current.clear();
    setRasters({});

    if (!project || !current) return undefined;

    void (async () => {
      for (const [i, piece] of pieces.entries()) {
        if (cancelled) return;

        if (piece.kind === 'raster') {
          const url = await renderLayersToDataURL(
            project, piece.layerIds, current.size.width, current.size.height,
          ).catch(() => '');
          if (cancelled || !url) continue;
          setRasters((prev) => ({ ...prev, [i]: url }));
          continue;
        }

        const layer = project.layers[piece.layerId] as ImageLayer | undefined;
        const source = layer?.composition;
        const mount = mountsRef.current.get(piece.layerId);
        if (!source || !mount) continue;

        const resolved = await resolveComposition(source);
        if (cancelled || !resolved) continue;
        const prepared = prepareFromSource(resolved.html, source, resolved.manifest, {
          // The whole reason this screen exists: let the entrance play.
          poseTime: 'live',
        });
        const host = new CompositionHost(mount, {
          html: prepared.html,
          frameWidth: prepared.width,
          frameHeight: prepared.height,
        });
        hostsRef.current.set(piece.layerId, host);
        void host.mount();
        if (cancelled) { host.destroy(); hostsRef.current.delete(piece.layerId); }
      }
    })();

    return () => {
      cancelled = true;
      for (const h of hostsRef.current.values()) h.destroy();
      hostsRef.current.clear();
    };
  }, [project, current, pieces]);

  if (!project || !current) return null;

  const atStart = index === 0;
  const atEnd = index === artboards.length - 1;

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[100] bg-black flex items-center justify-center select-none"
      onMouseMove={wakeChrome}
      style={{ cursor: chromeVisible ? 'default' : 'none' }}
    >
      {/* The slide, letterboxed. */}
      <div
        className="relative overflow-hidden"
        style={{
          width: current.size.width * scale,
          height: current.size.height * scale,
          backgroundColor:
            current.background.type === 'color' ? current.background.color : '#000000',
        }}
      >
        {/* The slide's pieces, stacked in the page's own z-order. Absolutely
            positioned rather than flowed, so a block and the graphic over it
            land exactly where the canvas puts them. */}
        {pieces.map((piece, i) => {
          if (piece.kind === 'raster') {
            const url = rasters[i];
            return url ? (
              <img
                key={`raster-${i}`}
                src={url}
                alt=""
                className="absolute inset-0 w-full h-full"
                style={{ zIndex: pieces.length - i }}
              />
            ) : null;
          }

          const layer = project.layers[piece.layerId] as ImageLayer | undefined;
          if (!layer) return null;
          const box = layer.transform;
          const frameW = layer.composition?.frameWidth || box.width || current.size.width;
          const frameH = layer.composition?.frameHeight || box.height || current.size.height;
          // The document lays out at its own frame, then scales into the box the
          // layer occupies — the same two-step the canvas overlay uses, so a
          // block presents at the size it was designed and placed at.
          const fit = Math.min(box.width / Math.max(1, frameW), box.height / Math.max(1, frameH));
          return (
            <div
              key={piece.layerId}
              className="absolute origin-top-left"
              style={{
                left: box.x * scale,
                top: box.y * scale,
                width: frameW,
                height: frameH,
                transform: `scale(${fit * scale})`,
                opacity: box.opacity ?? 1,
                zIndex: pieces.length - i,
              }}
              ref={(el) => {
                if (el) mountsRef.current.set(piece.layerId, el);
                else mountsRef.current.delete(piece.layerId);
              }}
            />
          );
        })}
      </div>

      {/* Click targets: the halves of the screen, which is how every other
          presenter behaves and needs no explaining. */}
      <button
        aria-label="Previous slide"
        onClick={() => go(-1)}
        disabled={atStart}
        className="absolute inset-y-0 left-0 w-1/3 cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
      />
      <button
        aria-label="Next slide"
        onClick={() => go(1)}
        disabled={atEnd}
        className="absolute inset-y-0 right-0 w-1/3 cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
      />

      {/* Chrome. Fades rather than moving, so nothing shifts under the cursor. */}
      <div
        className={`absolute inset-x-0 bottom-0 flex items-center justify-between px-5 py-4 transition-opacity duration-300 ${
          chromeVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.55), transparent)' }}
      >
        <div className="flex items-center gap-1">
          <button
            onClick={() => go(-1)}
            disabled={atStart}
            aria-label="Previous slide"
            className="p-2 rounded-md text-white/80 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            onClick={() => go(1)}
            disabled={atEnd}
            aria-label="Next slide"
            className="p-2 rounded-md text-white/80 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronRight size={20} />
          </button>
          <span className="ml-2 text-sm text-white/70 tabular-nums">
            {index + 1} / {artboards.length}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Leave fullscreen' : 'Fullscreen'}
            className="p-2 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors"
          >
            {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <button
            onClick={onClose}
            aria-label="Exit presenting"
            className="p-2 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
