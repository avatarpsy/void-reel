/**
 * A PICTURE OF THE BOARD, so the agent can actually look at it.
 *
 * ── WHY READING THE DOCUMENT IS NOT ENOUGH ───────────────────────────────────
 * `board_canvas_read` reports what exists: kinds, text, ids, boxes. That answers
 * "what is on the board" and cannot answer any of the questions people actually
 * ask about a board — is this laid out well, do these two references sit badly
 * together, which of these six frames is the one with the blue figure, does the
 * title collide with anything. Those are visual, and a list of rectangles is not
 * a picture.
 *
 * It matters most for the loop this board exists for: the user collects
 * references, says "use these", and the agent has to know what "these" LOOK
 * like. Reading `name: "hero-teammate-waves"` tells it a filename.
 *
 * ── HOW ──────────────────────────────────────────────────────────────────────
 * BlockSuite already rasterises the edgeless canvas for its own "copy as image"
 * — `EdgelessClipboardController.toCanvas()`, which composites the surface's
 * canvas elements AND runs html2canvas over the DOM blocks (notes, images, shot
 * cards). Using theirs means the screenshot shows what the user sees, including
 * every block type we render ourselves, and it stays right when we add another.
 *
 * The bytes never travel through the postMessage bridge. A full-board PNG is
 * megabytes, and the RPC channel carries plain data between two windows; the
 * board uploads it itself and passes back a url, which is also the form
 * `inspect_media` wants.
 */
import { EdgelessClipboardController } from '@blocksuite/affine/blocks/root';
import { GfxControllerIdentifier, type GfxModel } from '@blocksuite/std/gfx';

import type { MountedBoard } from '../blocksuite/editor';
import { defaultApiBase } from '@openreel/asset-browser';
import { getParentToken } from '../board/parent-auth';

export type ShotScope = 'viewport' | 'all' | 'selection';

export interface ScreenshotResult {
  url: string;
  width: number;
  height: number;
  /** How many elements are in frame — so the agent can tell "empty" from "failed". */
  items: number;
  scope: ShotScope;
}

/**
 * The long edge of the image we hand back.
 *
 * A vision model gains nothing from a 6000px board and pays for every pixel, so
 * the capture is scaled to fit this. Big enough that note text stays legible,
 * which is the thing most worth reading in a screenshot.
 */
const MAX_EDGE = 1600;

/** Blocks and canvas elements are handed to `toCanvas` separately. */
function split(models: GfxModel[]): {
  blocks: GfxModel[];
  elements: GfxModel[];
} {
  const blocks: GfxModel[] = [];
  const elements: GfxModel[] = [];
  for (const m of models) {
    // A block has a flavour; a canvas primitive (shape, brush, text, connector)
    // has a `type` instead. That is the same test BlockSuite's own layer code
    // uses to decide which list something belongs in.
    if ((m as unknown as { flavour?: string }).flavour) blocks.push(m);
    else elements.push(m);
  }
  return { blocks, elements };
}

function boundsOf(model: unknown): { x: number; y: number; w: number; h: number } | null {
  const raw = (model as { xywh?: string })?.xywh;
  if (typeof raw !== 'string') return null;
  try {
    const [x, y, w, h] = JSON.parse(raw) as number[];
    return { x, y, w, h };
  } catch {
    return null;
  }
}

/** Everything in frame, for the scope asked for. */
function subjectsFor(board: MountedBoard, scope: ShotScope): GfxModel[] {
  const gfx = board.std.get(GfxControllerIdentifier);
  const all = [...(gfx.gfxElements as GfxModel[])];

  if (scope === 'all') return all;

  if (scope === 'selection') {
    const ids = new Set(gfx.selection.selectedIds);
    return all.filter(m => ids.has((m as unknown as { id: string }).id));
  }

  // VIEWPORT — what the user is looking at right now, which is what they mean
  // when they ask "what do you see". Intersection, not containment: a shot card
  // half on screen is part of what is being looked at.
  const vb = gfx.viewport.viewportBounds;
  return all.filter(m => {
    const b = boundsOf(m);
    if (!b) return false;
    return b.x < vb.x + vb.w && b.x + b.w > vb.x && b.y < vb.y + vb.h && b.y + b.h > vb.y;
  });
}

