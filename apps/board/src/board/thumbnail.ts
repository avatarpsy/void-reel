/**
 * Board preview thumbnails — a small, honest snapshot of what a board holds.
 *
 * ── WHY THIS IS DRAWN, NOT SCREENSHOTTED ────────────────────────────────────
 * The obvious thing is a raster capture of the canvas, the way Canva or Figma
 * show a page preview. That does not work here, and it is worth writing down so
 * nobody spends a day rediscovering it:
 *
 *   1. Shots are `GfxBlockComponent`s — DOM custom elements with SHADOW ROOTS,
 *      not canvas primitives. `surfaceCanvas.toDataURL()` returns a board with
 *      every shot missing. BlockSuite 0.22.4 ships no `edgelessToCanvas`;
 *      that helper lives in the AFFiNE app, not the published packages.
 *   2. A DOM serialiser (html-to-image et al) would have to walk those shadow
 *      roots AND fetch every media reference on the board through a
 *      CORS-permitted path to avoid tainting the canvas. On a board with thirty
 *      references that is thirty image downloads to draw a 480px tile — the
 *      exact "loads the servers, wastes memory" cost a preview must not have.
 *   3. Capturing "the whole board" means zooming to fit and restoring, which
 *      the user sees as a flicker on every save.
 *
 * So the preview is DRAWN from the board's own structured data, which the app
 * already holds in memory. It costs no network, no DOM walk, and single-digit
 * milliseconds. And because shots lay out as a filmstrip of uniform cards
 * (`shotBounds`: x = order * (SHOT_W + SHOT_GAP), y = 0), a row of cards is not
 * an abstraction of the board — it is what the board actually looks like.
 *
 * Media is drawn when, and only when, it loads cleanly cross-origin. A denied
 * CORS request fires `onerror`, we skip that image, and the canvas is never
 * tainted — so `toDataURL` cannot throw and the preview degrades to the card
 * treatment instead of failing.
 */

/** 16:9, matching the Studio tile. Small on purpose: this is a tile, not an export. */
const W = 480;
const H = 270;

/** Cards drawn at most. Beyond this the strip reads as texture, not content. */
const MAX_CARDS = 6;

/**
 * PNG, not JPEG — the sheet is transparent so the tile's own themed backdrop
 * shows through, and JPEG has no alpha channel. Flat card fills compress well;
 * measured well under the endpoint's 400KB ceiling.
 */

/** How long a single media image gets before the preview goes on without it. */
const IMAGE_TIMEOUT_MS = 1500;

export interface ThumbShot {
  title: string;
  /** First usable media URL, or '' — the caller decides what "usable" means. */
  mediaUrl: string;
  kind: string;
}

export interface ThumbnailOptions {
  shots: ThumbShot[];
  /** Board title, drawn as the strip's caption when there are no shots. */
  title?: string;
}

/**
 * Load an image for compositing, or resolve null.
 *
 * `crossOrigin = 'anonymous'` is what keeps the canvas untainted. If the host
 * does not return CORS headers the load FAILS rather than succeeding-and-
 * tainting, which is the behaviour we want: a missing image costs us a card
 * background, a tainted canvas costs us the whole thumbnail.
 */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    if (!url || !/^https:\/\//i.test(url)) { resolve(null); return; }
    const img = new Image();
    let settled = false;
    const done = (v: HTMLImageElement | null) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), IMAGE_TIMEOUT_MS);
    img.crossOrigin = 'anonymous';
    img.onload = () => { clearTimeout(timer); done(img); };
    img.onerror = () => { clearTimeout(timer); done(null); };
    img.src = url;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw `img` into the box as object-fit: cover, clipped to the current path. */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/**
 * Hue per card, spread across the brand band.
 *
 * The same 205..275 range `StudioThumb` uses for its placeholder gradients, so
 * a board preview and a board placeholder look like they came from one system.
 */
function cardHue(i: number): number {
  return 205 + ((i * 37) % 70);
}

/**
 * Render the preview. Returns a JPEG data URL, or '' if there is nothing worth
 * showing — an empty board keeps its designed placeholder rather than getting a
 * picture of nothing.
 */
