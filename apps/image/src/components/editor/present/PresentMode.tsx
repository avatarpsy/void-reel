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
 * A page whose visible content is a single designed block is mounted as a LIVE
 * frame — that is a deck slide, and it should animate. Anything else is drawn
 * from the same renderer the export uses, because a page with hand-drawn layers
 * on it has no single document to run and a still of it is exactly right.
 *
 * Predictable beats clever: one condition, and you can tell by looking at the
 * page which branch it will take.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X, Maximize2, Minimize2 } from 'lucide-react';
import { useProjectStore } from '../../../stores/project-store';
import { exportArtboard } from '../../../services/export-service';
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
 * The single block a page is made of, or null.
 *
 * "Made of" is strict on purpose — one visible layer, and it is a composition
 * that fills the page. A block with a logo dropped on top is no longer a
 * document that can be run on its own, and running it would drop the logo.
 */
export function soleComposition(project: Project, artboard: Artboard): ImageLayer | null {
  const visible = artboard.layerIds
    .map((id) => project.layers[id])
    .filter((l) => l && l.visible !== false);
  if (visible.length !== 1) return null;
  const only = visible[0] as ImageLayer;
  if (!only.composition) return null;
  const { x, y, width, height } = only.transform;
  const coversPage =
    Math.abs(x) < 2
    && Math.abs(y) < 2
    && Math.abs(width - artboard.size.width) < 2
    && Math.abs(height - artboard.size.height) < 2;
  return coversPage ? only : null;
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
  const [stillUrl, setStillUrl] = useState<string>('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);

  const rootRef = useRef<HTMLDivElement>(null);
  const frameMountRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<CompositionHost | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = artboards[index];
  const live = project && current ? soleComposition(project, current) : null;

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
  useEffect(() => {
    let cancelled = false;
    hostRef.current?.destroy();
    hostRef.current = null;
    setStillUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return ''; });

    if (!project || !current) return undefined;

    void (async () => {
      if (live?.composition) {
        const resolved = await resolveComposition(live.composition);
        if (cancelled || !resolved || !frameMountRef.current) return;
        const prepared = prepareFromSource(resolved.html, live.composition, resolved.manifest, {
          // The whole reason this screen exists: let the entrance play.
          poseTime: 'live',
        });
        const host = new CompositionHost(frameMountRef.current, {
          html: prepared.html,
          frameWidth: prepared.width,
          frameHeight: prepared.height,
        });
        hostRef.current = host;
        void host.mount();
        if (cancelled) { host.destroy(); hostRef.current = null; }
        return;
      }

      // Not a single-block page: draw it exactly as the export would.
      const blob = await exportArtboard(project, current, {
        scale: 1, format: 'png', quality: 1, background: true,
      } as any).catch(() => null);
      if (cancelled || !blob) return;
      setStillUrl(URL.createObjectURL(blob));
    })();

    return () => {
      cancelled = true;
      hostRef.current?.destroy();
      hostRef.current = null;
    };
    // `live` is derived from project+current, so those two are the real inputs.
  }, [project, current, live]);

  useEffect(() => () => { if (stillUrl) URL.revokeObjectURL(stillUrl); }, [stillUrl]);

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
        {live ? (
          <div
            ref={frameMountRef}
            className="origin-top-left"
            style={{
              width: current.size.width,
              height: current.size.height,
              transform: `scale(${scale})`,
            }}
          />
        ) : stillUrl ? (
          <img src={stillUrl} alt={current.name} className="w-full h-full object-contain" />
        ) : null}
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