/**
 * POINT html2canvas AT OUR PROXY, NOT AFFiNE'S.
 *
 * `_edgelessToCanvas` reads `std.clipboard.configs.get('imageProxy')` and hands
 * it to html2canvas as its `proxy`, with `useCORS: false` — so EVERY
 * cross-origin image on the board is fetched through whatever that says. Left
 * alone it says `https://affine-worker.toeverything.workers.dev/api/worker/
 * image-proxy`, AFFiNE's own public endpoint, which is wrong for us twice over:
 *
 *   • PRIVACY. Taking a screenshot would send the url of every picture on the
 *     user's board to a third party we have no relationship with. Those urls
 *     identify the user's bucket and their media.
 *
 *   • IT DOES NOT WORK ANYWAY. Measured against the built site: every image
 *     failed with "blocked by CORS policy: No 'Access-Control-Allow-Origin'
 *     header", so the screenshot came back with holes where the pictures were.
 *
 * Ours is same-origin, so no preflight and no third party, and it already
 * allow-lists exactly the hosts board media lives on. html2canvas appends
 * `?url=<encoded>&responseType=blob` and reads the response as a blob — which
 * is precisely what `/api/studio/media-proxy` returns.
 *
 * Registered as a MIDDLEWARE rather than by writing the config, because
 * `clipboard.configs` builds a fresh job every time it is read: a value set on
 * it is discarded before anything can use it.
 */
function ensureImageProxy(board: MountedBoard): void {
  const std = board.std as unknown as { clipboard?: { use?: (m: unknown) => void } };
  const clipboard = std.clipboard;
  if (!clipboard?.use || proxied.has(clipboard)) return;
  proxied.add(clipboard);
  clipboard.use(({ adapterConfigs }: { adapterConfigs: Map<string, string> }) => {
    adapterConfigs.set('imageProxy', `${defaultApiBase()}/api/studio/media-proxy`);
  });
}

/** Registered once per clipboard — `use` appends, so twice would run twice. */
const proxied = new WeakSet<object>();

/**
 * Put the PNG somewhere the agent can read it back.
 *
 * SCRATCH, not the Library. A screenshot is a working artifact the agent looks
 * at once; filing every one of them under the user's media would bury the
 * pictures they actually made.
 *
 * The token is retried ONCE on a 401/403, for the same reason media fetches are:
 * a board open for an hour outlives its token, and the first thing to notice is
 * a request. Failing the whole capture over a refreshable token would make
 * "look at my board" unreliable in exactly the long sessions where it is most
 * useful.
 */
