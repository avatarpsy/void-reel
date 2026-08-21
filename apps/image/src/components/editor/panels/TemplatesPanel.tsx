/**
 * Browse the designed blocks, and put one on the page.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * A hundred and twenty-odd designed blocks ship with the app, and they are the
 * whole reason a generated deck looks designed rather than typed. Until this
 * panel there was NO way to reach them except by asking the agent in chat: no
 * list, no preview, no click-to-place. Somebody who preferred to work by hand —
 * or who just wanted slide 4 to be a different layout without holding a
 * conversation about it — had to draw it from rectangles and text boxes, and
 * would get a visibly worse slide. The library was the product's best asset and
 * it was invisible.
 *
 * ── WHY "TEMPLATES" AND NOT "BLOCKS" ─────────────────────────────────────────
 * "Block" is our word for the file. "Template" is the word everybody already
 * has for a designed layout you drop your own words into, from every other
 * tool they have used. The panel is named for what it does, not for how it is
 * built.
 *
 * ── PREVIEWS ARE LIVE, AND LAZY ──────────────────────────────────────────────
 * A name and a slot count does not tell anybody whether a layout is the right
 * one — these are designs, and you choose a design by looking at it. So each
 * card mounts the real document, filled with the designer's samples. Mounting
 * 124 of them at once would be absurd, so a card only builds its frame when it
 * scrolls into view, and gives it back when it leaves.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, LayoutTemplate, Loader2 } from 'lucide-react';
import { useProjectStore } from '../../../stores/project-store';
import { loadBlock } from '../../../services/composition/block-source';
import { prepareComposition } from '../../../services/composition/document';
import { CompositionHost } from '../../../services/composition/frame-host';
import { bakeComposition } from '../../../services/composition/bake';
import { getVoidspaceIdToken } from '../../../services/voidspace-storage';
import type { ImageLayer } from '../../../types/project';

interface BlockRow {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  aspects?: string[];
  nativeSize?: string;
  tier?: string;
}

/** "1920x1080" → 1.777…, or null when a block does not declare one. */
function nativeAspect(row: BlockRow): number | null {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(row.nativeSize ?? ''));
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

