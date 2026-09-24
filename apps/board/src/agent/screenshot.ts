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
import { settleFrame } from './settle-frame';

export type ShotScope = 'viewport' | 'all' | 'selection' | 'ids' | 'auto';

export interface ScreenshotResult {
  url: string;
  width: number;
  height: number;
  /** How many elements are in frame — so the agent can tell "empty" from "failed". */
  items: number;
  /**
   * WHAT IS IN THIS PICTURE, by id.
   *
   * The thing that turns a screenshot into a handle. Without it a picture is a
   * dead end: the agent can see that the third card is wrong and has no way to
   * name it. With it, looking leads straight into `board_canvas_read { ids }`
   * and into an edit.
   */
  ids: string[];
  scope: ShotScope;
  /** Image pixels per model unit. Below `LEGIBLE_SCALE` the text is decoration. */
  scale: number;
  /** The model-space box this picture covers. */
  box: { x: number; y: number; w: number; h: number };
  /**
   * Whether body text survived the scaling.
   *
   * Reported rather than assumed, because the failure it prevents is silent: a
   * capture of a big board LOOKS like a capture, and an agent that cannot read
   * the cards in it will still describe them.
   */
  legible: boolean;
  /** Set on an `auto` region. */
  label?: string;
  /**
   * HOW LONG EACH STEP TOOK, in milliseconds.
   *
   * Kept in the result rather than behind a debug flag, because "the screenshot
   * is slow" was un-actionable for as long as it was one opaque number: the
   * render and the upload have nothing in common and neither did their fixes.
   * The first time this was reported it showed a 28s render for one small note,
   * which is the whole reason the tool appeared to hang.
   */
  timing: { render: number; upload: number; total: number };
}

/**
 * A region that was planned and could not be photographed.
 *
 * Reported rather than dropped. A board with one unreachable picture on it
 * still deserves a look at its other four sections, and an agent told "four
 * regions" when five were planned would believe it had seen the board.
 */
export interface FailedRegion {
  label: string;
  failed: string;
  ids: string[];
}

/** What `scope: 'auto'` returns — one picture, or the several it took instead. */
export interface AutoScreenshot {
  scope: 'auto';
  board: { x: number; y: number; w: number; h: number };
  items: number;
  regions: number;
  shots: Array<ScreenshotResult | FailedRegion>;
  note: string;
}

/**
 * The long edge of the image we hand back.
 *
 * A vision model gains nothing from a 6000px board and pays for every pixel, so
 * the capture is scaled to fit this. Big enough that note text stays legible,
 * which is the thing most worth reading in a screenshot.
 */
const MAX_EDGE = 1600;

/**
 * Below this many image pixels per model unit, body text stops being readable.
 *
 * Board body text is about 16 model units tall, so this puts it at ~10px in the
 * capture — the floor at which a vision model reads words rather than guessing
 * at shapes. Derived from that number rather than picked: change the board's
 * type size and this is the line that should move.
 */
const LEGIBLE_SCALE = 0.6;
/** Model units that fit in one legible capture along the long edge. */
const LEGIBLE_SPAN = MAX_EDGE / LEGIBLE_SCALE;
/**
 * The most regions `auto` will shoot.
 *
 * Each is a render and an upload, so this is a real cost ceiling, not a
 * defensive number. Past six pictures nobody — model or person — is reviewing a
 * board; they are reading a contact sheet, and `board_map` answers that better
 * and for free.
 */
const MAX_TILES = 6;