async function uploadPng(blob: Blob, name: string): Promise<string> {
  const send = async (token: string | null) => {
    // A fresh FormData per attempt: a consumed body cannot be re-sent.
    const form = new FormData();
    form.append('file', new File([blob], name, { type: 'image/png' }));
    return fetch(`${defaultApiBase()}/api/studio/upload-temp`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
  };

  let token = await getParentToken().catch(() => null);
  let res = await send(token);
  if ((res.status === 401 || res.status === 403) && token) {
    token = await getParentToken(true).catch(() => null);
    if (token) res = await send(token);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('The screenshot could not be saved — the session needs signing in again.');
  }
  if (!res.ok) throw new Error(`The screenshot could not be saved (${res.status}).`);
  const json = await res.json().catch(() => null) as { url?: string } | null;
  if (!json?.url) throw new Error('The screenshot was saved but no url came back.');
  return json.url;
}

/**
 * Rasterise the board and hand back a url.
 *
 * Throws with a sentence worth showing rather than returning null — every
 * failure here has a different remedy (nothing selected, nothing on screen,
 * upload refused) and collapsing them into "could not take a screenshot" is how
 * an agent ends up retrying the one thing that cannot work.
 */
export async function captureBoard(
  board: MountedBoard,
  scope: ShotScope = 'viewport',
): Promise<ScreenshotResult> {
  const subjects = subjectsFor(board, scope);
  if (!subjects.length) {
    throw new Error(
      scope === 'selection'
        ? 'Nothing is selected on the board.'
        : scope === 'viewport'
          ? 'Nothing is in view — the canvas is empty where the user is looking.'
          : 'The board is empty.',
    );
  }

  ensureImageProxy(board);

  const clipboard = board.std.getOptional(EdgelessClipboardController);
  if (!clipboard) throw new Error('This board cannot export an image.');

  const { blocks, elements } = split(subjects);

  // Scale so the long edge lands near MAX_EDGE. `dpr` is the only size control
  // `toCanvas` offers, and it multiplies the model-space bound.
  const span = subjects.reduce(
    (acc, m) => {
      const b = boundsOf(m);
      if (!b) return acc;
      return {
        x0: Math.min(acc.x0, b.x), y0: Math.min(acc.y0, b.y),
        x1: Math.max(acc.x1, b.x + b.w), y1: Math.max(acc.y1, b.y + b.h),
      };
    },
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
  const w = Math.max(1, span.x1 - span.x0);
  const h = Math.max(1, span.y1 - span.y0);
  const dpr = Math.min(2, Math.max(0.2, MAX_EDGE / Math.max(w, h)));

  const canvas = await clipboard.toCanvas(
    blocks as never,
    elements as never,
    { dpr, background: getComputedStyle(document.body).backgroundColor || '#1b1d21' },
  );
  if (!canvas) throw new Error('The board could not be rendered to an image.');

  drawFrameTitles(canvas, subjects, { x: span.x0, y: span.y0 }, dpr);

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The rendered image could not be read.');

  const url = await uploadPng(blob, `board-${scope}-${canvas.width}x${canvas.height}.png`);
  return { url, width: canvas.width, height: canvas.height, items: subjects.length, scope };
}

/**
 * ── FRAME TITLES, DRAWN ON AFTERWARDS ───────────────────────────────────────
 *
 * BlockSuite renders a frame's BOX but not its NAME: the title is a separate
 * overlay in the editor chrome, outside what `toCanvas` composites. So a
 * screenshot of a well-sectioned board came back with three unlabelled
 * rectangles, and the one thing a reviewer most needs to check — whether the
 * sections say what they should — was the one thing missing.
 *
 * That matters beyond looks. An agent reviewing its own board reads the
 * picture; if section names are invisible there, it cannot verify them and will
 * confidently report a layout it has not actually seen.
 *
 * The mapping is exact rather than guessed: `toCanvas` renders the union bounds
 * of the subjects at `dpr`, so a model point is (model - origin) * dpr in
 * canvas pixels. Verified against a real capture — a 1452x1820 model span came
 * back 1285x1608, which is dpr 0.885 on both axes.
 */
function drawFrameTitles(
  canvas: HTMLCanvasElement,
  subjects: GfxModel[],
  origin: { x: number; y: number },
  dpr: number,
): void {
  const frames = subjects.filter(m =>
    (m as unknown as { flavour?: string }).flavour === 'affine:frame');
  if (!frames.length) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Legible at the size these captures are actually read at, and never so small
  // it becomes noise on a zoomed-out board.
  const size = Math.max(13, Math.round(22 * dpr));
  ctx.save();
  ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'alphabetic';

  for (const frame of frames) {
    const box = boundsOf(frame);
    const title = String(
      (frame as unknown as { title?: { toString(): string } }).title ?? '',
    ).trim();
    if (!box || !title) continue;

    const x = (box.x - origin.x) * dpr;
    // The title sits ON the frame's top edge, which is where AFFiNE draws it.
    const y = (box.y - origin.y) * dpr - Math.round(size * 0.4);
    if (y < size) continue; // Off the top of the capture — better absent than clipped.

    // A plate behind it, so a title stays readable over whatever the frame
    // happens to sit on.
    const w = ctx.measureText(title).width;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 6, y - size, w + 12, size * 1.35);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(title, x, y + size * 0.1);
  }
  ctx.restore();
}