export async function renderBoardThumbnail(opts: ThumbnailOptions): Promise<string> {
  const shots = (opts.shots || []).slice(0, MAX_CARDS);
  if (!shots.length) return '';

  /**
   * ── NO BACKDROP. THE TILE PROVIDES IT. ──────────────────────────────────
   * Two earlier attempts were both wrong:
   *
   *   1. Theme-aware at render time. A preview is rendered ONCE and STORED, so
   *      it cannot track a theme the viewer changes later, and boards saved
   *      under different themes sat side by side looking like different
   *      products.
   *   2. A fixed dark backdrop, on the reasoning that these tiles sit beside
   *      video stills and image covers. But those are PHOTOGRAPHS and this is
   *      synthesised — a dark slab next to the pale placeholder tiles reads as
   *      out of place on a light page, which is exactly what it looked like.
   *
   * A synthesised preview should not be imposing a page colour at all. The
   * canvas is left TRANSPARENT and only the cards are drawn, so the letterbox
   * behind them is `.studio-thumb`'s own background — which IS theme-aware.
   * One stored image, correct in both modes, and nothing to regenerate.
   *
   * This is why the output is PNG: JPEG has no alpha channel.
   *
   * The cards themselves are mid-tone (45% lightness) rather than dark or pale,
   * so they hold their own against both backdrops, and their labels are white
   * with a scrim — legible on either.
   */
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Fetch every image up front so the draw loop is synchronous and ordered.
  // They are independent, so this is one wall-clock wait, not N.
  const images = await Promise.all(shots.map(s => loadImage(s.mediaUrl)));

  // ── contact-sheet geometry ──
  // Cards are laid out in reading order — the board's own filmstrip order — but
  // WRAPPED into a grid rather than a single row.
  //
  // A single row was the first attempt and it looked wrong: six cards across a
  // 480px tile are 70px wide and full height, which reads as a barcode rather
  // than a storyboard. Choosing columns by count keeps every card roughly
  // card-shaped at any board size, which is what makes the tile legible.
  const PAD = 14;
  const GAP = 8;
  const n = shots.length;
  const cols = n <= 3 ? n : n === 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const cardW = (W - PAD * 2 - GAP * (cols - 1)) / cols;
  const cardH = (H - PAD * 2 - GAP * (rows - 1)) / rows;

  shots.forEach((shot, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Centre a short final row (5 shots in a 3-wide grid) so the sheet stays
    // balanced instead of hanging a gap off the right edge.
    const inRow = Math.min(cols, n - row * cols);
    const rowOffset = ((cols - inRow) * (cardW + GAP)) / 2;
    const x = PAD + rowOffset + col * (cardW + GAP);
    const y = PAD + row * (cardH + GAP);
    const hue = cardHue(i);

    ctx.save();
    roundRect(ctx, x, y, cardW, cardH, 8);
    ctx.clip();

    const img = images[i];
    if (img) {
      drawCover(ctx, img, x, y, cardW, cardH);
      // Scrim so the title strip stays legible over any image.
      const scrim = ctx.createLinearGradient(0, y + cardH * 0.45, 0, y + cardH);
      scrim.addColorStop(0, 'rgba(0,0,0,0)');
      scrim.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = scrim;
      ctx.fillRect(x, y, cardW, cardH);
    } else {
      // No usable image: a tinted panel plus text lines, which reads as "a card
      // with writing on it" — what an unillustrated shot actually is.
      const panel = ctx.createLinearGradient(x, y, x, y + cardH);
      // Mid-tone, so the card holds against a near-black tile AND a pale one.
      panel.addColorStop(0, `hsl(${hue} 42% 52%)`);
      panel.addColorStop(1, `hsl(${hue + 8} 44% 38%)`);
      ctx.fillStyle = panel;
      ctx.fillRect(x, y, cardW, cardH);

      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      const lineX = x + 10;
      const lineW = cardW - 20;
      [0.42, 0.54, 0.66].forEach((t, li) => {
        const w = lineW * (li === 2 ? 0.6 : 1);
        ctx.fillRect(lineX, y + cardH * t, Math.max(w, 4), 4);
      });
    }

    // Title strip. Drawn for every card so the strip reads as content even when
    // the images did load.
    const label = (shot.title || '').trim();
    if (label) {
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = '600 11px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.textBaseline = 'alphabetic';
      // Ellipsise by measurement — a clipped glyph looks like a rendering bug.
      let text = label;
      const maxW = cardW - 16;
      if (ctx.measureText(text).width > maxW) {
        while (text.length > 1 && ctx.measureText(`${text}…`).width > maxW) text = text.slice(0, -1);
        text = `${text}…`;
      }
      if (!img) {
        // On a tinted panel the text needs its own contrast, not the scrim's.
        ctx.fillStyle = 'rgba(255,255,255,0.96)';
      }
      ctx.fillText(text, x + 8, y + cardH - 10);
    }

    ctx.restore();

    // Hairline border, matching the tile treatment elsewhere in Studio.
    // Neutral hairline that reads on either backdrop.
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, cardW - 1, cardH - 1, 8);
    ctx.stroke();
  });

  // "+N" when the board runs past what the strip shows, so a big board does not
  // masquerade as a six-shot one.
  const extra = (opts.shots?.length ?? 0) - shots.length;
  if (extra > 0) {
    const badge = `+${extra}`;
    ctx.font = '700 13px system-ui, -apple-system, Segoe UI, sans-serif';
    const tw = ctx.measureText(badge).width;
    const bw = tw + 16;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    roundRect(ctx, W - PAD - bw, H - PAD - 24, bw, 20, 10);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(badge, W - PAD - bw + 8, H - PAD - 10);
  }

  // Untainted by construction (see loadImage), so this cannot throw. Guarded
  // anyway: a preview is never worth breaking a save over.
  try { return canvas.toDataURL('image/png'); }
  catch { return ''; }
}