/** "16:9" → 1.777… */
function ratioOf(aspect: string): number | null {
  const m = /^(\d+)\s*:\s*(\d+)$/.exec(aspect.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

/**
 * Does this block suit the page being designed?
 *
 * A block declares the aspects it was built for. Showing a 9:16 story layout
 * to somebody building a 16:9 deck is not merely untidy — they will place it,
 * it will lay out wrong, and they will conclude the templates are broken.
 *
 * A block that declares nothing is kept: silence is not a refusal, and hiding
 * an unlabelled block is worse than showing one that might not fit.
 */
export function suitsPage(row: BlockRow, pageAspect: number): boolean {
  const declared = (row.aspects ?? []).map(ratioOf).filter((r): r is number => r !== null);
  if (!declared.length) {
    const native = nativeAspect(row);
    return native === null ? true : Math.abs(native - pageAspect) < 0.2;
  }
  // 12% tolerance: 16:9 (1.778) and 1920×1080 pages are the same thing, and
  // 4:3 (1.333) must not match 16:9.
  return declared.some((r) => Math.abs(r - pageAspect) / pageAspect < 0.12);
}

/**
 * The categories present in a list, most useful first.
 *
 * 133 templates in one undifferentiated column is a list nobody reads to the
 * bottom of — the deck layouts, which are the whole reason somebody building a
 * presentation opened this panel, sat below "Apple money count". Chips turn the
 * library into something you can narrow in one click.
 *
 * Ordered by how many templates each holds, so the chips a user is most likely
 * to want are the ones nearest the search box.
 */
export function categoriesOf(rows: BlockRow[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const c = String(r.category ?? '').trim();
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
}

/**
 * The category to open on.
 *
 * A 16:9 page is a slide, and somebody who just made one wants slide layouts —
 * so if the library has a category for them, start there rather than at the top
 * of an alphabet. Every other shape opens on everything, because there is no
 * equally obvious answer and guessing wrong is worse than not guessing.
 */
export function defaultCategory(rows: BlockRow[], pageAspect: number): string {
  const isSlideShaped = Math.abs(pageAspect - 16 / 9) / (16 / 9) < 0.12;
  if (!isSlideShaped) return '';
  const deck = categoriesOf(rows).find((c) => /^deck$/i.test(c));
  return deck ?? '';
}

/** Case-insensitive match over the words a person would actually type. */
export function matchesQuery(row: BlockRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [row.name, row.description, row.category, ...(row.tags ?? [])]
    .filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/** "deck-two-column" → "Two column". The file name is not a label. */
export function prettyName(name: string): string {
  const withoutCategory = String(name).replace(/^(deck|social|title|lower|stat|quote)-/i, '');
  const words = withoutCategory.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

// ── One card ────────────────────────────────────────────────────────────────

function TemplateCard({
  row,
  pageWidth,
  pageHeight,
  onPlace,
}: {
  row: BlockRow;
  pageWidth: number;
  pageHeight: number;
  onPlace: (name: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<CompositionHost | null>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * Build the preview only once the card is on screen, and give it back when it
   * leaves: 130-odd live documents at once would make the panel unusable.
   *
   * ── WHY THERE IS A FALLBACK ─────────────────────────────────────────────────
   * IntersectionObserver is driven by rendering updates, and a browser suspends
   * those in a background tab — so in a tab that is not on screen no callback
   * ever arrives and EVERY card stays blank. That is not hypothetical: it is how
   * this panel behaved the first time it was opened in a hidden tab, and it
   * matters here because the editor is routinely driven from the desktop app
   * with the browser behind it.
   *
   * So the observer is the fast path and a direct geometry check is the
   * guarantee. The check runs once, shortly after mount, and only turns a card
   * ON — it can never hide one the observer has already shown.
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(
        (entries) => entries.forEach((e) => setVisible(e.isIntersecting)),
        { rootMargin: '200px' },
      );
      io.observe(el);
    }

    const fallback = setTimeout(() => {
      const box = el.getBoundingClientRect();
      const withinViewport =
        box.bottom > -200
        && box.top < (window.innerHeight || document.documentElement.clientHeight) + 200;
      if (withinViewport) setVisible(true);
    }, 400);

    return () => { io?.disconnect(); clearTimeout(fallback); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!visible) {
      hostRef.current?.destroy();
      hostRef.current = null;
      return undefined;
    }
    void (async () => {
      const doc = await loadBlock(row.name);
      if (cancelled || !mountRef.current) return;
      if (!doc) { setFailed(true); return; }
      const prepared = prepareComposition(doc.html, {
        slots: doc.slots,
        values: {},
        // The designer's samples ARE the preview — an empty card shows nothing
        // and every template would look identical.
        fillMode: 'preview',
        poseTime: 'end',
        frameWidth: pageWidth,
        frameHeight: pageHeight,
      });
      const host = new CompositionHost(mountRef.current, {
        html: prepared.html,
        frameWidth: prepared.width,
        frameHeight: prepared.height,
      });
      hostRef.current = host;
      void host.mount();
      if (cancelled) { host.destroy(); hostRef.current = null; }
    })();
    return () => {
      cancelled = true;
      hostRef.current?.destroy();
      hostRef.current = null;
    };
  }, [visible, row.name, pageWidth, pageHeight]);

  // The card is a fixed width; the preview is the page scaled down into it.
  const CARD_W = 232;
  const scale = CARD_W / Math.max(1, pageWidth);

  return (
    <button
      type="button"
      onClick={() => onPlace(row.name)}
      className="group w-full text-left rounded-lg border border-border overflow-hidden bg-muted hover:border-primary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-colors"
      title={row.description || row.name}
    >
      <div
        ref={boxRef}
        className="relative overflow-hidden bg-black/40"
        style={{ width: '100%', height: pageHeight * scale }}
      >
        {failed ? (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
            Preview unavailable
          </div>
        ) : (
          <div
            ref={mountRef}
            className="origin-top-left pointer-events-none"
            style={{ width: pageWidth, height: pageHeight, transform: `scale(${scale})` }}
          />
        )}
        <div className="absolute inset-0 bg-primary/0 group-hover:bg-primary/10 transition-colors" />
      </div>
      <div className="px-2 py-1.5">
        <div className="text-xs font-medium truncate">{prettyName(row.name)}</div>
        {row.description && (
          <div className="text-[10px] text-muted-foreground line-clamp-2 leading-snug">
            {row.description}
          </div>
        )}
      </div>
    </button>
  );
}

// ── The panel ───────────────────────────────────────────────────────────────

export function TemplatesPanel() {
  const project = useProjectStore((s) => s.project);
  const selectedArtboardId = useProjectStore((s) => s.selectedArtboardId);
  const [rows, setRows] = useState<BlockRow[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('');
  // Only until the user touches a chip: after that the choice is theirs, and
  // re-deriving it on the next render would keep overriding them.
  const categoryChosen = useRef(false);

  const page = project?.artboards.find((a) => a.id === selectedArtboardId) ?? project?.artboards[0];
  const pageWidth = page?.size.width ?? 1080;
  const pageHeight = page?.size.height ?? 1080;
  const pageAspect = pageWidth / Math.max(1, pageHeight);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await getVoidspaceIdToken().catch(() => null);
        const res = await fetch('/api/studio/blocks', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ action: 'list' }),
        });
        const json = await res.json();
        if (cancelled) return;
        const list = Array.isArray(json?.blocks) ? (json.blocks as BlockRow[]) : [];
        setRows(list);
        if (!list.length) setError('No templates found on this machine.');
      } catch {
        if (!cancelled) { setRows([]); setError('Could not load templates.'); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Everything that fits this page — the pool the chips are counted from. */
  const fitting = useMemo(
    () => (rows ?? []).filter((r) => suitsPage(r, pageAspect)),
    [rows, pageAspect],
  );

  const categories = useMemo(() => categoriesOf(fitting), [fitting]);

  useEffect(() => {
    if (categoryChosen.current || !fitting.length) return;
    setCategory(defaultCategory(fitting, pageAspect));
  }, [fitting, pageAspect]);

  const shown = useMemo(
    () => fitting
      .filter((r) => !category || String(r.category ?? '') === category)
      .filter((r) => matchesQuery(r, query)),
    [fitting, category, query],
  );

  const chooseCategory = useCallback((next: string) => {
    categoryChosen.current = true;
    setCategory(next);
  }, []);

  const place = useCallback(async (name: string) => {
    const store = useProjectStore.getState();
    const current = store.project;
    const artboard = current?.artboards.find((a) => a.id === store.selectedArtboardId)
      ?? current?.artboards[0];
    if (!current || !artboard) return;

    const doc = await loadBlock(name);
    if (!doc) return;

    /**
     * Placed full-bleed, and laid out in the PAGE's frame.
     *
     * The frame is what the block lays out in, and laying out is not scaling: a
     * block given a smaller frame is a block designed smaller — different line
     * breaks, smaller type — then stretched. Same rule the agent's placement
     * follows, so a template dropped by hand and one placed in chat produce the
     * identical slide.
     */
    const layerId = store.addImageLayer('', {
      x: 0, y: 0, width: artboard.size.width, height: artboard.size.height,
    });
    useProjectStore.getState().updateLayer<ImageLayer>(layerId, {
      name: prettyName(name),
      composition: {
        block: name,
        tier: doc.tier,
        slots: {},
        fillMode: 'preview',
        poseTime: 'end',
        frameWidth: artboard.size.width,
        frameHeight: artboard.size.height,
        renderHash: '',
      },
    });
    // Pixels arrive a beat later; the live frame shows the design meanwhile.
    void bakeComposition(layerId).catch(() => {});
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-border shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates…"
            className="w-full pl-8 pr-2 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        {categories.length > 1 && (
          <div className="flex gap-1 mt-2 overflow-x-auto pb-0.5">
            {['', ...categories].map((c) => (
              <button
                key={c || 'all'}
                type="button"
                /**
                 * Scroll the ACTIVE chip into view. The strip scrolls sideways
                 * and a 16:9 page opens on "deck", which sits sixth — so the
                 * one chip that says what you are looking at was the one chip
                 * off the edge of the panel.
                 */
                ref={(el) => {
                  if (el && category === c) {
                    el.scrollIntoView({ block: 'nearest', inline: 'center' });
                  }
                }}
                onClick={() => chooseCategory(c)}
                className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] capitalize transition-colors ${
                  category === c
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground hover:text-foreground'
                }`}
              >
                {c || 'All'}
              </button>
            ))}
          </div>
        )}

        <p className="mt-2 text-[10px] text-muted-foreground">
          {/* Says WHY the list is what it is: without this, filtering by page
              shape looks like a short library rather than a relevant one. */}
          {rows === null
            ? 'Loading…'
            : `${shown.length} that fit this page — click one to add it.`}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {rows === null ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center px-4">
            <LayoutTemplate size={24} className="text-muted-foreground mb-2" />
            <p className="text-xs text-muted-foreground">
              {error || (query
                ? `Nothing matches “${query}”.`
                : 'No templates fit this page shape yet.')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {shown.map((row) => (
              <TemplateCard
                key={`${row.tier ?? 'starter'}:${row.name}`}
                row={row}
                pageWidth={pageWidth}
                pageHeight={pageHeight}
                onPlace={place}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