/** The box that contains all of them, in model space. */
function unionBox(models: GfxModel[]): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of models) {
    const b = boundsOf(m);
    if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

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
function subjectsFor(board: MountedBoard, scope: ShotScope, ids?: string[]): GfxModel[] {
  const gfx = board.std.get(GfxControllerIdentifier);
  const all = [...(gfx.gfxElements as GfxModel[])];

  if (scope === 'all' || scope === 'auto') return all;

  /**
   * NAMED IDS — the scope that makes zooming possible.
   *
   * Every other scope answers a question about the VIEW: what is selected, what
   * is on screen, what exists. This one answers a question about the WORK: show
   * me these four. It is what `board_map` and `board_canvas_read` hand their
   * ids to, and without it an agent that has worked out exactly which part of
   * the board matters still has no way to look at it.
   *
   * A frame id expands to the frame AND what it contains, because "show me the
   * Act Two frame" means the cards in it — an empty rectangle is not what
   * anybody asked for.
   */
  if (scope === 'ids') {
    const wanted = new Set(ids ?? []);
    const frames = all.filter(m =>
      wanted.has((m as unknown as { id: string }).id)
      && (m as unknown as { flavour?: string }).flavour === 'affine:frame');
    for (const frame of frames) {
      const fb = boundsOf(frame);
      if (!fb) continue;
      for (const m of all) {
        const b = boundsOf(m);
        if (!b) continue;
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        if (cx >= fb.x && cx <= fb.x + fb.w && cy >= fb.y && cy <= fb.y + fb.h) {
          wanted.add((m as unknown as { id: string }).id);
        }
      }
    }
    return all.filter(m => wanted.has((m as unknown as { id: string }).id));
  }

  if (scope === 'selection') {
    const sel = new Set(gfx.selection.selectedIds);
    return all.filter(m => sel.has((m as unknown as { id: string }).id));
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

export interface PlannedRegion {
  label: string;
  models: GfxModel[];
}

/**
 * CUT THE BOARD INTO PIECES THAT CAN BE READ.
 *
 * Two strategies, and which one applies is decided by the board rather than by
 * a setting:
 *
 *   FRAMES, when the board has them. A frame is the author's own statement that
 *   these things belong together, so a region per frame is a region per idea —
 *   and the resulting pictures are ones a person would have chosen. Anything
 *   outside every frame is gathered as one more region, because stranded cards
 *   are exactly what a reviewer needs to see.
 *
 *   A GRID, when it has none. No structure has been declared, so the only
 *   honest cut is spatial: as few tiles as will make the text legible, laid out
 *   in reading order so region 1 is the top-left.
 *
 * Exported for the tests, which drive it with plain boxes — the geometry is
 * where this can be wrong, and it needs no canvas to be wrong on.
 */
export function planRegions(models: GfxModel[], maxTiles: number): PlannedRegion[] {
  const box = unionBox(models);
  if (!box) return [];

  // Already legible whole: one region, and no tiling decision to get wrong.
  if (Math.max(box.w, box.h) <= LEGIBLE_SPAN) {
    return [{ label: 'the whole board', models }];
  }

  const frames = models.filter(m =>
    (m as unknown as { flavour?: string }).flavour === 'affine:frame');

  if (frames.length && frames.length <= maxTiles) {
    const claimed = new Set<string>();
    const regions: PlannedRegion[] = [];
    for (const frame of frames) {
      const fb = boundsOf(frame);
      if (!fb) continue;
      const inside = models.filter(m => {
        const b = boundsOf(m);
        if (!b) return false;
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        return cx >= fb.x && cx <= fb.x + fb.w && cy >= fb.y && cy <= fb.y + fb.h;
      });
      for (const m of inside) claimed.add((m as unknown as { id: string }).id);
      const title = String(
        (frame as unknown as { title?: { toString(): string } }).title ?? '',
      ).trim();
      regions.push({ label: title || 'an untitled frame', models: inside });
    }
    const loose = models.filter(m => !claimed.has((m as unknown as { id: string }).id));
    if (loose.length) regions.push({ label: 'outside every frame', models: loose });
    return regions.filter(r => r.models.length).slice(0, maxTiles);
  }

  /**
   * A GRID, sized to legibility and then capped.
   *
   * `cols`/`rows` come from how many legible spans the board measures, not from
   * a fixed layout — a wide ribbon becomes 4x1 and a tall one 1x4, which is
   * what their shapes mean. The cap can force tiles bigger than the legible
   * span; when it does, the pictures say so through `legible: false` rather
   * than pretending, because a quietly-illegible picture is the failure this
   * whole function exists to remove.
   */
  let cols = Math.max(1, Math.ceil(box.w / LEGIBLE_SPAN));
  let rows = Math.max(1, Math.ceil(box.h / LEGIBLE_SPAN));
  while (cols * rows > maxTiles && (cols > 1 || rows > 1)) {
    if (cols >= rows && cols > 1) cols -= 1;
    else if (rows > 1) rows -= 1;
  }

  const tw = box.w / cols;
  const th = box.h / rows;
  const buckets = new Map<string, GfxModel[]>();
  for (const m of models) {
    const b = boundsOf(m);
    if (!b) continue;
    // Assigned by CENTRE, so one element lands in exactly one region. Splitting
    // by overlap would put a wide note in three pictures and count it thrice.
    const c = Math.min(cols - 1, Math.max(0, Math.floor((b.x + b.w / 2 - box.x) / tw)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((b.y + b.h / 2 - box.y) / th)));
    const key = `${r}:${c}`;
    const list = buckets.get(key);
    if (list) list.push(m);
    else buckets.set(key, [m]);
  }

  // Reading order — top row first, left to right — so "region 2" means the same
  // thing to the agent as it would to a person looking at the board.
  const out: PlannedRegion[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const list = buckets.get(`${r}:${c}`);
      if (!list?.length) continue;
      out.push({
        label: rows === 1 ? `region ${c + 1} of ${cols}`
          : cols === 1 ? `region ${r + 1} of ${rows}`
            : `row ${r + 1}, column ${c + 1}`,
        models: list,
      });
    }
  }
  return out;
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
/**
 * ── EVERY STEP IS BOUNDED, AND SAYS WHICH ONE STALLED ───────────────────────
 *
 * This used to be three bare awaits. When one of them never settled — measured
 * in production, on a board of five notes — the tool simply never answered:
 * the RPC timed out after 60s with "it didn't answer, it may have been closed",
 * which is a sentence about the tab and was a lie about the tab. No error, no
 * rejection, nothing in the console. The agent's only visual check on its own
 * work failed as a sixty-second stall rather than as a fault.
 *
 * A capture has exactly three places it can hang, and each has a different
 * remedy, so each is timed separately and named in the failure. The budget adds
 * up to less than the caller's, which is the point: this must answer before the
 * thing waiting on it gives up, or the message the user sees is about the wrong
 * component.
 */
const RENDER_MS = 30_000;
const UPLOAD_MS = 15_000;
/**
 * The whole of an `auto` call, however many regions it planned.
 *
 * Per-step bounds stop a hang; they do not stop six honest-but-slow regions
 * from adding up past what the caller will wait for. When this runs out the
 * call RETURNS what it has, and says so — a board reviewed in four of its six
 * regions is a useful answer, and a timeout is not.
 */
const AUTO_BUDGET_MS = 110_000;

/**
 * ── ONE CAPTURE AT A TIME, AND THIS IS NOT AN OPTIMISATION ──────────────────
 *
 * html2canvas does a great deal of SYNCHRONOUS work — it clones the document,
 * walks it, and rasterises. Two of those running at once do not merely take
 * twice as long: they starve the event loop, and the first casualty is
 * `setTimeout`, which is what every bound in this file is built on. Measured:
 * two captures fired together sat unresolved past 105 seconds with their 30s
 * render timeouts never firing, because the timer could not get a turn.
 *
 * A timeout that cannot fire is worse than no timeout, so the concurrency that
 * defeats it is removed rather than tolerated. Captures queue; each is bounded
 * from the moment it actually STARTS, so waiting a turn never counts against a
 * capture's own budget.
 */
let captureQueue: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const run = captureQueue.then(work, work);
  // Never let one failure poison the queue for the next caller.
  captureQueue = run.then(() => undefined, () => undefined);
  return run;
}

function withStage<T>(work: Promise<T>, ms: number, stage: string, remedy: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The screenshot stalled while ${stage} (over ${Math.round(ms / 1000)}s). ${remedy}`)),
      ms,
    );
    work.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * One capture of one box. The primitive every scope is expressed in.
 *
 * Kept separate from `captureBoard` because `auto` needs to call it several
 * times, and a tiling pass built on a function that also decides WHAT to shoot
 * would have to unpick that decision on every tile.
 */
function captureSubjects(
  board: MountedBoard,
  subjects: GfxModel[],
  scope: ShotScope,
  maxEdge: number,
): Promise<ScreenshotResult> {
  return serialise(() => captureNow(board, subjects, scope, maxEdge));
}

/**
 * ── FRAME IT BEFORE YOU SHOOT IT ────────────────────────────────────────────
 *
 * An edgeless note that is off screen HAS NO DOM. BlockSuite only renders the
 * blocks the viewport can see, which is what makes a thousand-element board
 * open at all — and `toCanvas` rasterises DOM. So asking for a picture of
 * anything the user is not currently looking at handed html2canvas an element
 * with no box, and it answered in one of two ways: "The image argument is a
 * canvas element with a width or height of 0" on a cold board, or, once the
 * images had loaded, nothing at all. Never a picture.
 *
 * That is why `all` and `auto` failed while a single visible note worked, and
 * why it looked like a size problem: the bigger the board, the more of it is
 * off screen, so the more often it broke.
 *
 * The fix is what a person does — look at the thing, then photograph it. The
 * viewport is moved to the subjects, given a couple of frames to render them,
 * and PUT BACK afterwards. Restoring is not politeness: an agent taking six
 * regional shots would otherwise leave the user's board parked on region six.
 */
const SETTLE_FRAMES = 3;

interface FramingViewport {
  viewportBounds: { x: number; y: number; w: number; h: number };
  setViewportByBound?(
    bound: { x: number; y: number; w: number; h: number },
    padding?: [number, number, number, number],
    smooth?: boolean,
  ): void;
}

async function captureNow(
  board: MountedBoard,
  subjects: GfxModel[],
  scope: ShotScope,
  maxEdge: number,
): Promise<ScreenshotResult> {
  ensureImageProxy(board);

  const clipboard = board.std.getOptional(EdgelessClipboardController);
  if (!clipboard) throw new Error('This board cannot export an image.');

  const { blocks, elements } = split(subjects);
  const box = unionBox(subjects);
  if (!box) throw new Error('Those elements have no position on the canvas.');

  const vp = board.std.get(GfxControllerIdentifier).viewport as unknown as FramingViewport;
  const restoreTo = vp?.viewportBounds
    ? { ...vp.viewportBounds }
    : null;
  if (vp?.setViewportByBound) {
    // A margin, so a note at the very edge is not rendered half-clipped.
    vp.setViewportByBound(
      { x: box.x - 40, y: box.y - 40, w: box.w + 80, h: box.h + 80 },
      [0, 0, 0, 0],
      false,
    );
    for (let i = 0; i < SETTLE_FRAMES; i++) await settleFrame();
  }

  // Scale so the long edge lands near `maxEdge`. `dpr` is the only size control
  // `toCanvas` offers, and it multiplies the model-space bound.
  const scale = Math.min(2, Math.max(0.2, maxEdge / Math.max(box.w, box.h)));

  const t0 = Date.now();
  try {
  const canvas = await withStage(
    Promise.resolve(clipboard.toCanvas(
      blocks as never,
      elements as never,
      { dpr: scale, background: getComputedStyle(document.body).backgroundColor || '#1b1d21' },
    )),
    RENDER_MS,
    'drawing the board',
    'A picture on the board may be pointing at a url that never answers. '
      + 'Try a smaller scope — `ids` for the part you care about.',
  );
  if (!canvas) throw new Error('The board could not be rendered to an image.');
  const rendered = Date.now();

  drawFrameTitles(canvas, subjects, { x: box.x, y: box.y }, scale);

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The rendered image could not be read.');

  const url = await withStage(
    uploadPng(blob, `board-${scope}-${canvas.width}x${canvas.height}.png`),
    UPLOAD_MS,
    'saving the picture',
    'Storage did not answer. The board itself is fine.',
  );

  return {
    url,
    width: canvas.width,
    height: canvas.height,
    items: subjects.length,
    ids: subjects.map(m => (m as unknown as { id: string }).id),
    scope,
    scale: Math.round(scale * 1000) / 1000,
    box,
    legible: scale >= LEGIBLE_SCALE,
    timing: {
      render: rendered - t0,
      upload: Date.now() - rendered,
      total: Date.now() - t0,
    },
  };
  } finally {
    // The user's framing is theirs. Restored even when the capture failed —
    // especially then, because a failure they did not ask for should not also
    // move their board.
    if (restoreTo && vp?.setViewportByBound) {
      vp.setViewportByBound(restoreTo, [0, 0, 0, 0], false);
    }
  }
}

/**
 * Rasterise the board and hand back a url.
 *
 * Throws with a sentence worth showing rather than returning null — every
 * failure here has a different remedy (nothing selected, nothing on screen,
 * upload refused, a stalled render) and collapsing them into "could not take a
 * screenshot" is how an agent ends up retrying the one thing that cannot work.
 */
export async function captureBoard(
  board: MountedBoard,
  scope: ShotScope = 'viewport',
  opts: { ids?: string[]; maxTiles?: number } = {},
): Promise<ScreenshotResult | AutoScreenshot> {
  const subjects = subjectsFor(board, scope, opts.ids);
  if (!subjects.length) {
    throw new Error(
      scope === 'selection'
        ? 'Nothing is selected on the board.'
        : scope === 'ids'
          ? 'None of those ids are on the canvas. Call board_canvas_read for the current ones.'
          : scope === 'viewport'
            ? 'Nothing is in view — the canvas is empty where the user is looking.'
            : 'The board is empty.',
    );
  }

  if (scope !== 'auto') return captureSubjects(board, subjects, scope, MAX_EDGE);

  /**
   * ── AUTO: DECIDE WHERE TO LOOK, THEN LOOK ─────────────────────────────────
   *
   * One picture of a big board is not a picture of it. `all` scales the long
   * edge to 1600px whatever the board measures, so a 3500-unit board renders
   * its body text at seven pixels — present in the image, unreadable in it, and
   * the agent cannot tell the difference. It reports on a board it has not
   * actually seen, which is worse than having no picture at all.
   *
   * So `auto` asks first whether the whole board fits legibly. If it does, that
   * is one call and one image. If it does not, the board is cut into regions
   * that DO, and each is captured at a scale its text survives. The regions
   * follow frames when the board has them, because a frame is the author's own
   * statement of what belongs together; grid tiles only when it has none.
   *
   * Each tile carries the ids it contains, so a picture leads straight back
   * into `board_canvas_read { ids }` or an edit. That is the whole loop: see
   * it, name it, change it.
   */
  const tiles = planRegions(subjects, opts.maxTiles ?? MAX_TILES);
  const shots: Array<ScreenshotResult | FailedRegion> = [];
  const deadline = Date.now() + AUTO_BUDGET_MS;
  let ranOut = 0;
  for (const tile of tiles) {
    if (Date.now() > deadline) { ranOut += 1; continue; }
    // One bad region must not cost the others: a board with one unreachable
    // image still deserves a picture of its other four sections.
    try {
      shots.push({ ...(await captureSubjects(board, tile.models, 'auto', MAX_EDGE)), label: tile.label });
    } catch (e) {
      shots.push({
        label: tile.label,
        failed: (e as Error)?.message || 'That region could not be captured.',
        ids: tile.models.map(m => (m as unknown as { id: string }).id),
      });
    }
  }

  const whole = unionBox(subjects)!;
  return {
    scope: 'auto',
    board: whole,
    items: subjects.length,
    regions: shots.length,
    shots,
    note: (shots.length === 1 && !ranOut
      ? 'The whole board fits in one legible picture.'
      : `The board is ${Math.round(whole.w)}x${Math.round(whole.h)} — too big to read in one `
        + `picture, so it was captured as ${shots.length} regions. Each carries the ids it holds; `
        + 'pass those to board_canvas_read to read that part, or to board_screenshot { scope: "ids" } '
        + 'to look closer.')
      + (ranOut
        ? ` ${ranOut} more region(s) were planned and NOT captured — this call ran out of time. `
          + 'You have not seen all of the board; ask for them by id.'
        : ''),
  };
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
