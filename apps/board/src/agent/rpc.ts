/**
 * Board ↔ Voidspace chat RPC.
 *
 * Same wire contract as the image and video editors: the parent page posts
 * `{ type: 'voidspace:board-*', requestId, ...args }`, we post one reply back
 * carrying the same `requestId`, and failures come back as `voidspace:error`.
 * Keeping the shape identical means the chat side is the same `rpc()` helper
 * with a different message namespace, not a second protocol.
 *
 * The `board-` prefix is deliberate, exactly as `img-` is: if two editors are
 * ever mounted in one page, a stray `get-state` must not be answered by
 * whichever happens to be listening.
 *
 * THE SAME THREE RULES apps/image/src/agent/rpc.ts enforces, because they are
 * what make agent editing safe to hand a real user:
 *
 *  1. NO PIXELS OVER THE WIRE. Media travel as Library ids and urls, never bytes.
 *  2. EVERY MUTATION IS ONE UNDO STEP. Handlers go through the shot helpers,
 *     which open a capture boundary and batch inside one transaction, so the
 *     user's Ctrl+Z reverses exactly one agent action — never half of one.
 *  3. THE USER OUTRANKS THE AGENT. A mutation computed from a stale read is
 *     refused (`expectRev`), so hand edits made while the agent was thinking are
 *     never silently overwritten.
 *
 * WHAT THE AGENT CAN NOW SEE. A shot owns its media, so `board_read` returns
 * every shot COMPLETE — title, the three written fields, and every reference
 * with its id, role, kind and name. This used to be a geometric scan that could
 * only report block flavours, so the agent knew a shot "contained an image"
 * without knowing what that image was for, and could not address it to change it.
 */
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';
import { captureBoard, type ShotScope } from './screenshot';

import type { MountedBoard } from '../blocksuite/editor';
import type { DocumentView } from '../ui/document-view';
import type { DocumentFocus } from '../ui/document-focus';
import { saveDocument, uploadDocument } from '../board/document-export';
import { placeMarkdownDocument } from '../document/note-io';
import { placeAsset } from '../board/asset-media';
import {
  COLOR_NAMES, canvasDigest, drawOnCanvas, editCanvas, mediaUrlOf, readCanvas, readSelection,
  type EditOp, type ElementSpec,
} from '../board/canvas';
import { reserveFlow } from '../board/space';
import { arrangeCanvas } from '../board/arrange';
import { type ComposeSection, composeRegion } from '../board/compose';
import { readBoardMap } from '../board/map';
import { pendingToast } from '../ui/toast';
import type { PendingMediaApi } from '../ui/pending-media';
import { renderBoardThumbnail } from '../board/thumbnail';
import { compileBoard, describeShot } from '../shot/screenplay';
import {
  MEDIA_ROLES, REF_KINDS, SHOT_H, SHOT_W, checkGraphic, chosenTake, defaultGraphicMode,
  isTimed, normaliseShotKind, rolesFor, trimWindow,
  type MediaRole, type RefKind, type ShotTake,
} from '../shot/model';

/** Accepted `source` values, so a typo becomes the safe default rather than a
 *  value nothing downstream knows how to read. */
const TAKE_SOURCES = new Set(['generated', 'recorded', 'uploaded', 'imported']);

/**
 * The order a model receives references in.
 *
 * Kept identical to compile's and the card's, because the positional tags
 * (`@Image1`, `@Image2`) are numbered from it. Three copies of this list is two
 * too many, but they are in three packages that do not import each other; the
 * test that matters is that a shot's legend and its array agree, which is
 * asserted where the legend is built.
 */
const GEN_ROLE_ORDER: MediaRole[] = [
  'firstFrame', 'lastFrame', 'motionRef',
  'background', 'figure', 'inset', 'logo', 'texture',
  'reference', 'sfx', 'bgm',
];
import { allBlocks, findBlock, searchBlocks, setBlockCatalogue } from '../shot/blocks';
import { canvasMediaFor } from '../shot/canvas-drop';
import { clearTakeProgress, setTakeProgress } from '../shot/take-progress';
import { readParsed, readScript, writeScript } from '../shot/screenplay-doc';
import { coverage, nextScene, renderScene, renderScriptContext } from '../shot/resolution';
import { sequenceOf } from '../shot/fountain';
import { DRAFT_H, DRAFT_W, type DraftBlockModel } from '../shot/draft-block';

/** A gfx block's box, for the viewport. `xywh` is stored as a JSON tuple. */
function bounds(m: { xywh?: string }): { x: number; y: number; w: number; h: number } {
  try {
    const [x, y, w, h] = JSON.parse(m.xywh ?? '[0,0,0,0]');
    return { x, y, w, h };
  } catch {
    return { x: 0, y: 0, w: DRAFT_W, h: DRAFT_H };
  }
}
import {
  allModels, aspectFor, checkShot, effectiveModel, estimateShotCredits, findModel,
  plannedSeconds, referenceTag, resolutionFor, setModelCatalogue, type ModelCaps,
} from '../shot/models';
import {
  addGraphic, addMedia, addTake, chooseTake, createShots, deleteShot, moveMedia, readShot,
  readShots, relayoutShots, removeGraphic, removeMedia, removeTake, setMediaRole, setShotFields,
  shotAtPoint, tagMedia, trimMedia, updateGraphic, updateTake,
} from '../shot/shots';
import { ensureVisible, fitBoard } from '../ui/viewport';

type Reply = (payload: Record<string, unknown>) => void;

/**
 * Document revision, bumped on every block change.
 *
 * BlockSuite has no revision counter of its own, so we keep one: it is the only
 * way to tell "the agent read, then the user edited, then the agent wrote"
 * apart from a normal write. Cheap — one integer per `blockUpdated`.
 */
let rev = 0;

/**
 * PAGE SETUP, VALIDATED HERE RATHER THAN TRUSTED.
 *
 * These arrive from the model through two hops of plain JSON, so every one is
 * checked against what the renderer accepts and left out entirely when it is
 * not. An unknown orientation silently becoming landscape would be worse than
 * ignoring it, and passing it through would put the guess in the PDF writer,
 * which is the wrong place to decide what the agent meant.
 */
/** The blank line between an injected title and the document under it. */
const nl2 = String.fromCharCode(10, 10);

function pageSetup(args: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const margin = args?.margin;
  if (margin === 'normal' || margin === 'narrow' || margin === 'wide') out.margin = margin;
  else if (Number.isFinite(Number(margin)) && Number(margin) > 0) {
    // Points. Clamped, because a 400pt margin on A4 leaves no page.
    out.margin = Math.min(200, Math.max(12, Number(margin)));
  }
  if (args?.orientation === 'landscape') out.orientation = 'landscape';
  const spacing = Number(args?.lineSpacing);
  if (Number.isFinite(spacing) && spacing > 0) out.lineSpacing = Math.min(3, Math.max(0.8, spacing));
  const header = String(args?.header ?? '').trim();
  const footer = String(args?.footer ?? '').trim();
  if (header) out.header = header.slice(0, 200);
  if (footer) out.footer = footer.slice(0, 200);
  return out;
}

export function getBoardRev(): number {
  return rev;
}

/** Refusal shape shared by every handler, mirroring the image editor's. */
function fail(reason: string, message: string) {
  return { ok: false as const, reason, message };
}

/**
 * An array argument, WHETHER OR NOT THE MODEL STRINGIFIED IT.
 *
 * ── A REAL FAILURE, FOUR TIMES IN ONE TURN ───────────────────────────────────
 * Smaller/cheaper models routinely emit a nested array as a JSON STRING:
 *
 *   "elements": "[{\"kind\": \"text\", ...}]"     ← not an array
 *
 * `Array.isArray` then says no, the handler answers "Send at least one element",
 * and the agent — which did nothing wrong and has no way to see the difference —
 * retries the identical call. Observed on a live board: two of the four
 * `board_draw` attempts in one turn died this way, each costing a full LLM round
 * trip, and the user watched a spinner for minutes before anything appeared.
 *
 * Parsing it is not leniency for its own sake. The tool schema is unambiguous,
 * the model's intent is unambiguous, and the only thing standing between them is
 * a pair of quotes we can remove for free.
 */
function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('[')) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Refuse every write once the board is compiled.
 *
 * `store.readonly` already DROPS the write, but silently — the handler went on
 * to return a success digest, so the agent said "I added that shot" about a
 * board where nothing had changed. A tool that reports success for work it did
 * not do is worse than one that fails, because nobody goes looking.
 *
 * This is the second of the lock's three places (the others are the Firestore
 * status the save endpoints check, and the tool dispatcher on the page).
 */
/**
 * Refuse a mutation only when the DOCUMENT itself is read-only.
 *
 * Which now means a genuinely read-only session — a shared link, a replay — and
 * NOT "this board has been compiled". Compiling leaves the board editable on
 * purpose: recompiling mints a new project, so fixing a mistake costs nothing
 * and there is no state a person can get stuck in.
 */
/**
 * The handlers that only LOOK. Everything else gets an undo checkpoint before
 * it runs — see the note at the dispatcher.
 *
 * A deny-list rather than an allow-list, deliberately: a verb added later and
 * forgotten here gets a checkpoint it may not have needed, which costs nothing.
 * The other way round, it would silently become un-undoable.
 */
export const READ_ONLY_RPC: ReadonlySet<string> = new Set([
  'voidspace:board-read',
  'voidspace:board-read-script',
  'voidspace:board-read-draft',
  'voidspace:board-canvas-read',
  'voidspace:board-map',
  'voidspace:board-document',
  'voidspace:board-document-read',
  'voidspace:board-screenshot',
  'voidspace:board-selection',
  'voidspace:board-blocks',
  'voidspace:board-block-catalog',
  'voidspace:board-model-catalog',
  'voidspace:board-models',
  'voidspace:board-graphic-fills',
  'voidspace:board-compile-payload',
  'voidspace:board-shot-at',
  'voidspace:board-shot-gen-input',
  'voidspace:board-running-takes',
  'voidspace:board-take-progress',
  'voidspace:board-pending-media',
  'voidspace:board-thumbnail',
  'voidspace:board-progress',
  'voidspace:board-fit',
  'voidspace:board-lock',
  'voidspace:board-library-changed',
]);

function checkWritable(board: MountedBoard): { ok: true } | ReturnType<typeof fail> {
  if (!board.store.readonly) return { ok: true };
  return fail(
    'board_readonly',
    'This board is open read-only, so it cannot be changed right now.',
  );
}

/**
 * Guard a mutation against a stale read.
 *
 * The agent reads the board, thinks for a few seconds, then writes. In that gap
 * the USER may have changed the very shot it is about to edit. Without this the
 * agent's write silently wins and the person's work disappears with no undo
 * entry they would recognise. With it, the agent is told to re-read and try
 * again — which it can do in one turn.
 *
 * Optional: a first-turn edit with no prior read is allowed through, since there
 * is nothing it could be stale against.
 */
function checkRev(expectRev: unknown): { ok: true } | ReturnType<typeof fail> {
  if (typeof expectRev !== 'number') return { ok: true };
  if (rev === expectRev) return { ok: true };
  return fail(
    'board_changed',
    'The board changed since you last read it (the user may have edited it). '
    + 'Call board_read again and redo this edit against the current state.',
  );
}

/**
 * The board, as the agent sees it. Complete, because a shot is one object.
 *
 * Returned by every mutation as well as by the read, so the agent's next call is
 * always planned against post-edit state rather than its own guess at what its
 * write did.
 */
function digest(board: MountedBoard) {
  const shots = readShots(board.std);
  const script = readParsed(board.std);
  const cov = coverage(script, shots);

  return {
    ok: true as const,
    rev,
    boardId: board.workspace.id,
    surfaceId: board.surfaceId,
    shotCount: shots.length,
    /**
     * THE SCRIPT AS A MAP, NOT AS A DOCUMENT.
     *
     * One line per scene and per sequence — small enough to send on every read
     * however long the screenplay gets, and enough to know where you are. The
     * full text of any scene is one `board-read-script` call away, which is what
     * keeps a 40-scene script the same per-turn cost as a 4-scene one.
     *
     * `uncovered` is the load-bearing field: it is verified from the actual shot
     * blocks, never asserted, and it IS the to-do list.
     */
    script: {
      title: script.title,
      credit: script.credit,
      empty: script.empty,
      /** Character count, so the agent knows whether it holds the whole thing. */
      chars: readScript(board.std).length,
      acts: script.acts.map(a => ({ title: a.title, synopsis: a.synopsis.join(' ') })),
      sequences: script.sequences.map((q, i) => ({
        n: i + 1, title: q.title, synopsis: q.synopsis.join(' '),
      })),
      scenes: cov.scenes.map(c => {
        const scene = script.scenes.find(x => x.key === c.key)!;
        return {
          key: c.key,
          n: c.n,
          heading: c.heading,
          synopsis: scene.synopsis.join(' '),
          sequence: sequenceOf(script, scene)?.title ?? '',
          shots: c.shots,
        };
      }),
      /** Scene keys with no shots yet — the work remaining, in reading order. */
      uncovered: cov.uncovered,
      /** The one to work on next. Reading order, so the film is built front to back. */
      next: nextScene(script, shots),
      /** Shots on no scene, or on a scene the script no longer has. */
      offScript: cov.offScript,
    },
    shots: shots.map((s, i) => {
      // A GRAPHIC HAS NO MODEL. `effectiveModel` falls back to the board
      // default, which is right for a clip nobody has chosen for yet and wrong
      // here — it reported "xAI Grok Imagine" about a title card, which is an
      // invitation for the agent to start reasoning about a model that will
      // never run. It also decides @-tag numbering, which a block does not use.
      const caps = s.kind === 'hyperframes' ? null : effectiveModel(s.model);
      /**
       * THE SHOT'S WARNINGS AND ITS LAYERS' WARNINGS, in ONE list.
       *
       * The card draws layer warnings on the layer row, where the person who set
       * it is looking. The agent has no rows — it has this list — so keeping
       * them separate meant it could add a full-frame block as an overlay, be
       * told nothing, and only find out when the finished video had a graphic
       * covering the shot.
       *
       * Prefixed with the block name, because "will cover the picture" is
       * useless on a shot carrying three layers.
       */
      const hasPicture = !!chosenTake(s.takes, s.chosenTakeId);
      const warnings = [
        ...checkShot(s).map(w => w.message),
        ...(s.graphics ?? []).flatMap(g =>
          checkGraphic(g, findBlock(g.block), hasPicture).map(m => `${g.block || 'graphic'}: ${m}`)),
      ];
      const credits = estimateShotCredits(s);
      return {
        id: s.id,
        /** Position in the filmstrip, and therefore the shot number. */
        order: i,
        /** Which scene of the script this covers. '' = off-script, which is legal. */
        sceneKey: s.sceneKey,
        title: s.title,
        action: s.action,
        voiceover: s.voiceover,
        camera: s.camera,
        /** '' means the agent has not asked yet — see `ShotProps.model`. */
        model: s.model,
        modelLabel: caps?.label ?? '',
        durationSec: s.durationSec,
        // WHAT THIS SHOT IS. A graphic has no model and no first frame, so an
        // agent that cannot see the kind will keep offering both.
        kind: s.kind,
        ...(s.kind === 'hyperframes'
          ? {
              composition: s.composition,
              compositionVars: s.compositionVars,
            }
          : {}),
        summary: describeShot(s),
        // ROLE, not just kind. "shot 3 has an image" does not tell the agent
        // whether that image is the frame the video opens on or a mood reference
        // pinned beside it, and those compile to completely different things.
        media: s.media.map(m => {
          const win = isTimed(m.kind) ? trimWindow(m) : null;
          return {
            id: m.id,
            role: m.role,
            kind: m.kind,
            name: m.name,
            mediaId: m.mediaId,
            // The name the prompt uses, and what the thing is. Without these the
            // agent can see that a reference exists but not what it depicts, so
            // it cannot write a motion prompt that mentions it.
            tag: m.tag,
            refKind: m.refKind,
            promptTag: referenceTag(caps, s.media, m.id),
            // The user's direction, verbatim — the agent must not paraphrase or
            // overwrite it, so it has to be able to read it.
            note: m.note,
            durationSec: m.durationSec,
            // WHICH SECONDS. Reported only when set, so "untrimmed" and
            // "trimmed to the whole clip" are not the same shape.
            ...(win?.trimmed ? { inSec: win.start, outSec: win.end } : {}),
          };
        }),
        /**
         * WHAT THIS SHOT HAS ACTUALLY PRODUCED.
         *
         * Without it the agent cannot tell a shot that has been generated four
         * times from one that has never been attempted, so it re-offers work
         * that is already done and cannot answer "is this shot finished?".
         *
         * NO URLS — the same rule the reference list above follows, and for the
         * same reasons: signed Library urls are long, burn context, and are not
         * something a language model should be holding. `takeId` is what every
         * take op takes, and it is enough to act on.
         *
         * `promptUsed` is truncated: it is what makes "that one, but warmer" an
         * EDIT of a known thing rather than a fresh guess, but a shot with six
         * takes must not carry six full prompts on every read.
         */
        takes: s.takes.map(t => ({
          id: t.id,
          status: t.status,
          kind: t.kind,
          durationSec: t.durationSec,
          source: t.source,
          createdAt: t.createdAt,
          ...(t.label ? { label: t.label } : {}),
          ...(t.model ? { model: t.model } : {}),
          ...(t.runtime ? { runtime: t.runtime } : {}),
          ...(t.seed !== undefined ? { seed: t.seed } : {}),
          ...(t.costCredits !== undefined ? { costCredits: t.costCredits } : {}),
          ...(t.error ? { error: t.error } : {}),
          ...(t.promptUsed ? { promptUsed: t.promptUsed.slice(0, 160) } : {}),
        })),
        /**
         * WHICH TAKE IS THE SHOT — resolved, not raw.
         *
         * The stored pointer is empty far more often than not, because a shot
         * with one take never needed a decision. Reporting the raw field would
         * have the agent believe nothing was chosen and offer to choose, on a
         * shot that has exactly one candidate. `chosenTake` applies the same
         * fallback the card draws and compile will use, so all three agree.
         */
        chosenTakeId: chosenTake(s.takes, s.chosenTakeId)?.id ?? '',
        /**
         * WHAT IS DRAWN OVER THIS SHOT.
         *
         * Reported on every shot, not only graphics: a layer runs over footage
         * and over a graphic bed alike, and an agent that could only see them on
         * one kind would keep proposing to "add a lower third" to a clip that
         * already has one.
         *
         * NO URLS, the same rule the media and take lists follow. `rendered` is
         * the one bit that matters — whether this layer has a file yet — and it
         * is what separates "the user has designed this" from "it is ready to
         * travel to the editor".
         *
         * `slots` carries KEYS ONLY for media, values for words. A slot filled
         * with a picture is filled with a signed url, and putting a dozen of
         * those in every read is exactly the context burn the rule exists to
         * prevent — while "screenshot: set" is all the agent needs to know.
         */
        graphics: s.graphics.map((g, gi) => ({
          id: g.id,
          order: gi,
          block: g.block,
          // OVER the picture, or burned INTO it. The agent cannot advise on a
          // layer without knowing which, and the two have opposite costs.
          mode: g.mode === 'bake' ? 'bake' : 'overlay',
          offsetSec: g.offsetSec,
          durationSec: g.durationSec,
          anchor: g.anchor,
          rendered: !!g.renderedUrl,
          slots: Object.fromEntries(
            Object.entries(g.slots ?? {}).map(([k, v]) => [
              k,
              /^(https?:|data:|blob:|\/)/i.test(String(v)) ? 'set' : String(v).slice(0, 120),
            ]),
          ),
          ...(g.error ? { error: g.error } : {}),
        })),
        // SAID OUT LOUD, every read. A warning the agent has to go and ask for
        // is a warning it will not ask for.
        warnings,
        // Roughly what this shot costs to generate. Approximate on purpose —
        // see `estimateShotCredits` — and null when it genuinely cannot be
        // known, which is not the same as free.
        estimatedCredits: credits,
      };
    }),
  };
}

/**
 * Install the board's message handlers.
 *
 * Returns a disposer so a remount cannot leave two listeners answering the same
 * requestId — the class of bug that shows up as an agent tool "randomly"
 * returning stale data.
 */
export interface BoardRpcOptions {
  /**
   * The pending-media layer, for `board-pending-media`.
   *
   * A getter for the same reason `screenplay` is one: the RPC is installed
   * before the chrome, and the readiness handshake must not wait on panels.
   */
  /**
   * The layer's OWN type, not a structural copy of it. There was a hand-written
   * duplicate here and it drifted the moment `show` gained an argument — the
   * layer accepted the aspect and this signature did not, so the call that
   * passed it failed to compile with no hint that two declarations of one method
   * existed.
   */
  pending?: () => Pick<PendingMediaApi, 'show' | 'hide' | 'fail'> | null;
  /** Force a cloud snapshot. Compile calls it so the stored document can never
   *  be older than the project built from it. */
  flushCloud?: () => Promise<void>;
  /**
   * The screenplay focus overlay, fetched lazily.
   *
   * A getter rather than the object, because the RPC is installed before the
   * chrome is — the handshake that tells the parent the board is ready must not
   * wait on panels — and reordering boot to satisfy one handler would be
   * trading a real invariant for a convenience.
   */
  screenplay?: () => {
    open(): void;
    close(): void;
    isOpen(): boolean;
    print(): void;
    downloadFountain(): void;
  } | null;
  /**
   * The board-as-a-page overlay. Lazy for the same reason as `screenplay`.
   *
   * THE REAL TYPE, not a structural copy of it. This used to restate every
   * method by hand, which meant the view could grow a capability — as it did
   * when it learned to produce actual .docx and .pdf files — and this file
   * would keep compiling while quietly being unable to see it. `import type`
   * is erased at build time, so there is no runtime import and no cycle.
   */
  document?: () => DocumentView | null;
  /**
   * ONE document on the canvas, at page size. Lazy for the same reason.
   *
   * Distinct from `document` above, and the difference is what is being
   * written: that one projects the WHOLE CANVAS as a read-only page, this one
   * frames a single editable note. Both are real answers to "make this a
   * document" and they are not interchangeable.
   */
  documentFocus?: () => DocumentFocus | null;
}

export function installBoardRpc(board: MountedBoard, opts: BoardRpcOptions = {}): () => void {
  // Every block change bumps the revision, whoever made it. Nothing else needs
  // doing here any more: a shot's media live in its own props, so deleting a
  // shot takes its references with it and there is no sidecar left to prune.
  const sub = board.store.slots.blockUpdated.subscribe(() => { rev++; });

  /** Open pending toasts, by the parent's id — see `board-progress`. */
  const progress = new Map<string, () => void>();

  /**
   * TELL THE PARENT WHAT IS SELECTED, AS IT CHANGES.
   *
   * Pushed rather than polled. The agent's per-turn context is assembled when
   * the user hits send, and asking the iframe at that moment would add a round
   * trip to every message; pushing means the page always already knows.
   *
   * Ids and counts only — the urls are fetched with `board-selection` when a
   * generation actually needs them, because a selection change fires on every
   * click and most of them are never used for anything.
   */
  const gfx = board.std.get(GfxControllerIdentifier);
  const selectionSub = gfx.selection.slots.updated.subscribe(() => {
    const items = readCanvas(board.std, true);
    window.parent?.postMessage({
      type: 'voidspace:board-selection-changed',
      ids: items.map(i => i.id),
      // A one-line description, so the page can say "3 images selected" without
      // a second call and the agent's context can carry it for free.
      summary: items.map(i => `${i.kind}${i.text ? `: ${i.text.slice(0, 40)}` : ''}`),
    }, '*');
  });

  /**
   * TELL THE PARENT WHAT IS ON THE CANVAS, AS IT CHANGES.
   *
   * Same channel design as the selection above and for the same reason: the
   * per-turn context is assembled when the user hits send, and asking the
   * iframe at that moment would put a round trip on every message.
   *
   * DEBOUNCED, AND THAT IS NOT AN OPTIMISATION. `blockUpdated` fires on every
   * pointermove — a freshly opened empty board already reports a rev in the
   * hundreds — so an undebounced digest would walk the whole canvas on every
   * frame of every drag. The trailing edge means it computes ONCE, after the
   * user stops.
   */
  let digestTimer: ReturnType<typeof setTimeout> | null = null;
  const pushDigest = () => {
    digestTimer = null;
    try {
      window.parent?.postMessage({
        type: 'voidspace:board-canvas-changed',
        digest: canvasDigest(board.std),
      }, '*');
    } catch { /* the parent went away; the canvas is unaffected */ }
  };
  const digestSub = board.store.slots.blockUpdated.subscribe(() => {
    if (digestTimer) clearTimeout(digestTimer);
    digestTimer = setTimeout(pushDigest, 800);
  });
  // Once at mount, so a board REOPENED with work already on it is described on
  // the very first turn. Without this the agent is blind until the user touches
  // something — which is precisely the case where they expect it to already
  // know what is there.
  pushDigest();

  /** Every mutating handler starts the same way. */
  const guard = (args: Record<string, unknown>) => {
    const locked = checkWritable(board);
    if (!locked.ok) return locked;
    return checkRev(args.expectRev);
  };

  /**
   * ADDITIVE WRITES DO NOT NEED THE REVISION GUARD, and enforcing it there was
   * actively breaking the board.
   *
   * `expectRev` exists for ONE failure: the agent reads a shot, thinks for a few
   * seconds, and writes back a value computed from state the user has since
   * changed. That is a genuine lost update, and it is why every shot mutation
   * still checks it.
   *
   * Drawing a note is not that. It overwrites nothing, so there is nothing to
   * lose — and the check was refusing it constantly, because `rev` counts EVERY
   * `blockUpdated` on the document, not just the user's edits. Measured on a
   * live board: a freshly-opened, empty canvas already reported `rev: 444`, and
   * by the time the agent had finished reading the journal it had moved again.
   * Two of four `board_draw` attempts in one turn came back `board_changed`
   * about a board nobody had touched, and the agent — correctly following the
   * error's own advice — re-read and retried, twice, at a full LLM round trip
   * each.
   *
   * A guard that fires on a board nobody edited is not a safety feature; it is a
   * random failure with a reassuring name.
   */
  const addGuard = (_args: Record<string, unknown>) => checkWritable(board);

  /** Resolve a shot id, or say plainly that it is gone. */
  const needShot = (id: string) =>
    readShot(board.std, id)
      ? null
      : fail('not_found', `No shot with id ${id}. Call board_read for the current ids.`);

  const handlers: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {
    /** Read the board. Cheap, no side effects — the agent may call it freely. */
    'voidspace:board-read': () => digest(board),

    /**
     * THE SCREENPLAY — written whole, as Fountain.
     *
     * ONE STRING, and it replaces the document. There is no "append a scene"
     * verb, because a screenplay is a shape: a tool that could only append would
     * let an agent bolt a fourth sequence onto a three-sequence piece without
     * ever reconsidering the first three. A rewrite is one Ctrl+Z, so a bad
     * draft costs the user one gesture.
     *
     * SCENE KEYS SURVIVE A REWRITE as long as the sluglines do — they are
     * derived from the slugline, not from position — so a rewrite that adds a
     * scene in the middle does not orphan the shots below it. Renaming a
     * slugline DOES orphan that scene's shots, visibly, as `offScript`.
     */
    'voidspace:board-write-script': args => {
      const g = guard(args); if (!g.ok) return g;
      if (typeof args.text !== 'string') {
        return fail('empty', 'Send the whole screenplay as `text`, in Fountain.');
      }
      writeScript(board.std, board.surfaceId, args.text);
      /**
       * THE SCRIPT IS THE BOARD'S SHAPE, so writing one re-lays the board.
       *
       * Rows are scenes and blocks of rows are sequences (`shot/layout.ts`), so
       * adding a scene, reordering two, or splitting an act changes where every
       * card below it belongs. Without this the cards stay on the old grid while
       * the spine is drawn on the new one — brackets around the wrong rows,
       * which is worse than no brackets.
       *
       * `relayoutShots` writes nothing for a card already in the right place, so
       * an edit that does not change the structure costs one comparison a shot.
       */
      relayoutShots(board.std, readShots(board.std).map(s => s.id));
      rev++;
      return digest(board);
    },

    /**
     * ONE SCENE, VERBATIM — the T2 tier.
     *
     * Read-only and free. This is how the agent loads the scene it is about to
     * cover without carrying the whole script every turn. Verbatim because it is
     * about to decide how to photograph it, and a summary of a scene is not a
     * scene: the detail the action lingers on is exactly what a shot contains.
     */
    'voidspace:board-read-script': args => {
      const script = readParsed(board.std);
      const key = String(args.sceneKey ?? '').trim();

      if (!key) {
        // No scene asked for → the map, plus as much text as fits.
        const ctx = renderScriptContext(script, String(args.focus ?? '') || null);
        return {
          ok: true as const,
          rev,
          mode: ctx.mode,
          totalScenes: ctx.totalScenes,
          included: ctx.included,
          text: ctx.body,
        };
      }

      const text = renderScene(script, key);
      if (text === null) {
        return fail(
          'unknown_scene',
          `No scene "${key}" in the screenplay. Call board_read for the scene keys — `
          + 'the slugline may have been rewritten since you last looked.',
        );
      }
      return { ok: true as const, rev, mode: 'scene' as const, sceneKey: key, text };
    },

    /** Put a shot on a scene, or take it off. */
    'voidspace:board-set-scene': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const missing = needShot(shotId); if (missing) return missing;
      const sceneKey = String(args.sceneKey ?? '').trim();
      if (sceneKey) {
        const script = readParsed(board.std);
        if (!script.scenes.some(c => c.key === sceneKey)) {
          return fail(
            'unknown_scene',
            `No scene "${sceneKey}" in the screenplay. Call board_read for the scene keys.`,
          );
        }
      }
      setShotFields(board.std, shotId, { sceneKey } as never);
      rev++;
      return digest(board);
    },

    /**
     * PUT A BLOCK DRAFT ON THE CANVAS — the scratch pad.
     *
     * Composing does NOT save. It renders the design where the user can see it
     * at a size worth judging, next to the shots it will sit among, and leaves
     * it inert until they say yes. A block is reusable and shadows a starter of
     * the same name, so saving one is a commitment nobody should make on the
     * user's behalf.
     *
     * ONE DRAFT PER NAME. "Make the headline bigger" rewrites the card that is
     * already there rather than stacking a second one beside it — a scratch pad
     * with six near-identical versions on it is one nobody can read.
     */
    'voidspace:board-draft-block': args => {
      const g = guard(args); if (!g.ok) return g;
      const name = String(args.name ?? '').trim();
      const html = String(args.html ?? '');
      if (!name) return fail('empty', 'A draft needs a name.');
      if (!html.trim()) return fail('empty', 'A draft needs its HTML.');

      const meta = JSON.stringify(args.meta && typeof args.meta === 'object' ? args.meta : {});
      const existing = board.std.store
        .getBlocksByFlavour('voidspace:blockdraft')
        .map(b => b.model as DraftBlockModel)
        .find(m => m.props.name === name);

      if (existing) {
        board.std.store.captureSync();
        board.std.store.updateBlock(existing, { html, meta, status: 'draft', note: '' });
        rev++;
        // Scroll to it: an update the user cannot see is an update they will
        // assume did not happen.
        ensureVisible(bounds(existing.props));
        return { ok: true as const, rev, blockId: existing.id, updated: true };
      }

      /**
       * PLACED ABOVE THE FILMSTRIP, not in it.
       *
       * A draft is not a shot and must not read as one while someone scans left
       * to right. Sitting it clear of the strip keeps the film legible and gives
       * the design its own space.
       */
      const shots = readShots(board.std);
      const x = shots.length ? shots[shots.length - 1].x + 260 : 0;
      const id = board.std.store.addBlock(
        'voidspace:blockdraft',
        { name, html, meta, status: 'draft', note: '', xywh: `[${x},${-(DRAFT_H + 140)},${DRAFT_W},${DRAFT_H}]` },
        board.surfaceId,
      );
      rev++;
      const made = board.std.store.getBlock(id)?.model as DraftBlockModel | undefined;
      if (made) ensureVisible(bounds(made.props));
      return { ok: true as const, rev, blockId: id, updated: false };
    },

    /** What the page needs to save a draft: its name, html and manifest. */
    'voidspace:board-read-draft': args => {
      const id = String(args.blockId ?? '');
      const m = board.std.store.getBlock(id)?.model as DraftBlockModel | undefined;
      if (!m || m.flavour !== 'voidspace:blockdraft') {
        return fail('not_found', `No block draft ${id}.`);
      }
      let meta: unknown = {};
      try { meta = JSON.parse(m.props.meta || '{}'); } catch { /* keep {} */ }
      return {
        ok: true as const,
        rev,
        blockId: id,
        name: m.props.name,
        html: m.props.html,
        meta,
        status: m.props.status,
      };
    },

    /** Report the outcome of a save back onto the card. */
    'voidspace:board-settle-draft': args => {
      const id = String(args.blockId ?? '');
      const m = board.std.store.getBlock(id)?.model as DraftBlockModel | undefined;
      if (!m) return fail('not_found', `No block draft ${id}.`);
      board.std.store.updateBlock(m, {
        status: args.saved === true ? 'saved' : 'draft',
        note: String(args.note ?? ''),
      });
      rev++;
      return { ok: true as const, rev, blockId: id };
    },

    'voidspace:board-remove-draft': args => {
      const id = String(args.blockId ?? '');
      const b = board.std.store.getBlock(id);
      if (!b) return fail('not_found', `No block draft ${id}.`);
      board.std.store.captureSync();
      board.std.store.deleteBlock(b.model);
      rev++;
      return { ok: true as const, rev };
    },

    'voidspace:board-add-shots': args => {
      const g = guard(args); if (!g.ok) return g;
      const titles = Array.isArray(args.titles) ? args.titles.map(String) : [];
      if (!titles.length) return fail('empty', 'No shot titles were given.');
      /**
       * SHOTS REMEMBER WHICH SCENE THEY COVER.
       *
       * Optional, and validated when given. Without the link the screenplay and
       * the filmstrip are two documents that merely happen to be about the same
       * film, and nothing can answer "which scene still has no shots".
       */
      const sceneKey = String(args.sceneKey ?? '').trim();
      if (sceneKey && !readParsed(board.std).scenes.some(c => c.key === sceneKey)) {
        return fail(
          'unknown_scene',
          `No scene "${sceneKey}" in the screenplay. Call board_read for the scene keys, `
          + 'or write the screenplay first with board_write_script.',
        );
      }
      const made = createShots(board.std, board.surfaceId, titles);
      if (sceneKey) {
        for (const id of made) setShotFields(board.std, id, { sceneKey } as never);
      }
      /**
       * SHOW WHAT WAS JUST MADE.
       *
       * The agent had to remember to call board_fit, and when it forgot, a user
       * who asked for a six-shot storyboard watched nothing happen — the shots
       * were laid out off-screen, or scene 1 landed under the asset panel.
       * `ensureVisible` only moves the viewport when the new work is not
       * already on screen, so someone zoomed into scene 4 asking for one more
       * shot does not get yanked away from what they were looking at.
       */
      const all = readShots(board.std);
      const last = all[all.length - 1];
      if (last) ensureVisible({ x: last.x, y: 0, w: SHOT_W, h: SHOT_H });
      return digest(board);
    },

    /**
     * Write the shot's text.
     *
     * All four fields in one call, because the agent nearly always has them
     * together — asking it to make four round trips per scene would triple the
     * latency of writing a storyboard for no gain in safety.
     */
    'voidspace:board-update-shot': args => {
      const g = guard(args); if (!g.ok) return g;
      const id = String(args.shotId ?? '');
      const missing = needShot(id); if (missing) return missing;

      const patch: Record<string, string> = {};
      for (const key of ['title', 'action', 'voiceover', 'camera'] as const) {
        if (typeof args[key] === 'string') patch[key] = args[key] as string;
      }
      if (!Object.keys(patch).length) {
        return fail('empty', 'Give at least one of title, action, voiceover or camera.');
      }
      setShotFields(board.std, id, patch);
      return digest(board);
    },

    'voidspace:board-reorder-shots': args => {
      const g = guard(args); if (!g.ok) return g;
      const ids = Array.isArray(args.shotIds) ? args.shotIds.map(String) : [];
      const known = new Set(readShots(board.std).map(s => s.id));
      // Refuse a partial order rather than silently dropping shots off the end:
      // a storyboard quietly losing a scene is far worse than a rejected call.
      const missing = [...known].filter(id => !ids.includes(id));
      if (ids.length !== known.size || missing.length) {
        return fail(
          'incomplete_order',
          `Reorder must list every shot exactly once (${known.size} on the board, `
          + `${ids.length} given). Call board_read for the current ids.`,
        );
      }
      relayoutShots(board.std, ids);
      return digest(board);
    },

    'voidspace:board-delete-shot': args => {
      const g = guard(args); if (!g.ok) return g;
      const id = String(args.shotId ?? '');
      if (!deleteShot(board.std, id)) return fail('not_found', `No shot with id ${id}.`);
      return digest(board);
    },

    /**
     * Attach a Library asset to a shot.
     *
     * Nothing is downloaded and nothing is placed on the canvas — the shot owns
     * its media, so this is an append to a list. That is why it is instant for a
     * 4K master and why fifty references cost the document a few kilobytes.
     */
    'voidspace:board-attach-media': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const missing = needShot(shotId); if (missing) return missing;

      /**
       * FROM THE CANVAS — the hole this closes.
       *
       * The user can drag a picture off the board onto a shot (`canvas-drop.ts`)
       * and the agent could not do the same thing, because attaching took a URL
       * and a canvas read deliberately withholds URLs (they are long, signed, and
       * not something a language model should hold). So "put that one on scene 2"
       * — about a picture the agent had just generated and could see — was
       * unanswerable. Two collaborators, one board, and only one of them could
       * move a reference into a scene.
       *
       * Resolved HERE, board-side, so the URL still never crosses to the model.
       * Behaves exactly like the drag: it MOVES, because leaving a copy behind
       * gives the user two of the same thing and no way to tell which one the
       * video will use. `keepOnCanvas` covers the honest exception — the same
       * reference wanted in two scenes.
       */
      const canvasId = String(args.canvasId ?? '');
      if (canvasId) {
        const from = canvasMediaFor(board.std, canvasId);
        if (!from) {
          return fail(
            'not_found',
            `${canvasId} is not media on the canvas. Call board_canvas_read for the current ids.`,
          );
        }
        const target = readShot(board.std, shotId);
        const legal = rolesFor(
          target?.kind ?? 'clip',
          from.kind,
          findBlock(target?.composition ?? '')?.slots,
        );
        const asked = String(args.role ?? '');
        const role: MediaRole = legal.includes(asked)
          ? asked
          : from.kind === 'audio' ? 'sfx' : 'reference';

        board.store.captureSync();
        const newId = addMedia(board.std, shotId, { ...from, role });
        if (!newId) return fail('rejected', 'That shot would not take this asset.');

        if (typeof args.tag === 'string' || typeof args.note === 'string') {
          tagMedia(board.std, shotId, newId, {
            ...(typeof args.tag === 'string' && args.tag.trim() ? { tag: args.tag } : {}),
            ...(typeof args.note === 'string' && args.note.trim() ? { note: args.note } : {}),
          });
        }

        if (args.keepOnCanvas !== true) {
          const block = board.std.store.getBlock(canvasId);
          if (block) board.std.store.deleteBlock(block.model);
        }
        rev++;
        return { ...digest(board), attachedId: newId, movedFromCanvas: canvasId };
      }

      const url = String(args.url ?? args.originalUrl ?? '');
      if (!url) {
        return fail('empty', 'Give a `url` from search_media, or a `canvasId` from board_canvas_read.');
      }
      const kind = args.kind === 'video' ? 'video' : args.kind === 'audio' ? 'audio' : 'image';
      /**
       * ASK WHAT IS LEGAL FOR THIS SHOT, not what is in the fixed list.
       *
       * A graphic's roles are its BLOCK'S OWN SLOT NAMES — `screenshot`,
       * `portrait` — so checking `MEDIA_ROLES` rejected every one of them and
       * quietly fell back to `reference`. The agent set the role it was told to
       * set, got a success, and the slot stayed empty.
       *
       * Default by kind when the role is not legal here: `reference` is
       * additive when wrong, whereas a wrong first frame silently changes the
       * video the user finally gets.
       */
      const target = readShot(board.std, shotId);
      const legalRoles = rolesFor(
        target?.kind ?? 'clip',
        kind,
        findBlock(target?.composition ?? '')?.slots,
      );
      const asked = String(args.role ?? '');
      const role: MediaRole = legalRoles.includes(asked)
        ? asked
        : kind === 'audio' ? 'sfx' : 'reference';

      const refKind = REF_KINDS.includes(args.refKind as RefKind)
        ? (args.refKind as RefKind)
        : undefined;

      const id = addMedia(board.std, shotId, {
        kind,
        role,
        url,
        // The tile draws the display variant; compile reads `url`.
        src: String(args.displayUrl ?? url),
        poster: typeof args.posterUrl === 'string' ? args.posterUrl : undefined,
        name: String(args.name ?? '').trim() || kind,
        mediaId: typeof args.mediaId === 'string' ? args.mediaId : undefined,
        scope: typeof args.scope === 'string' ? args.scope : undefined,
        // Named at attach time when the agent already knows — saves a round trip
        // for the common case of "find a shot of a kitchen and call it kitchen".
        ...(refKind ? { refKind } : {}),
        ...(typeof args.sourceUrl === 'string' ? { sourceUrl: args.sourceUrl } : {}),
        ...(typeof args.credit === 'string' ? { credit: args.credit } : {}),
      });
      if (!id) return fail('rejected', 'That shot would not take this asset.');
      /**
       * THE NOTE COMES IN HERE TOO, not only via board_tag_reference.
       *
       * The direction people give ("use this sting right as she says hello
       * everybody") arrives in the SAME breath as the request to attach the
       * file. Requiring a second call for it meant the agent attached the sfx,
       * moved on, and the instruction was never written anywhere — it reached
       * neither the scene doc nor the screenplay, and nothing said so.
       */
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      if ((typeof args.tag === 'string' && args.tag.trim()) || note) {
        tagMedia(board.std, shotId, id, {
          ...(typeof args.tag === 'string' && args.tag.trim() ? { tag: args.tag } : {}),
          ...(note ? { note } : {}),
        });
      }
      return { ...digest(board), attachedId: id };
    },

    'voidspace:board-remove-media': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const id = String(args.mediaId ?? '');
      if (!removeMedia(board.std, shotId, id)) {
        return fail('not_found', `Shot ${shotId} has no media with id ${id}.`);
      }
      return digest(board);
    },

    /**
     * Hand the board the model catalogue. Sent by the parent page on mount.
     *
     * NOT an agent tool — it is configuration arriving, and the board is a
     * consumer of it. See `shot/models.ts` for why it is received rather than
     * written down here.
     */
    'voidspace:board-models': args => {
      const models = Array.isArray(args.models) ? (args.models as ModelCaps[]) : [];
      setModelCatalogue(models, String(args.defaultModel ?? ''));
      return { ok: true as const, rev, modelCount: allModels().length };
    },

    /**
     * Hand the board the HyperFrames block library.
     *
     * Same arrangement as the models, and for the same reason: the blocks live
     * on the user's machine and are listed by `POST /api/studio/blocks`, which
     * an iframe with no session cannot call. Received, never guessed — the
     * library grows as people create and share blocks, so any list written down
     * here would be wrong by the following week.
     */
    'voidspace:board-blocks': args => {
      setBlockCatalogue(Array.isArray(args.blocks) ? args.blocks : []);
      return { ok: true as const, rev, blockCount: allBlocks().length };
    },

    /** What the agent can choose from when a shot is a graphic. */
    /**
     * The library, FILTERED AND CAPPED.
     *
     * There are 128 starter blocks on a stock install and a user's own on top,
     * so the whole list is thousands of tokens of mostly-irrelevant transitions
     * every time the agent glances at it. `q` matches name, description, tags
     * and category — the agent almost always knows roughly what it wants ("stat",
     * "lower third", "transition") — and the cap is REPORTED rather than
     * silently applied, so a truncated answer never reads as the whole library.
     *
     * Empty fields are omitted rather than sent as '' / false: on a list this
     * long, the defaults are most of the payload.
     */
    'voidspace:board-block-catalog': args => {
      const q = String(args?.q ?? args?.tag ?? '').trim().toLowerCase();
      const all = allBlocks();
      // Ranked, and the SAME ranker the on-card picker uses — the agent and the
      // user must not get different answers to the same question.
      const matched = q ? searchBlocks(q, all) : all;
      const LIMIT = 60;
      const page = matched.slice(0, LIMIT);
      return {
        ok: true as const,
        rev,
        total: all.length,
        matched: matched.length,
        ...(matched.length > page.length
          ? {
              truncated: true,
              note: `Showing ${page.length} of ${matched.length}. Pass q to narrow `
                + '(name, description, tag or category) — e.g. "stat", "lower third", "transition".',
            }
          : {}),
        blocks: page.map(b => ({
          name: b.name,
          ...(b.description ? { description: b.description } : {}),
          ...(b.category ? { category: b.category } : {}),
          ...(b.tags.length ? { tags: b.tags } : {}),
          // Only worth saying when it is the user's own — that is the signal.
          ...(b.tier === 'user' ? { tier: 'user' } : {}),
          // 'adapt' means its content is BAKED IN — it needs its HTML edited with
          // this video's words, not just filling. The single most important fact
          // about a block, and the one that decides whether it can be used as-is.
          ...(b.fill === 'adapt' ? { fill: 'adapt' } : {}),
          ...(b.overlay ? { overlay: true } : {}),
          ...(b.slots.length
            ? { slots: b.slots.map(sl => ({ key: sl.key, kind: sl.kind, ...(sl.sample ? { sample: sl.sample } : {}) })) }
            : {}),
        })),
      };
    },

    /**
     * Make a shot a graphic (or a clip), and say which block it uses.
     *
     * One handler rather than two because they are one decision: choosing a
     * block only means anything on a graphic, and switching to a graphic
     * without one leaves a shot that cannot render.
     */
    'voidspace:board-set-composition': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const missing = needShot(shotId); if (missing) return missing;

      const patch: Record<string, unknown> = {};
      if (args.kind !== undefined) patch.kind = normaliseShotKind(args.kind);
      if (typeof args.composition === 'string') {
        const name = args.composition.trim();
        if (name && allBlocks().length && !findBlock(name)) {
          return fail(
            'unknown_block',
            `No block named "${name}" in the library. Call board_block_catalog for the names.`,
          );
        }
        patch.composition = name;
        // Choosing a block implies this is a graphic — otherwise the choice sits
        // on a shot that will never render it.
        if (args.kind === undefined && name) patch.kind = 'hyperframes';
        /**
         * A DIFFERENT BLOCK MEANS DIFFERENT SLOTS.
         *
         * Slot values belong to the block that declared them: carrying
         * `stat: "92%"` into a quote card puts a number where the quote goes,
         * and the preview shows it, because the shim passes every key through
         * whether the block declared it or not. The drag path already cleared
         * them (`handleBlockDrop`); the agent path did not, so the same shot
         * behaved differently depending on who changed it.
         *
         * Values sent WITH this call still win — they are the new block's.
         */
        const prev = readShot(board.std, shotId)?.composition ?? '';
        if (prev && prev !== name && args.variables === undefined) patch.compositionVars = {};
      }
      /**
       * VALUES ARE CHECKED AGAINST WHAT THE BLOCK DECLARES.
       *
       * The shim passes every key through whether the block asked for it or
       * not, so a typo — `headine` for `headline` — renders the placeholder and
       * looks exactly like the value never arriving. Unknown keys are DROPPED
       * and named back, together with the ones that would have worked, so the
       * agent can correct itself in one turn instead of guessing.
       *
       * Dropped rather than refused: a call that half-worked and says so is
       * more useful than one that did nothing, and the shot is still improved
       * by the keys that were right.
       */
      let ignored: string[] = [];
      let accepted: string[] = [];
      if (args.variables && typeof args.variables === 'object') {
        const name = typeof patch.composition === 'string'
          ? patch.composition
          : (readShot(board.std, shotId)?.composition ?? '');
        const block = findBlock(name);
        const declared = new Set((block?.slots ?? []).map(sl => sl.key));
        const vars: Record<string, string> = {};
        for (const [k, v] of Object.entries(args.variables as Record<string, unknown>)) {
          if (typeof v !== 'string' && typeof v !== 'number') continue;
          // A block that declares nothing takes anything — the 26 baked-in
          // designs have no manifest to check against.
          if (declared.size && !declared.has(k)) { ignored.push(k); continue; }
          vars[k] = String(v);
          accepted.push(k);
        }
        patch.compositionVars = vars;
      }
      if (!Object.keys(patch).length) {
        return fail('empty', 'Give a kind, a composition, variables, or any combination.');
      }
      setShotFields(board.std, shotId, patch as never);

      if (ignored.length) {
        const block = findBlock(
          typeof patch.composition === 'string'
            ? patch.composition
            : (readShot(board.std, shotId)?.composition ?? ''),
        );
        return {
          ...digest(board),
          ignoredKeys: ignored,
          accepted,
          note: `${block?.name ?? 'That block'} has no slot called `
            + `${ignored.map(k => `"${k}"`).join(', ')}. It declares: `
            + `${(block?.slots ?? []).map(sl => `${sl.key} (${sl.kind})`).join(', ')}.`,
        };
      }
      return digest(board);
    },

    /**
     * What the agent needs to CHOOSE a model, with the reasons attached.
     *
     * Everything here comes from `VideoGenConfig` via the parent — durations,
     * what speaks, what takes an end frame, what reads @-tags, what it costs.
     * The agent is expected to reason from these rather than from anything it
     * remembers about a model name, because model line-ups change and a
     * confidently wrong recommendation costs the user a generation.
     */
    'voidspace:board-model-catalog': () => ({
      ok: true as const,
      rev,
      models: allModels().map(m => ({
        id: m.id,
        label: m.label,
        credits: m.credits,
        locked: m.locked,
        durations: m.allowedDurations.length
          ? m.allowedDurations
          : [m.minDurationSec, m.maxDurationSec],
        maxDurationSec: m.maxDurationSec,
        speaks: m.nativeDialogue,
        ambientAudio: m.nativeAudio,
        takesVoiceReference: m.acceptsVoiceReference,
        takesLastFrame: m.supportsLastFrame,
        readsReferenceTags: m.usesReferenceTags,
        referenceTagSyntax: m.referenceTagSyntax,
        // HOW MANY, not just whether. An agent choosing from this list was told
        // a model reads references and never how many it accepts, so nothing
        // here stopped it attaching twelve stills to a model that carries seven
        // — the surplus is dropped at generation, after the user has paid.
        // Counted per kind across the whole shot, first-frame included, which
        // is how they are numbered and packed.
        maxRefImages: m.maxRefImages,
        maxRefVideos: m.maxRefVideos,
        maxRefAudios: m.maxRefAudios,
        deliveryModes: m.deliveryModes,
      })),
    }),

    /**
     * Choose the model for one shot.
     *
     * Per shot on purpose — see `ShotProps.model`. Rejects an unknown id rather
     * than storing it: a typo would be discovered at generation time, long after
     * the user was told the shot was configured.
     */
    'voidspace:board-set-shot-model': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const missing = needShot(shotId); if (missing) return missing;

      const modelId = String(args.model ?? '');
      if (modelId && !findModel(modelId)) {
        return fail(
          'unknown_model',
          `No video model with id ${modelId}. Call board_model_catalog for the ids in use.`,
        );
      }
      const patch: { model: string; durationSec?: number } = { model: modelId };
      if (args.durationSec !== undefined) {
        patch.durationSec = Math.max(0, Math.round(Number(args.durationSec) || 0));
      }
      setShotFields(board.std, shotId, patch);
      return digest(board);
    },

    /**
     * Name a reference, and say what it is OF.
     *
     * This is what makes a reference addressable in a prompt. A model receives
     * references as bare numbers, so "@Image2" is all it knows; the tag is how
     * the user, the agent and the compiled legend all refer to the same thing
     * by a word that means something.
     */
    'voidspace:board-tag-media': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const id = String(args.mediaId ?? '');
      const refKind = args.refKind as RefKind | undefined;
      if (refKind !== undefined && !REF_KINDS.includes(refKind)) {
        return fail('bad_ref_kind', `refKind must be one of ${REF_KINDS.join(', ')}.`);
      }
      const patch: { tag?: string; refKind?: RefKind; note?: string } = {};
      if (typeof args.tag === 'string') patch.tag = args.tag;
      if (refKind !== undefined) patch.refKind = refKind;
      if (typeof args.note === 'string') patch.note = args.note;
      if (!Object.keys(patch).length) {
        return fail('empty', 'Give a tag, a refKind, a note, or any combination.');
      }
      if (!tagMedia(board.std, shotId, id, patch)) {
        return fail('not_found', `Shot ${shotId} has no media with id ${id}.`);
      }
      return digest(board);
    },

    /**
     * Say WHICH SECONDS of a clip are the reference.
     *
     * The case this exists for: somebody records one take and storyboards from
     * it. Scene 2 is the four seconds where she turns to the window; scene 5 is
     * a different four seconds of the same file. Neither is "the video", and
     * cutting the file first would defeat the point of storyboarding before you
     * edit.
     *
     * Clamped and ordered by `trimMedia`, so an estimate that runs past the end
     * of the clip is corrected rather than refused — but the agent should read
     * `durationSec` first rather than guessing, because a window it invents is
     * a moment the user never chose.
     */
    'voidspace:board-trim-reference': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const id = String(args.mediaId ?? '');
      const num = (v: unknown) =>
        v === null ? null : v === undefined ? undefined : Number(v);
      const inSec = num(args.inSec);
      const outSec = num(args.outSec);
      if (inSec === undefined && outSec === undefined) {
        return fail('empty', 'Give inSec, outSec, or both. Pass null to clear one.');
      }
      if ((inSec !== undefined && inSec !== null && !Number.isFinite(inSec))
        || (outSec !== undefined && outSec !== null && !Number.isFinite(outSec))) {
        return fail('bad_time', 'inSec and outSec must be seconds, or null to clear.');
      }
      if (!trimMedia(board.std, shotId, id, { inSec, outSec })) {
        return fail('not_found', `Shot ${shotId} has no media with id ${id}.`);
      }
      return digest(board);
    },

    /**
     * Say what a reference is FOR.
     *
     * The one thing compile cannot work out for itself: nothing about a still
     * says whether it is the frame the video opens on or a mood reference, and
     * getting it wrong produces the wrong video with no visible cause. Slot
     * roles are exclusive — `setMediaRole` demotes the previous holder rather
     * than leaving a shot with two first frames.
     */
    'voidspace:board-set-role': args => {
      const g = guard(args); if (!g.ok) return g;
      const role = args.role as MediaRole;
      if (!MEDIA_ROLES.includes(role)) {
        return fail('bad_role', `Role must be one of ${MEDIA_ROLES.join(', ')}.`);
      }
      const shotId = String(args.shotId ?? '');
      const id = String(args.mediaId ?? '');
      if (!setMediaRole(board.std, shotId, id, role)) {
        return fail('not_found', `Shot ${shotId} has no media with id ${id}.`);
      }
      return digest(board);
    },

    /**
     * EVERYTHING NEEDED TO GENERATE ONE SHOT, gathered board-side.
     *
     * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────
     * The card raises intent; the page owns the network (same split as
     * `draft-save`). But the page cannot compose the request itself: the shot's
     * references live in the block, and the digest deliberately carries no urls
     * — that rule exists so a language model never holds a signed Library url.
     *
     * So this is the PAGE-ONLY channel. It returns full-quality urls because the
     * page is what calls the provider; nothing here is ever put in front of a
     * model. `board_read` remains url-free, and the two must not be merged.
     *
     * ── THE PROMPT IS ASSEMBLED HERE, NOT ON THE PAGE ────────────────────────
     * Because the pieces are here: the written fields, the reference ORDER a
     * model receives them in, and the model's own tag spelling. Composing it on
     * the page would mean a second implementation of the ordering rule, which is
     * the thing that decides whether "@Image2 walks into frame" points at the
     * right picture.
     */
    'voidspace:board-shot-gen-input': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const shot = readShot(board.std, shotId);
      if (!shot) return fail('not_found', `No shot ${shotId} on this board.`);

      // A graphic is RENDERED from a block, not generated by a model. Offering
      // it here would charge for something that has a free, exact path.
      if (shot.kind === 'hyperframes') {
        return fail(
          'not_generatable',
          'That shot is a graphic — it renders from its HyperFrames block rather than '
          + 'being generated, so there is nothing to charge for.',
        );
      }

      const caps = effectiveModel(shot.model);

      /**
       * Local models reach generation now — see the `local:` branch in
       * `useStudioMediaGenerator.generateVideo`, which posts to
       * /api/studio/local-gen-start and polls the node instead of a provider.
       *
       * This used to refuse here, because the Generate button always posted to
       * gen-clip-start, which resolves ids through the cloud registry and threw
       * "Unknown video model" for anything shaped `local:<node>/<recipe>` — a
       * model the user could see in the picker and had just chosen. The refusal
       * was a placeholder for exactly the branch that now exists.
       */

      const written = [shot.action, shot.camera].map(s => s.trim()).filter(Boolean).join(' ');
      if (!written) {
        return fail(
          'empty',
          'That shot has nothing written in it yet. A model needs to be told what happens '
          + 'before it can film it.',
        );
      }

      /**
       * REFERENCES IN THE ORDER THE MODEL RECEIVES THEM.
       *
       * Identical to compile's ordering, because the positional tags are
       * numbered from it — a legend that disagrees with the array is worse than
       * no legend, since the prompt then names the wrong picture confidently.
       */
      const ordered = [...shot.media]
        .filter(m => m.kind !== 'audio' && (m.url || m.src))
        .sort((a, b) => GEN_ROLE_ORDER.indexOf(a.role) - GEN_ROLE_ORDER.indexOf(b.role));

      // Only for models that read tags — for the rest it is noise that the model
      // will try to render as words on screen.
      const legend = caps?.usesReferenceTags
        ? ordered
            .map(m => {
              const tag = referenceTag(caps, shot.media, m.id);
              const what = [m.tag, m.refKind].filter(Boolean).join(', ');
              return tag && what ? `${tag} is ${what}` : '';
            })
            .filter(Boolean)
            .join('. ')
        : '';

      // The user's own direction for a reference, verbatim. It is the one part
      // of a prompt nobody else can write, so it must not be paraphrased away.
      const notes = ordered.map(m => m.note?.trim()).filter(Boolean).join(' ');

      /**
       * WHETHER THE MODEL SPEAKS — a fact about the MODEL, not a per-shot
       * setting the user has to find and remember.
       *
       * ── WHAT THIS REPLACED ────────────────────────────────────────────────
       * It read `shot.voiceMode === 'dialogue' && caps.nativeDialogue`, and the
       * card carried a Speaks / Silent toggle to set the first half. That was a
       * third control deciding something the writing had already decided twice:
       * SHOT describes the video including any dialogue in it, and NARRATION is
       * a separate track laid over the top. Worse, it defaulted to SILENT — so
       * a shot whose prompt said `she says "welcome my viewers"` generated a
       * silent clip, with nothing on the card explaining why.
       *
       * ── AND WHY ENABLING IT IS SAFE ───────────────────────────────────────
       * `dialogue` does not COMMAND speech, it permits it: a model with native
       * dialogue speaks the lines it finds in the prompt and stays quiet when
       * there are none. So the prompt decides, which is what everybody already
       * believed was happening.
       *
       * The capability gate is unchanged and still matters. Asking a model that
       * cannot speak for dialogue either errors deep in a provider or is
       * accepted and ignored, and the user is charged for a clip that was never
       * going to speak.
       */
      const wantsDialogue = !!caps?.nativeDialogue;

      return {
        ok: true as const,
        shotId,
        title: shot.title,
        prompt: [written, legend, notes].filter(Boolean).join(' '),
        // FULL QUALITY. The card draws the display variant; a generation must
        // be given the master or the output is built from a thumbnail.
        referenceUrls: ordered.map(m => m.url || m.src),
        model: shot.model,
        effectiveModel: caps?.id ?? '',
        /**
         * THE LENGTH THIS MODEL WILL ACTUALLY PRODUCE — snapped, not requested.
         *
         * `plannedSeconds` clamps to the model's range AND snaps to its discrete
         * `allowedDurations`, so the number sent to generate is the same one the
         * card costed and totalled. Sending the raw request instead would have
         * the provider round it silently, after the charge, to a length nothing
         * on screen had ever mentioned.
         */
        durationSec: plannedSeconds({ kind: shot.kind, model: shot.model, durationSec: shot.durationSec }),
        /** What the user asked for, so the page can say if it moved. */
        requestedDurationSec: shot.durationSec,
        /**
         * SIZE AND SHAPE, RESOLVED THE SAME WAY THE PRICE WAS.
         *
         * `resolutionFor` is what the card costed with, so sending anything else
         * would quote one size and render another. It also drops a stored value
         * the model no longer offers — a board saved at 1080p and since switched
         * to a 720p-only tier must not send 1080p and fail at the provider after
         * the user has waited for it.
         *
         * Empty when the model exposes no choice, and omitted rather than sent
         * blank: a generator reading `resolution: ''` has to decide what that
         * means, and every one of them would decide differently.
         */
        ...(resolutionFor(shot) ? { resolution: resolutionFor(shot) } : {}),
        ...(aspectFor(shot) ? { aspect: aspectFor(shot) } : {}),
        voiceMode: wantsDialogue ? 'dialogue' : 'silent',
        /**
         * A NARRATION IS ALWAYS SEPARATE. That is what the field means — the
         * card says so under it, in the placeholder: "spoken separately, not by
         * the video".
         *
         * This read `voiceover && !wantsDialogue`, which said the opposite on a
         * model that speaks: write a narrator's line against Seedance and the
         * clip claimed the narration was NOT separate, i.e. handed the
         * voiceover to the video model to perform on camera. A narrator is not a
         * character in the scene, and this is the flag that decides which one
         * the line becomes.
         */
        narrationIsSeparate: !!shot.voiceover.trim(),
        takeNumber: shot.takes.length + 1,
      };
    },

    /**
     * ── TAKES ────────────────────────────────────────────────────────────────
     *
     * Record an attempt at a shot. APPENDS, always — there is deliberately no
     * op that replaces a take, because that invariant is what makes the board
     * safe to hand to an agent: it cannot destroy footage the user paid for, no
     * matter what it decides to do.
     *
     * The generation itself belongs to the PAGE (`useStudioMediaGenerator` owns
     * model choice, idempotency, credits and the Library mirror). This only
     * records the outcome, which is why it takes a url rather than a prompt.
     */
    'voidspace:board-add-take': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const url = String(args.url ?? '');
      const status = args.status === 'running' || args.status === 'failed'
        ? args.status : 'ready';
      /**
       * A RUNNING TAKE HAS NO URL YET — that is what running means.
       *
       * This required one unconditionally, so the placeholder row the page
       * writes when a render STARTS was refused. The damage was not the missing
       * spinner: `generateShot` keeps the returned `takeId` and gates the
       * completion update on it, so the refusal at the start silently discarded
       * the FINISHED clip too. The board generated, the file landed in the
       * Library, and the shot came back looking untouched.
       *
       * A failed take has no url either, for the same reason. Ready still needs
       * one — a finished take with nothing to play is the case worth refusing.
       */
      if (!url && status === 'ready') return fail('bad_request', 'A finished take needs a url.');
      const id = addTake(board.std, shotId, {
        url,
        // The card draws `src`; only the render uses `url`. A caller that sends
        // one url gets it in both rather than a blank tile — wrong-but-visible
        // beats invisible, and it is the display variant that is optional.
        src: String(args.src ?? url),
        ...(args.poster ? { poster: String(args.poster) } : {}),
        ...(args.mediaId ? { mediaId: String(args.mediaId) } : {}),
        kind: args.kind === 'image' ? 'image' : 'video',
        durationSec: Number(args.durationSec ?? 0) || 0,
        status,
        ...(args.error ? { error: String(args.error) } : {}),
        ...(args.jobId ? { jobId: String(args.jobId) } : {}),
        ...(args.nodeVia === 'loopback' || args.nodeVia === 'mesh'
          ? { nodeVia: args.nodeVia } : {}),
        ...(args.nodeName ? { nodeName: String(args.nodeName) } : {}),
        createdAt: new Date().toISOString(),
        ...(args.label ? { label: String(args.label) } : {}),
        source: TAKE_SOURCES.has(String(args.source))
          ? String(args.source) as ShotTake['source'] : 'generated',
        ...(args.model ? { model: String(args.model) } : {}),
        ...(args.runtime === 'local' || args.runtime === 'cloud'
          ? { runtime: args.runtime } : {}),
        ...(Number.isFinite(Number(args.seed)) && args.seed !== undefined
          ? { seed: Number(args.seed) } : {}),
        ...(args.promptUsed ? { promptUsed: String(args.promptUsed) } : {}),
        ...(Number.isFinite(Number(args.costCredits)) && args.costCredits !== undefined
          ? { costCredits: Number(args.costCredits) } : {}),
      });
      if (!id) return fail('not_found', `No shot ${shotId} on this board.`);

      // FIRST READY TAKE IS THE SHOT, without being asked. A shot with one take
      // and no choice recorded has only one possible answer, and making the user
      // confirm it would be ceremony. `chooseTake` refuses anything not ready,
      // so a still-running first take correctly leaves the pointer empty.
      const shot = readShot(board.std, shotId);
      if (shot && !shot.chosenTakeId) chooseTake(board.std, shotId, id);
      return { ...digest(board), takeId: id };
    },

    /** Update a take in flight — what a poller calls when a job finishes. */
    'voidspace:board-update-take': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const takeId = String(args.takeId ?? '');
      const patch: Record<string, unknown> = {};
      // `!= null` catches BOTH undefined and null, and the difference is not
      // academic: `String(null)` is the four-character string "null", so a
      // caller clearing a field by sending null would have written the WORD
      // null into the url — a take pointing at a resource named "null", which
      // fails as a 404 somewhere far away from here.
      for (const k of ['url', 'src', 'poster', 'mediaId', 'error', 'jobId', 'label', 'promptUsed', 'nodeName']) {
        if (args[k] != null) patch[k] = String(args[k]);
      }
      for (const k of ['durationSec', 'costCredits', 'seed']) {
        if (args[k] != null && Number.isFinite(Number(args[k]))) patch[k] = Number(args[k]);
      }
      // Constrained rather than stringified: these two decide WHICH MACHINE a
      // resume or a cancel is addressed to, and a junk value would send it to
      // the wrong one — or to none, silently.
      if (args.nodeVia === 'loopback' || args.nodeVia === 'mesh') patch.nodeVia = args.nodeVia;
      if (args.runtime === 'local' || args.runtime === 'cloud') patch.runtime = args.runtime;
      if (args.status === 'running' || args.status === 'ready' || args.status === 'failed') {
        patch.status = args.status;
      }
      if (!updateTake(board.std, shotId, takeId, patch)) {
        return fail('not_found', `Shot ${shotId} has no take ${takeId}.`);
      }
      // A take that has stopped running has no live progress, and no stoppable
      // job. Dropped here rather than on a timer so a job that stalls keeps
      // showing its last known phase instead of blanking on its own.
      if (patch.status === 'ready' || patch.status === 'failed') clearTakeProgress(takeId);
      // A take that has just BECOME ready is the first candidate on a shot that
      // was waiting for it — same rule as above, applied when the job lands
      // rather than when it started.
      const shot = readShot(board.std, shotId);
      if (shot && !shot.chosenTakeId && patch.status === 'ready') {
        chooseTake(board.std, shotId, takeId);
      }
      return digest(board);
    },

    /** Say which take IS the shot. */
    'voidspace:board-choose-take': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const takeId = String(args.takeId ?? '');
      if (!chooseTake(board.std, shotId, takeId)) {
        return fail(
          'not_found',
          `Could not choose take ${takeId} on shot ${shotId} — it does not exist, or it is not ready yet.`,
        );
      }
      return digest(board);
    },

    /** Discard a take. The Library keeps the file; a cut already using it plays on. */
    'voidspace:board-remove-take': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const takeId = String(args.takeId ?? '');
      if (!removeTake(board.std, shotId, takeId)) {
        return fail('not_found', `Shot ${shotId} has no take ${takeId}.`);
      }
      // The row is gone; its progress must go with it. Take ids are unique per
      // shot, so a stale entry would never be READ again — but it would sit in
      // the map for the life of the page, and a long board session that
      // generated and discarded a lot would accumulate them.
      clearTakeProgress(takeId);
      return digest(board);
    },

    /**
     * ADD A GRAPHIC LAYER OVER THIS SHOT.
     *
     * Works on ANY shot, and that is the point of the feature: a lower third
     * over generated footage, a ticker over a graphic bed, a callout over a clip
     * the user recorded on their phone. `kind` decides what fills the frame;
     * this decides what is drawn on top of it.
     *
     * The block is CHECKED AGAINST THE CATALOGUE, for the same reason
     * `board-set-composition` checks it: a name the agent half-remembers renders
     * as nothing at all, three minutes and one compile later. An unknown name is
     * refused with the near matches, so the correction costs a turn rather than
     * a render.
     */
    'voidspace:board-add-graphic': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      if (!readShot(board.std, shotId)) {
        return fail('not_found', `No shot ${shotId} on this board.`);
      }
      const name = String(args.block ?? '').trim();
      const block = name ? findBlock(name) : null;
      if (name && !block) {
        const near = searchBlocks(name).slice(0, 5).map(b => b.name);
        return fail(
          'unknown_block',
          `No block called "${name}" is installed.`
          + (near.length ? ` Closest: ${near.join(', ')}.` : ' Call board_block_catalog to see what is.'),
        );
      }
      const id = addGraphic(board.std, shotId, {
        block: block?.name ?? '',
        // ALWAYS overlay unless asked otherwise — see `defaultGraphicMode` for
        // why this is not derived from the block's own flag.
        mode: args.mode === 'bake' || args.mode === 'overlay'
          ? args.mode
          : defaultGraphicMode(),
        ...(args.offsetSec !== undefined ? { offsetSec: Math.max(0, Number(args.offsetSec) || 0) } : {}),
        ...(args.durationSec !== undefined ? { durationSec: Math.max(0, Number(args.durationSec) || 0) } : {}),
        ...(args.anchor === 'end' ? { anchor: 'end' as const } : {}),
      });
      if (!id) return fail('not_found', `Could not add a graphic to shot ${shotId}.`);
      return { ...digest(board), graphicId: id };
    },

    /**
     * Change one layer — its block, its values, or when it plays.
     *
     * VALUES ARE CHECKED AGAINST WHAT THE BLOCK DECLARES, exactly as
     * `board-set-composition` checks them, and for exactly the same reason: the
     * filler passes every key through whether the block asked for it or not, so
     * a typo renders the designer's placeholder and looks identical to the value
     * never arriving. Unknown keys are DROPPED and named back together with the
     * ones that worked.
     */
    'voidspace:board-update-graphic': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const graphicId = String(args.graphicId ?? '');
      const shot = readShot(board.std, shotId);
      const current = shot?.graphics.find(x => x.id === graphicId);
      if (!current) return fail('not_found', `Shot ${shotId} has no graphic ${graphicId}.`);

      const patch: Record<string, unknown> = {};
      if (args.block !== undefined) {
        const name = String(args.block ?? '').trim();
        const found = name ? findBlock(name) : null;
        if (name && !found) {
          const near = searchBlocks(name).slice(0, 5).map(b => b.name);
          return fail(
            'unknown_block',
            `No block called "${name}" is installed.`
            + (near.length ? ` Closest: ${near.join(', ')}.` : ''),
          );
        }
        patch.block = found?.name ?? '';
      }
      if (args.offsetSec !== undefined) patch.offsetSec = Math.max(0, Number(args.offsetSec) || 0);
      if (args.durationSec !== undefined) patch.durationSec = Math.max(0, Number(args.durationSec) || 0);
      if (args.anchor !== undefined) patch.anchor = args.anchor === 'end' ? 'end' : 'start';
      if (args.mode === 'bake' || args.mode === 'overlay') patch.mode = args.mode;

      /**
       * WHAT COMPILE MADE, written back through the same door.
       *
       * These are RESULTS, not design decisions — the file, its measured
       * length, the hash that proves it still matches, and why it failed if it
       * did. The page writes them after a render; the agent tool deliberately
       * does not offer them, exactly as it does not offer `board_update_take`.
       *
       * `updateGraphic` treats a patch carrying `renderedUrl` as a result and
       * leaves it alone, rather than clearing it the way it clears a render when
       * the DESIGN changes.
       */
      if (typeof args.renderedUrl === 'string') patch.renderedUrl = args.renderedUrl;
      if (typeof args.renderHash === 'string') patch.renderHash = args.renderHash;
      if (args.renderedDurationSec !== undefined) {
        patch.renderedDurationSec = Math.max(0, Number(args.renderedDurationSec) || 0);
      }
      if (typeof args.mediaId === 'string') patch.mediaId = args.mediaId;
      if (typeof args.error === 'string') patch.error = args.error;

      let ignored: string[] = [];
      const accepted: string[] = [];
      if (args.slots && typeof args.slots === 'object' && !Array.isArray(args.slots)) {
        const blockName = typeof patch.block === 'string' ? patch.block : current.block;
        const decl = findBlock(blockName);
        const declared = new Set((decl?.slots ?? []).map(sl => sl.key));
        // MERGED, not replaced. A caller setting the headline must not blank the
        // picture somebody dropped on the layer three edits ago — and a shot's
        // slots are filled from two directions (typed here, dropped on the card),
        // so a wholesale write is guaranteed to destroy one of them.
        const next: Record<string, string> = { ...(current.slots ?? {}) };
        for (const [k, v] of Object.entries(args.slots as Record<string, unknown>)) {
          if (typeof v !== 'string' && typeof v !== 'number') continue;
          if (declared.size && !declared.has(k)) { ignored.push(k); continue; }
          const val = String(v);
          // An explicit empty string CLEARS a slot, which is how "take the
          // subtitle off" is said. Under render-mode fill that hides the element
          // rather than reinstating the designer's sample.
          if (val === '') delete next[k]; else next[k] = val;
          accepted.push(k);
        }
        patch.slots = next;
      }

      if (!Object.keys(patch).length) {
        return fail('empty', 'Give a block, slots, a time, or any combination.');
      }
      if (!updateGraphic(board.std, shotId, graphicId, patch as never)) {
        return fail('not_found', `Shot ${shotId} has no graphic ${graphicId}.`);
      }

      if (ignored.length) {
        const decl = findBlock(typeof patch.block === 'string' ? patch.block : current.block);
        return {
          ...digest(board),
          ignoredKeys: ignored,
          accepted,
          note: `${decl?.name ?? 'That block'} has no slot called `
            + `${ignored.map(k => `"${k}"`).join(', ')}. It declares: `
            + `${(decl?.slots ?? []).map(sl => `${sl.key} (${sl.kind})`).join(', ')}.`,
        };
      }
      return digest(board);
    },

    /**
     * EVERY LAYER THAT STILL NEEDS RENDERING, with its REAL values.
     *
     * ── WHY THE DIGEST CANNOT ANSWER THIS ────────────────────────────────────
     * `board_read` reports a filled media slot as the word "set" rather than its
     * signed url. That is deliberate and worth keeping: a board with a dozen
     * pictures in graphics would otherwise put a dozen signed urls into every
     * read, which is exactly the context burn the rule exists to prevent.
     *
     * Rendering needs the actual url. So it asks for it explicitly, on a call
     * that no language model is offered — this is the page's own channel, not a
     * tool. Same shape as `board-shot-gen-input`, and for the same reason.
     *
     * Reports what is PENDING, not everything: a layer whose file still matches
     * its values does not need to be looked at, and returning it would tempt the
     * caller into re-rendering it.
     */
    'voidspace:board-graphic-fills': () => {
      const shots = readShots(board.std);
      const out: Array<{
        shotId: string;
        graphicId: string;
        block: string;
        slots: Record<string, string>;
        durationSec: number;
        mode: 'overlay' | 'bake';
        /** The picture to composite INTO the render. Bakes only. */
        backdropUrl?: string;
        /** Why this layer cannot be rendered as asked. Present = do not render. */
        blocked?: string;
      }> = [];
      for (const s of shots) {
        for (const g of s.graphics ?? []) {
          if (!g.block) continue;
          if (g.renderedUrl) continue;
          const mode = g.mode === 'bake' ? 'bake' as const : 'overlay' as const;
          /**
           * A BAKE NEEDS A PICTURE TO BAKE ONTO.
           *
           * Reported as BLOCKED rather than skipped. Skipping would make the
           * layer vanish from the render queue and then from the compile, with
           * nothing anywhere saying why — the user would see an empty graphic
           * track and conclude the feature is broken. The page writes this
           * sentence onto the layer, where the person who set it can read it.
           */
          /**
           * THE SHOT'S SLOT IS WHATEVER THE CHOSEN TAKE MEASURES.
           *
           * Resolved for BOTH modes, not just bake. `plannedSeconds` is what the
           * user ASKED for before anything existed; once a take is picked, the
           * slot on the timeline is that take's real length, and an overlay set
           * to "the whole shot" has to be rendered to fill it.
           *
           * Found by running the flow: a 10.04s take under a whole-shot lower
           * third rendered the graphic at 6s — the model's snapped minimum, from
           * a shot nobody had typed a length into — so it stopped four seconds
           * before the picture did.
           */
          const playing = chosenTake(s.takes, s.chosenTakeId);
          const slotSec = Number(playing?.durationSec) > 0
            ? Number(playing!.durationSec)
            : plannedSeconds(s);
          const blocked = mode === 'bake' && !playing
            ? 'Baking needs a picture to bake onto — generate this shot first, or '
              + 'switch the layer to Over.'
            : '';

          const slots: Record<string, string> = { ...(g.slots ?? {}) };
          /**
           * WHERE THE FOOTAGE GOES IN A BAKE, and it is not one answer.
           *
           * If the block DECLARES A VIDEO SLOT, the footage goes in there. That
           * is what the slot is for, the block was laid out around it, and it is
           * the whole reason to bake rather than overlay — `video-hero` frames a
           * clip, `browser-mockup` puts one in a window.
           *
           * Only a block with NO video slot falls back to a backdrop behind the
           * composition. That path has a real limit, said out loud by
           * `checkGraphic`: 13 of the installed starters paint an opaque `#root`
           * background, and a backdrop behind one of those is invisible. It
           * works for the transparent overlay blocks, which is exactly the set
           * somebody would bake for a flat single-file export.
           *
           * A slot the user has already filled is NOT overwritten — they put
           * something specific there on purpose.
           */
          const videoSlot = mode === 'bake' && playing
            ? (findBlock(g.block)?.slots ?? [])
              .find(sl => sl.kind === 'video' && !slots[sl.key])
            : undefined;
          if (playing && videoSlot) {
            slots[videoSlot.key] = playing.url || playing.src;
          }

          out.push({
            shotId: s.id,
            graphicId: g.id,
            block: g.block,
            slots,
            mode,
            /**
             * A BAKE IS THE LENGTH OF THE FOOTAGE, not of the graphic.
             *
             * It IS the shot's picture once rendered, so cutting it short would
             * cut the shot short. An overlay is the opposite: it costs only its
             * own seconds, which is the whole reason it is the default.
             */
            /**
             * HOW LONG TO RENDER IT FOR — and 0 means "do not force a length".
             *
             * ── A BAKE IS THE LENGTH OF THE FOOTAGE ──────────────────────────
             * It IS the shot's picture once rendered, so cutting it short would
             * cut the shot short. Always forced to the slot.
             *
             * ── AN OVERLAY IS THE LENGTH THE DESIGNER GAVE IT ────────────────
             * Measured, not assumed: `lt-clean-bar` animates in, holds and
             * animates OUT over 4.8s (144 frames). Forcing it to cover a 10.04s
             * shot rendered 302 frames, took twice as long, and produced FIVE
             * SECONDS OF NOTHING after the bar had left — a graphic that behaves
             * differently from the way it was drawn.
             *
             * So an overlay with no explicit hold is rendered unforced and the
             * timeline places it for its own length (`asked = hold || file ||
             * slot` in the loader). A user who genuinely wants it held longer
             * types a number, and the renderer's hold extends it.
             *
             * This is the opposite of the rule for a SCENE, deliberately: a
             * full-frame beat that ends early leaves a hole with narration
             * playing over it, where an overlay that ends early just stops.
             */
            durationSec: mode === 'bake'
              ? slotSec
              : Math.max(0, Number(g.durationSec) || 0),
            // FULL QUALITY, and only when the block has nowhere better to put
            // it. `src` is the card's thumbnail; baking from it would blow a
            // poster frame up to fill the frame.
            ...(mode === 'bake' && playing && !videoSlot
              ? { backdropUrl: playing.url || playing.src }
              : {}),
            ...(blocked ? { blocked } : {}),
          });
        }
      }
      return { ok: true as const, rev, pending: out };
    },

    /** Drop a layer. Its rendered file stays in the Library — a cut already
     *  using it plays on, the same rule a discarded take follows. */
    'voidspace:board-remove-graphic': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const graphicId = String(args.graphicId ?? '');
      if (!removeGraphic(board.std, shotId, graphicId)) {
        return fail('not_found', `Shot ${shotId} has no graphic ${graphicId}.`);
      }
      return digest(board);
    },

    /**
     * Reorder within a lane.
     *
     * Order is what a model receives as `@ref1`, `@ref2`, so it changes the
     * output and has to be addressable rather than incidental.
     */
    'voidspace:board-move-media': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const id = String(args.mediaId ?? '');
      if (!moveMedia(board.std, shotId, id, Number(args.delta ?? 0))) {
        return fail('not_found', `Could not move media ${id} within shot ${shotId}.`);
      }
      return digest(board);
    },

    /**
     * Place Library media on the OPEN CANVAS — thinking space, not a shot.
     *
     * The agent's "put these where I can see them" case: mood boards,
     * alternatives to compare, the reference pile a decision gets made from.
     * Anything meant for a scene goes through `board-attach-media`, which is
     * cheaper and is the only route compile reads.
     *
     * ── A BATCH, LAID OUT AS A GRID ──────────────────────────────────────────
     * A mood board is six pictures, and six calls would be six network round
     * trips, six undo steps, and six cards stacked on the same coordinate. So
     * this takes a list and arranges it — which is the whole difference between
     * "the agent can add an image" and "the agent can put a mood board up".
     *
     * The single-asset shape still works: an older client sending flat fields
     * gets exactly what it used to.
     *
     * ── LOW-RES ON THE CANVAS, ALWAYS ────────────────────────────────────────
     * `displayUrl` is what gets fetched and `url` is only recorded, so a board of
     * fifty stills costs fifty thumbnails and never fifty masters. When the agent
     * sends only one url this now warns rather than silently pulling a 4K master
     * into a 300px card — the panel's own drag path always sends both, so a
     * missing `displayUrl` means the agent skipped `search_media`.
     */
    'voidspace:board-insert-media': async args => {
      const g = addGuard(args); if (!g.ok) return g;

      const parsedItems = asArray<Record<string, unknown>>(args.items);
      const rows = parsedItems.length ? parsedItems : [args];


      /**
       * PUT IT WHERE THE USER IS LOOKING.
       *
       * A generation made FROM references belongs beside them. Landing it in a
       * fixed spot below the filmstrip meant the user asked for a variant of
       * four images they were staring at, watched a toast, and then had to go
       * and find the result — on an infinite canvas, at whatever zoom they were
       * at, which is a search rather than a glance.
       *
       * The references are the anchor because the board is the only side that
       * knows where they are: the parent sends `referenceIds` for provenance
       * anyway, so this costs nothing and needs no new argument. Placed just
       * BELOW their bounding box rather than to the right, since a row of
       * references read left-to-right and the answer reads as the next line.
       *
       * No references (a plain "add media", or a track) leaves the origin UNSET
       * and lets the allocator put it in the thinking region — the same place a
       * coordinate-less `board_draw` goes, and the same function.
       *
       * IT USED TO BE A FIXED POINT, and that was the "it overlaps things on the
       * board" report: `{ x: 0, y: SHOT_H + 240 }` is (0, 1260), and scene row 2
       * of the storyboard grid occupies y 1076–2096 while x 0–360 is the gutter
       * the spine draws its brackets into. So every unanchored placement landed
       * on scene 2 and in the gutter — and, being fixed, on the previous
       * placement too.
       */
      const anchorIds = rows.flatMap(r => (Array.isArray(r.referenceIds) ? r.referenceIds.map(String) : []));
      const anchors = anchorIds.length
        ? readCanvas(board.std).filter(i => anchorIds.includes(i.id))
        : [];
      const boxed = anchors.filter(a => typeof a.x === 'number' && typeof a.y === 'number');
      const origin = boxed.length
        ? {
            x: Math.min(...boxed.map(a => a.x as number)),
            y: Math.max(...boxed.map(a => (a.y as number) + (typeof a.h === 'number' ? a.h : 240))) + 64,
          }
        // Undefined, not a computed point: `reserveFlow` measures the batch and
        // right-aligns it in the thinking region, which it cannot do if it is
        // handed an origin that was decided before the widths were known.
        : undefined;

      /**
       * WHICH SCENE THESE ARE ABOUT, per row and falling back to the call.
       *
       * A batch of references for one scene should not have to repeat the key on
       * every item, and a mixed batch should be able to say it per item.
       */
      const callScene = typeof args.sceneKey === 'string' ? args.sceneKey : '';
      const sceneKeyFor = (row: Record<string, unknown>) =>
        (typeof row.sceneKey === 'string' && row.sceneKey ? row.sceneKey : callScene);

      const placedIds: string[] = [];
      const problems: string[] = [];
      let missingDisplay = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const url = String(row.displayUrl ?? row.url ?? '');
        if (!url) { problems.push(`Item ${i + 1} had no url.`); continue; }
        if (!row.displayUrl) missingDisplay++;

        const kind = row.kind === 'video' || row.kind === 'audio' ? row.kind : 'image';
        /**
         * WHERE it goes is decided once every card exists — see the arrange step
         * below, which now runs for EVERY item.
         *
         * It used to be skipped for a lone item with no references, on the
         * grounds that `placeAsset`'s own choice is right for "add this from the
         * library". But that choice is the viewport centre, which is not
         * guaranteed to be empty — so the one case that opted out of layout was
         * also the one case that could silently land on the user's work.
         */
        const placed = await placeAsset(board.std, {
          displayUrl: url,
          originalUrl: typeof row.originalUrl === 'string'
            ? row.originalUrl
            : typeof row.url === 'string' ? row.url : undefined,
          kind,
          mediaId: typeof row.mediaId === 'string' ? row.mediaId : undefined,
          scope: row.scope === 'shared' || row.scope === 'device' ? row.scope : 'mine',
          name: typeof row.name === 'string' ? row.name : undefined,
          posterUrl: typeof row.posterUrl === 'string' ? row.posterUrl : undefined,
          bytes: typeof row.bytes === 'number' ? row.bytes : undefined,
          createdBy: 'agent',
          /**
           * A LONE GENERATION IS A HERO; EVERYTHING ELSE IS A REFERENCE.
           *
           * The distinction is not what the media IS, it is what the user is
           * doing with it. Six library stills are a set being compared and
           * belong at reference size; one picture the agent has just made from
           * their references is the answer to a question and is worth a card one
           * shot wide. `prompt` is the honest marker — only a generation carries
           * one — and only when it arrives alone.
           */
          size: rows.length === 1 && typeof row.prompt === 'string' && row.prompt
            ? 'hero'
            : 'ref',
          // Provenance travels with the asset — see `BlockMeta`.
          ...(typeof row.prompt === 'string' ? { prompt: row.prompt } : {}),
          ...(Array.isArray(row.referenceIds) ? { referenceIds: row.referenceIds.map(String) } : {}),
          ...(typeof row.model === 'string' ? { model: row.model } : {}),
          ...(typeof row.sourceUrl === 'string' ? { sourceUrl: row.sourceUrl } : {}),
          ...(typeof row.credit === 'string' ? { credit: row.credit } : {}),
          ...(sceneKeyFor(row) ? { sceneKey: sceneKeyFor(row) } : {}),
        });

        // A DEAD LINK IS NOT A CRASH. The agent needs to be told an asset could
        // not be loaded so it can say so, rather than reporting success over an
        // empty canvas.
        if (!placed.ok) { problems.push(`${row.name ?? url}: ${placed.message}`); continue; }
        placedIds.push(placed.blockId);
      }

      if (!placedIds.length) {
        return fail(
          'unavailable',
          problems.join(' ') || 'Nothing could be placed on the canvas.',
        );
      }


      /**
       * ARRANGE ON MEASURED SIZES, once every card exists.
       *
       * The old grid used a fixed 340px pitch, decided before anything was
       * placed. But a card is sized from the real media, so a row of references
       * was laid out on a pitch smaller than the cards themselves and every one
       * of them sat on top of its neighbour. Measured: two 780px-wide references
       * placed at x=0 and x=340, overlapping by 440px.
       *
       * That is unfixable before placement — the size is not knowable until the
       * media has been read — so the positions are decided HERE, from the boxes
       * the insert helpers actually produced. Same reason `relaxOverlaps` runs
       * after a draw rather than during one.
       *
       * A flow, not a grid: left to right, wrapping when the row would exceed
       * `ROW_MAX_W`, each row as tall as its tallest card. Reading order is
       * preserved, which is what makes "these four, in this order" mean
       * something to the user looking at them.
       *
       * `reserveFlow` IS THE SHARED ALLOCATOR, and that is the change. The flow
       * above was blind to everything outside its own batch, so it cleared its
       * own members and nothing else — no shot, no note, no earlier mood board.
       * The batch now clears the storyboard, the spine gutter and the whole
       * canvas, which is what the prompt has been promising the agent all along.
       *
       * `exclude` is load-bearing: these blocks already exist by now (they had
       * to, in order to be sized from the real files), so without it every card
       * would be an obstacle to itself and the batch would march down the board
       * for ever.
       */
      {
        const entries = placedIds.flatMap(id => {
          const model = board.store.getBlock(id)?.model;
          const box = model ? bounds(model.props as { xywh?: string }) : null;
          return model && box ? [{ model, box }] : [];
        });

        const slots = reserveFlow(board.std, entries.map(e => e.box), {
          at: origin,
          exclude: placedIds,
        });

        entries.forEach((entry, i) => {
          const slot = slots[i];
          if (slot) {
            board.store.updateBlock(entry.model, {
              xywh: `[${slot.x},${slot.y},${slot.w},${slot.h}]`,
            });
          }
        });
      }

      rev++;
      const boxes = placedIds
        .map(id => board.store.getBlock(id)?.model)
        .map(m => (m ? bounds(m.props as { xywh?: string }) : null))
        .filter((b): b is { x: number; y: number; w: number; h: number } => !!b);
      if (boxes.length) {
        ensureVisible({
          x: Math.min(...boxes.map(b => b.x)),
          y: Math.min(...boxes.map(b => b.y)),
          w: Math.max(...boxes.map(b => b.x + b.w)) - Math.min(...boxes.map(b => b.x)),
          h: Math.max(...boxes.map(b => b.y + b.h)) - Math.min(...boxes.map(b => b.y)),
        });
      }

      return {
        ok: true as const,
        rev,
        placed: placedIds.length,
        insertedIds: placedIds,
        // Kept so a single-asset caller reads the same field it always did.
        insertedId: placedIds[0],
        ...(problems.length ? { problems } : {}),
        ...(missingDisplay
          ? {
              note: `${missingDisplay} item(s) had no displayUrl, so the canvas loaded the `
                + 'full-quality file. Pass the `displayUrl` from search_media — the canvas '
                + 'only ever needs the small variant.',
            }
          : {}),
      };
    },

    /**
     * WHAT IS ON THE OPEN CANVAS — the half of the board the agent was blind to.
     *
     * Read-only and free. Includes the board's own blocks (shots, the
     * screenplay, block drafts) marked `owned`: without them the agent's picture
     * of the board was a lie, so it would place a note straight on top of scene
     * 3 and could not draw an arrow from an idea to the shot it was about.
     */
    /**
     * LOOK AT THE BOARD — a real picture, not a list of rectangles.
     *
     * The one read that answers a visual question. Returns a URL rather than
     * bytes: a full-board PNG is megabytes, the bridge carries plain data
     * between two windows, and a url is the form `inspect_media` takes anyway.
     *
     * NOT guarded by `checkRev`: it writes nothing, and refusing to LOOK at a
     * board because it changed while we were reading it is nonsense.
     */
    'voidspace:board-screenshot': async args => {
      const raw = String(args?.scope ?? 'viewport');
      const ids = asArray<string>(args?.ids).map(String).filter(Boolean);
      /**
       * `ids` IMPLIES THE SCOPE. An agent that names four ids has said what it
       * wants to look at; making it also say `scope: "ids"` is a second chance
       * to get one call wrong, and getting it wrong silently returns a picture
       * of the viewport instead — which looks like an answer.
       */
      const scope: ShotScope =
        raw === 'all' || raw === 'selection' || raw === 'auto' || raw === 'ids'
          ? (raw as ShotScope)
          : ids.length ? 'ids' : 'viewport';
      try {
        return { ok: true as const, ...(await captureBoard(board, scope, { ids })) };
      } catch (e) {
        // The reasons differ and so do the remedies — nothing selected, nothing
        // on screen, upload refused. Pass the sentence through.
        return fail('unavailable', (e as Error)?.message || 'The screenshot could not be taken.');
      }
    },

    /**
     * TIDY UP — the second half of a brainstorm, which had no verb.
     *
     * `addGuard`, not `checkRev`: arranging is ADDITIVE in the sense that matters
     * — it never destroys content, and `rev` counts every `blockUpdated` rather
     * than the user's edits (a freshly opened empty board already reports rev 444
     * and moves again while the agent reads). A guard that fires when nothing
     * happened is a random failure with a reassuring name.
     */
    'voidspace:board-arrange': args => {
      const g = addGuard(args); if (!g.ok) return g;

      const asRaw = String(args.as ?? 'tidy');
      const as = asRaw === 'row' || asRaw === 'column' || asRaw === 'grid' ? asRaw : 'tidy';
      const result = arrangeCanvas(board.std, {
        ids: asArray<string>(args.ids).map(String),
        as,
        ...(typeof args.sceneKey === 'string' && args.sceneKey
          ? { sceneKey: args.sceneKey }
          : {}),
        ...(typeof args.frame === 'string' ? { frame: args.frame } : {}),
        inPlace: args.inPlace === true,
      });

      // Nothing moved AND nothing framed is a no-op worth reporting as one, so
      // the agent does not tell the user it tidied a board it did not touch.
      if (!result.moved && !result.frameId) {
        return fail(
          'unavailable',
          result.problems.join(' ') || 'There was nothing to arrange.',
        );
      }

      rev++;
      const digest = canvasDigest(board.std);
      return {
        ok: true as const,
        rev,
        moved: result.moved,
        ...(result.frameId ? { frameId: result.frameId } : {}),
        ...(result.problems.length ? { problems: result.problems } : {}),
        digest,
      };
    },

    /**
     * THE BOARD AS A MAP — structure and judgement, at constant cost.
     *
     * The read that answers "what is this board, and is it any good" without
     * pixels. One line per SECTION, never per element, plus the ids that
     * section holds — which `board-canvas-read { ids }` already takes, so the
     * ladder is map -> section -> item with no new scoping verb.
     *
     * It exists because geometry is not structure: an agent with the complete
     * coordinates of 57 elements declared a board good and the user's verdict
     * was that it explained nothing. Every fault was computable. See map.ts.
     */
    'voidspace:board-map': () => ({ ok: true as const, rev, ...readBoardMap(board.std) }),

    'voidspace:board-canvas-read': args => {
      /**
       * SELECTION-ONLY IS THE COMMON CASE, not a filter.
       *
       * "Use these four" is the sentence the canvas exists to make sayable, and
       * answering it by returning the whole board and hoping the agent guesses
       * which four is how you get the wrong four. The selection is also usually
       * tiny, so this is the cheap read as well as the right one.
       */
      const selectionOnly = args?.selectionOnly === true;
      const ids = asArray(args?.ids).map(String).filter(Boolean);
      const full = args?.full === true;
      const items = readCanvas(board.std, { selectionOnly, ids, full });
      const selection = readSelection(board.std);

      /**
       * THE TOTAL IS CAPPED, AND THE TRIM IS REPORTED.
       *
       * `full` raises the per-element cap 10×, which is right for the two
       * elements someone wants transcribed and catastrophic for a sixty-note
       * board — that is one read costing more context than the whole
       * conversation. So the budget is enforced across the result, in reading
       * order, and the response SAYS how many elements it dropped.
       *
       * Saying so is the point. A silent cap reads as "that is everything on
       * the board", and an agent writing a document from a silently truncated
       * read produces a document missing its last third with no sign anything
       * went wrong.
       */
      let kept = items;
      let dropped = 0;
      if (full) {
        const budget = 60_000;
        let spent = 0;
        kept = [];
        for (const item of items) {
          const cost = item.text.length;
          if (spent + cost > budget && kept.length) { dropped++; continue; }
          spent += cost;
          kept.push(item);
        }
      }

      return {
        ok: true as const,
        rev,
        count: kept.length,
        /** The vocabulary `board_draw` takes, so a read teaches the write. */
        colors: COLOR_NAMES,
        items: kept,
        /** What the user is pointing at, always — even on a full read. */
        selectedIds: selection.ids,
        ...(dropped
          ? {
            truncated: dropped,
            note: `${dropped} element(s) omitted — this read hit its size budget. `
              + 'Read the rest by naming their ids.',
          }
          : {}),
      };
    },

    /**
     * WHAT IS SELECTED — or the media behind any ids the caller names.
     *
     * Split from the canvas read because the PAGE needs it, not the agent. The
     * page assembles a generation's references from this and never puts the urls
     * in front of the model: signed Library urls are long, they burn context,
     * and a model that can see them can be talked into repeating one.
     *
     * With no `ids` it answers for the selection, which is the case that matters
     * — "use these four" is the sentence this exists for.
     */
    /**
     * THE LIBRARY CHANGED — RE-READ IT.
     *
     * The parent generates media; the asset panel in here is a view of the same
     * Library it landed in. Without this the user watched their own generation
     * appear on the canvas and NOT in the panel beside it, and the only fix was
     * the refresh button — which reads as the panel being stale rather than as
     * a message never sent.
     *
     * A window event rather than a direct call, so the panel keeps its internals
     * to itself and anything else that lists assets can listen too.
     */
    /**
     * A CARD WHERE THE RESULT WILL BE, WHILE IT IS BEING MADE.
     *
     * The parent owns generation — the session, the credits, the model — so it
     * is the only side that knows when one starts and how it ended. This is the
     * only thing it needs from the canvas: raise a placeholder at the anchor the
     * finished media will use, then clear it.
     *
     * `done` clears. `error` leaves it on screen saying why, because a failure
     * that simply removes the card looks like nothing ever happened.
     */
    'voidspace:board-pending-media': args => {
      const layer = opts.pending?.();
      if (!layer) return { ok: true as const, rev };
      const id = String(args.id ?? '');
      if (!id) return fail('empty', 'A placeholder needs an id.');
      const error = String(args.error ?? '');
      if (error) layer.fail(id, error);
      else if (args.done) layer.hide(id);
      else {
        const kind = args.kind === 'video' || args.kind === 'audio' ? args.kind : 'image';
        const ids = Array.isArray(args.referenceIds) ? args.referenceIds.map(String) : [];
        // The aspect the generation ASKED FOR, so the card is the shape of its
        // own result rather than a fixed portrait guess.
        layer.show(id, kind, ids, typeof args.aspect === 'string' ? args.aspect : undefined);
      }
      return { ok: true as const, rev };
    },

    'voidspace:board-library-changed': () => {
      window.dispatchEvent(new CustomEvent('voidspace:library-changed'));
      return { ok: true as const, rev };
    },

    'voidspace:board-selection': args => {
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : null;
      if (!ids) return { ok: true as const, rev, ...readSelection(board.std) };

      const items = readCanvas(board.std).filter(i => ids.includes(i.id));
      return {
        ok: true as const,
        rev,
        ids: items.map(i => i.id),
        items,
        // ORDER FOLLOWS THE CALLER, not the canvas. A model receives references
        // positionally, so "use the first one as the style" only means anything
        // if the order the agent asked for survives.
        mediaUrls: ids
          .map(id => mediaUrlOf(board.std, id))
          .filter((u): u is string => !!u),
      };
    },

    /**
     * Say that something slow is happening, ON THE CANVAS.
     *
     * Generation runs in the PARENT (it owns the session, the credits and the
     * model picks), and takes a minute or two. The user is looking at the board,
     * not at the chat — so without this the canvas is silent for ninety seconds
     * after they asked for a picture, which reads as nothing having happened.
     *
     * Reuses the board's own pending toast rather than inventing a progress
     * surface: the parent says "started" and later "done", and the toast handles
     * the rest.
     */
    'voidspace:board-progress': args => {
      const id = String(args.id ?? '');
      if (!id) return fail('empty', 'A progress message needs an id.');
      if (args.done) {
        progress.get(id)?.();
        progress.delete(id);
      } else {
        progress.get(id)?.();
        progress.set(id, pendingToast(String(args.message ?? 'Working…'), 0));
      }
      return { ok: true as const, rev };
    },

    /**
     * Every take still marked `running`, with the handle needed to chase it.
     *
     * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
     * `running` is persisted precisely so a render survives the tab that started
     * it. But surviving is only half of it: nothing was ever picking those takes
     * back up, so closing or reloading the tab left a take spinning FOREVER —
     * the file lands in the Library and the card never stops saying "generating".
     * An endless spinner is indistinguishable from a broken generator, and it is
     * the one failure a user cannot act on.
     *
     * ── PAGE-ONLY CHANNEL. NEVER PUT THIS IN FRONT OF A MODEL ────────────────
     * Same rule as `board-shot-gen-input`. The agent's `takes` digest is
     * deliberately handle-free and url-free; job ids are infrastructure the page
     * needs and a language model has no use for.
     */
    'voidspace:board-running-takes': () => {
      const out: Array<Record<string, unknown>> = [];
      for (const s of readShots(board.std)) {
        for (const t of s.takes ?? []) {
          if (t.status !== 'running') continue;
          out.push({
            shotId: s.id,
            takeId: t.id,
            label: t.label ?? '',
            // Absent for a take written before this field carried the real
            // handle, and for anything the page could not identify. The caller
            // must treat "no handle" as unresumable rather than guessing.
            jobId: t.jobId ?? '',
            runtime: t.runtime ?? '',
            nodeVia: t.nodeVia ?? '',
            nodeName: t.nodeName ?? '',
            createdAt: t.createdAt,
          });
        }
      }
      return { ok: true as const, rev, takes: out };
    },

    /**
     * How a RUNNING take is doing, for its own card to draw.
     *
     * Separate from `board-update-take` on purpose — see `take-progress.ts` for
     * why this must not touch the document. The short version: it arrives every
     * three seconds and stops being true the moment the job ends, so persisting
     * it would fill the undo stack and then lie about it after a reload.
     *
     * Not guarded like the write ops: it changes nothing that can be saved,
     * lost or undone. The worst a bad call can do is put a wrong word under a
     * spinner until the next poll corrects it.
     */
    'voidspace:board-take-progress': args => {
      const takeId = String(args.takeId ?? '');
      if (!takeId) return fail('empty', 'Take progress needs a takeId.');
      setTakeProgress(takeId, {
        ...(args.label != null ? { label: String(args.label) } : {}),
        ...(args.pct != null && Number.isFinite(Number(args.pct)) ? { pct: Number(args.pct) } : {}),
        ...(args.cancellable != null ? { cancellable: args.cancellable === true } : {}),
      });
      return { ok: true as const, rev };
    },

    /**
     * DRAW ON THE CANVAS — notes, text, shapes, arrows, mind maps, frames.
     *
     * ONE BATCH, one transaction, ONE undo step. A flowchart is boxes AND the
     * arrows between them; as separate calls that is a dozen round trips, a
     * dozen undo steps, and a diagram the user watches assemble itself one
     * wrong-looking fragment at a time. Specs may refer to each other by `ref`
     * before any of them have ids, which is what makes that possible.
     *
     * Partial failure is REPORTED, never fatal: eight boxes and one bad arrow
     * leaves eight boxes and a sentence about the arrow.
     */
    'voidspace:board-draw': args => {
      const g = addGuard(args); if (!g.ok) return g;
      const specs = asArray<ElementSpec>(args.elements);
      if (!specs.length) {
        return fail('empty', 'Send at least one element in `elements`.');
      }
      if (specs.length > 200) {
        return fail(
          'too_many',
          `That is ${specs.length} elements in one call. Draw at most 200 at a time — `
          + 'past that the user cannot review what appeared.',
        );
      }

      const result = drawOnCanvas(board.std, specs);
      rev++;

      // SHOW WHAT WAS JUST MADE. A diagram the user has to go and find reads as
      // a diagram that was never drawn — the same reasoning as `board-add-shots`.
      const made = result.ids.filter((id): id is string => !!id);
      const boxes = readCanvas(board.std).filter(i => made.includes(i.id));
      if (boxes.length) {
        ensureVisible({
          x: Math.min(...boxes.map(b => b.x)),
          y: Math.min(...boxes.map(b => b.y)),
          w: Math.max(...boxes.map(b => b.x + b.w)) - Math.min(...boxes.map(b => b.x)),
          h: Math.max(...boxes.map(b => b.y + b.h)) - Math.min(...boxes.map(b => b.y)),
        });
      }

      return {
        ok: true as const,
        rev,
        created: made.length,
        ids: result.ids,
        refs: result.refs,
        ...(result.problems.length ? { problems: result.problems } : {}),
      };
    },

    /**
     * COMPOSE A DESIGNED REGION FROM CONTENT ALONE.
     *
     * `board-draw` takes coordinates, which is right for a diagram and wrong
     * for a brainstorm: it puts every layout decision in the hands of a model
     * choosing numbers. Measured on a real board — seventeen cards at four
     * widths, fourteen coloured, seven frames wrapping nothing, a title in a
     * box a third the size of its text.
     *
     * This takes a title, sections and cards, and owns the grid, the type
     * scale, the frames and the accent budget. A misaligned board cannot be
     * produced through this door because no coordinate is ever asked for.
     *
     * It still goes out as ONE `drawOnCanvas` batch, so a composed page is one
     * transaction and one Ctrl+Z, exactly like a drawn one.
     */
    'voidspace:board-compose': args => {
      const g = addGuard(args); if (!g.ok) return g;
      const sections = asArray<ComposeSection>(args.sections);
      if (!sections.length) {
        return fail('empty', 'Send at least one section in `sections`.');
      }

      const plan = composeRegion({
        title: String(args.title ?? ''),
        subtitle: typeof args.subtitle === 'string' ? args.subtitle : undefined,
        sections,
        columns: typeof args.columns === 'number' ? args.columns : undefined,
        accent: typeof args.accent === 'string' ? args.accent : undefined,
        // Placed in clear space like any other unplaced batch unless the caller
        // says where — composing a second region beside a first is legitimate.
        x: typeof args.x === 'number' ? args.x : undefined,
        y: typeof args.y === 'number' ? args.y : undefined,
      });

      const result = drawOnCanvas(board.std, plan.elements);
      rev++;

      const made = result.ids.filter((id): id is string => !!id);
      const boxes = readCanvas(board.std).filter(i => made.includes(i.id));
      if (boxes.length) {
        ensureVisible({
          x: Math.min(...boxes.map(b => b.x)),
          y: Math.min(...boxes.map(b => b.y)),
          w: Math.max(...boxes.map(b => b.x + b.w)) - Math.min(...boxes.map(b => b.x)),
          h: Math.max(...boxes.map(b => b.y + b.h)) - Math.min(...boxes.map(b => b.y)),
        });
      }

      return {
        ok: true as const,
        rev,
        created: made.length,
        sections: sections.length,
        // The accent budget's verdict is a NOTE, not a problem: the page was
        // drawn, and the caller should know colour was withheld and why.
        ...(plan.notes.length ? { notes: plan.notes } : {}),
        ...(result.problems.length ? { problems: result.problems } : {}),
      };
    },

    /** Move, resize, retext, recolour or delete things already on the canvas. */
    'voidspace:board-edit-canvas': args => {
      const g = guard(args); if (!g.ok) return g;
      const ops = asArray<EditOp>(args.ops);
      if (!ops.length) return fail('empty', 'Send at least one operation in `ops`.');

      const result = editCanvas(board.std, ops);
      rev++;
      return {
        ok: true as const,
        rev,
        changed: result.changed,
        ...(result.problems.length ? { problems: result.problems } : {}),
      };
    },

    /**
     * OPEN, CLOSE OR EXPORT THE SCREENPLAY AT PAGE SIZE.
     *
     * The agent gets the same three actions the toolbar has, because the reason
     * the chat is still on screen in focus mode is that "tighten scene four,
     * then send me the PDF" is one sentence and should be one exchange.
     *
     * `pdf` hands the page to the browser's print pipeline, which opens the
     * user's own print dialog — so the agent can prepare an export but never
     * silently writes a file to their machine.
     */
    'voidspace:board-screenplay': args => {
      const focus = opts.screenplay?.();
      if (!focus) return fail('unavailable', 'The screenplay view is not ready yet.');

      const action = String(args.action ?? 'open');
      if (action === 'close') { focus.close(); return { ok: true as const, rev, open: false }; }
      if (action === 'pdf') {
        focus.print();
        return {
          ok: true as const,
          rev,
          open: true,
          // Said plainly, because the agent must not claim to have saved a file.
          note: 'The print dialog is open on the user’s screen — they choose "Save as PDF" '
            + 'and where it goes. Tell them to look at it.',
        };
      }
      if (action === 'fountain') {
        focus.downloadFountain();
        return {
          ok: true as const,
          rev,
          open: focus.isOpen(),
          note: 'Downloaded the .fountain source — it opens in Final Draft, Highland and '
            + 'Slugline.',
        };
      }
      focus.open();
      return { ok: true as const, rev, open: true };
    },

    /**
     * THE BOARD AS A DOCUMENT — the way out for work that is not a film.
     *
     * `compile_to_video` was the board's only exit, so an afternoon of planning,
     * research or analysis had exactly one destination and everything else ended
     * as pixels the user retyped somewhere else.
     *
     * `markdown` returns the text to the AGENT, which is the action that makes
     * the rest of the product reachable: it is what gets summarised, rewritten,
     * pasted into a message, or carried to another surface.
     *
     * `pdf` and `docx` produce a REAL FILE through the server's renderer and
     * return its URL — the one path here that yields something the user can
     * email. `print` opens their print dialog and saves nothing, and
     * `markdown_file` hands over the source; both act on the user's screen.
     */
    'voidspace:board-document': async args => {
      const view = opts.document?.();
      if (!view) return fail('unavailable', 'The document view is not ready yet.');

      const title = typeof args.title === 'string' ? args.title : undefined;
      const action = String(args.action ?? 'open');
      const summary = view.summary(title);

      // Answered before anything opens: an empty page shown to the user is a
      // worse answer than a sentence saying there is nothing to put in it.
      if (!summary.sections) {
        return {
          ok: true as const,
          rev,
          empty: true,
          note: 'There is nothing on the canvas to make a document from yet. Notes, mind maps, '
            + 'shapes and pictures become the document; a frame around a group becomes a section.',
        };
      }

      /** The same sentence on every action, because it is the thing the agent
       *  most needs to tell the user and most easily forgets. */
      const shape = summary.unframed
        ? 'The board has no frames, so everything is in canvas order, top to bottom. '
          + 'Draw a frame round a group to make it a section.'
        : `${summary.sections} section(s), from the frames on the board, read top to bottom `
          + 'then left to right.';
      const omitted = summary.omittedOwned
        ? ` ${summary.omittedOwned} storyboard shot(s) are NOT in it — those export as a screenplay.`
        : '';

      if (action === 'close') { view.close(); return { ok: true as const, rev, open: false }; }

      if (action === 'markdown') {
        /**
         * BOUNDED, AND THE TRIM IS REPORTED.
         *
         * This is the one action that returns the document TO THE MODEL, so its
         * size is a context cost that scales with how much work the user has
         * done — precisely backwards. A 300-note research board is a hundred
         * thousand characters, which is more than the rest of the conversation.
         *
         * Cut at a SECTION boundary rather than mid-sentence, and say which
         * sections are missing by name: a silently truncated document is one the
         * agent will summarise as though it had read all of it, and neither it
         * nor the user will be able to tell.
         *
         * The user's own exports (`pdf`, `markdown_file`) are NEVER truncated —
         * they do not pass through a model, so the limit does not apply to them.
         */
        const BUDGET = 40_000;
        const full = view.markdown(title);
        let text = full;
        let droppedSections: string[] = [];

        if (full.length > BUDGET) {
          const doc = view.sections();
          const kept: string[] = [];
          let spent = 0;
          for (const section of doc) {
            const chunk = (section.title ? `## ${section.title}\n\n` : '') + section.chunks.join('\n\n');
            if (spent + chunk.length > BUDGET && kept.length) {
              droppedSections.push(section.title || '(untitled section)');
              continue;
            }
            spent += chunk.length;
            kept.push(chunk);
          }
          text = (title ? `# ${title}\n\n` : '') + kept.join('\n\n');
        }

        return {
          ok: true as const,
          rev,
          open: view.isOpen(),
          words: summary.words,
          sections: summary.sections,
          markdown: text,
          ...(droppedSections.length
            ? {
              truncated: droppedSections.length,
              note: `${shape}${omitted} YOU HAVE NOT SEEN ALL OF IT — ${droppedSections.length} `
                + `section(s) were omitted for size: ${droppedSections.slice(0, 8).join(', ')}. `
                + 'Read those with board_canvas_read on their frames, and do NOT describe the '
                + 'document as complete.',
            }
            : { note: `${shape}${omitted}` }),
        };
      }

      /**
       * A REAL FILE, IN ONE CALL.
       *
       * Note what this deliberately does NOT do: round-trip the text through
       * the model. The `markdown` action is capped at 40k so a huge board
       * cannot blow up a turn, and a document built from that capped copy would
       * silently lose its later sections while looking finished. The view holds
       * the whole thing, so the whole thing is what goes to the renderer.
       */
      if (action === 'pdf' || action === 'docx') {
        // `upload` because a TOOL RESULT has to carry a URL — the model cannot
        // hand the user a file that only exists in their Downloads folder. The
        // user gets the download too; both happen from one typesetting pass.
        const out = await view.downloadFile(action, title, { upload: true });
        return {
          ok: true as const,
          rev,
          open: view.isOpen(),
          words: summary.words,
          sections: summary.sections,
          url: out.url,
          fileName: out.fileName,
          ...(out.pages ? { pages: out.pages } : {}),
          ...(out.droppedGlyphs ? { droppedGlyphs: out.droppedGlyphs } : {}),
          note: `Made ${out.fileName} and started the download. Give the user the URL too — it `
            + 'is a real file they can email or print.'
            + (out.droppedGlyphs
              ? ` ${out.droppedGlyphs} character(s) — emoji or non-Latin script — could not be `
                + 'set in a PDF and were left out; say so, and offer docx instead.'
              : '')
            + ` ${shape}${omitted}`,
        };
      }

      if (action === 'print') {
        view.print(title);
        return {
          ok: true as const,
          rev,
          open: true,
          words: summary.words,
          sections: summary.sections,
          // NEVER claim to have saved a file — the browser owns this dialog.
          note: 'The print dialog is open on the user’s screen — they choose "Save as PDF" and '
            + 'where it goes. Tell them to look at it, and NOTE that no file was saved — for an '
            + `actual file use the \`pdf\` or \`docx\` action. ${shape}${omitted}`,
        };
      }

      if (action === 'markdown_file') {
        view.downloadMarkdown(title);
        return {
          ok: true as const,
          rev,
          open: view.isOpen(),
          words: summary.words,
          sections: summary.sections,
          note: 'Downloaded the .md source — it opens in Word, Notion, Obsidian, Google Docs and '
            + `anything else that reads markdown. ${shape}${omitted}`,
        };
      }

      view.open(title);
      return {
        ok: true as const,
        rev,
        open: true,
        words: summary.words,
        sections: summary.sections,
        note: `The document is on the user’s screen. ${shape}${omitted}`,
      };
    },

    /**
     * `create_document` — the AGENT'S OWN markdown, typeset into a real file.
     *
     * The sibling of `voidspace:board-document`, and the difference is only
     * where the text comes from: that one reads the canvas, this one takes what
     * the model wrote. Everything after that is shared — the same block model,
     * the same two typesetters, the same file names.
     *
     * It is here, in the board app, because the typesetting runs ON THIS
     * DEVICE. The server manages state and does not take workloads; a browser
     * has the fonts, the arithmetic and an idle CPU, and the finished file
     * never has to travel except when a tool result needs a URL.
     *
     * The user gets the download too. An agent that makes a document and leaves
     * it only in a link is asking them to go and fetch their own work.
     */
    /**
     * READ a document on the board — outline first, body on demand.
     *
     * `list` with no noteId, because a board holds several documents and the
     * agent must never assume "the" one. Then `outline` (cheap, complete), then
     * `read` for the sections it actually wants.
     */
    /**
     * OPEN an uploaded file as an editable document on the board.
     *
     * The difference between this and `read_file` is the difference between
     * reading a contract and having it. `read_file` gives a model the words;
     * this puts the user's own document on their canvas with its headings, its
     * table, its colours and its letterhead, ready to be changed and exported
     * again as the same kind of file it arrived as.
     *
     * A .docx keeps everything, because Word stores it. A PDF is REBUILT from
     * where its glyphs sit, and the reply says so in `notes` -- the user is
     * entitled to know which parts of their document are our reading of it.
     */
    'voidspace:board-document-open': async args => {
      const url = String((args as any)?.url ?? '').trim();
      if (!url) return fail('bad_request', 'Pass the url of the file to open.');

      const { importFromUrl } = await import('../document/import');
      let imported;
      try {
        imported = await importFromUrl(url, String((args as any)?.name ?? '') || undefined);
      } catch (e: any) {
        return fail('failed', e?.message || 'That file could not be opened.');
      }
      if (!imported.markdown.trim()) {
        return fail('empty', 'There is no text in that file. If it is a scan, its pages are pictures of writing.');
      }

      const { placeMarkdownDocument } = await import('../document/note-io');
      const title = String((args as any)?.title ?? '').trim();
      let placed;
      try {
        placed = await placeMarkdownDocument(
          board,
          title ? `# ${title}${nl2}${imported.markdown}` : imported.markdown,
          { kind: imported.kind },
        );
      } catch (e: any) {
        return fail('failed', e?.message || 'That document could not be placed on the board.');
      }

      // Open it: a document the user cannot see reads as nothing having
      // happened, which is the same reason the storyboard scrolls to a new shot.
      try { opts.documentFocus?.()?.open(placed.noteId); }
      catch { /* opening is a courtesy, never the point */ }

      const { outline } = await import('../document/sections');
      return {
        ok: true as const,
        rev,
        noteId: placed.noteId,
        kind: imported.kind,
        images: imported.images,
        pageSetup: imported.spec,
        notes: imported.notes,
        outline: await outline(board, placed.noteId),
        note: 'It is on the board and editable. Use document_edit to change a section, '
          + 'and document_save to write it back out as a file.',
      };
    },

    /**
     * SAVE a document that is on the board, as a real file.
     *
     * The other half of opening one. Without it the agent could edit a
     * document and had no way to hand it back -- `create_document` makes a NEW
     * one from markdown it composes, which is a different act and produces a
     * different file with a different name.
     *
     * `title` is how the user says "save a copy": same document, new name, the
     * original left alone on the board.
     */
    'voidspace:board-document-save': async args => {
      const noteId = String((args as any)?.noteId ?? '').trim();
      if (!noteId) return fail('bad_request', 'Pass the noteId of the document to save.');
      if (!board.store.getBlock(noteId)) {
        return fail('not_found', 'No document with that noteId is on this board.');
      }

      const format = ((args as any)?.format === 'docx' ? 'docx'
        : (args as any)?.format === 'md' ? 'md' : 'pdf') as 'pdf' | 'docx' | 'md';

      const { noteToMarkdown, documentTitle } = await import('../document/note-io');
      const markdown = await noteToMarkdown(board, noteId);
      if (!markdown.trim()) return fail('empty', 'That document is empty.');

      const title = String((args as any)?.title ?? '').trim() || documentTitle(board, noteId)
        || 'document';

      const { saveDocument, uploadDocument } = await import('../board/document-export');
      let made;
      try {
        made = await saveDocument(markdown, title, format, pageSetup(args));
      } catch (e: any) {
        return fail('failed', e?.message || 'That document could not be laid out.');
      }

      let url: string | undefined;
      let shareNote = '';
      try {
        ({ url } = await uploadDocument(made));
      } catch (e: any) {
        // The FILE STILL EXISTS on the user's machine; reporting a failed
        // upload as a failed save sends them looking for the wrong problem.
        shareNote = ` It could not be uploaded, so there is no link — ${e?.message ?? 'unknown error'}.`
          + ' Tell the user it is in their Downloads.';
      }

      return {
        ok: true as const,
        rev,
        url,
        fileName: made.fileName,
        format: made.format,
        bytes: made.bytes,
        pages: (made as any).pages,
        droppedGlyphs: (made as any).droppedGlyphs,
        note: `Saved as ${made.fileName} and downloaded to their machine.${shareNote}`,
      };
    },
    'voidspace:board-document-read': async args => {
      const { listDocuments, outline, readSections } = await import('../document/sections');
      const noteId = String((args as any)?.noteId ?? '').trim();

      if (!noteId) {
        const docs = listDocuments(board);
        return {
          ok: true as const,
          rev,
          documents: docs,
          note: docs.length
            ? `${docs.length} document(s) on this board. Pass a noteId for its outline.`
            : 'No documents on this board yet. create_document makes one.',
        };
      }
      if (!board.store.getBlock(noteId)) {
        return fail('not_found', 'No document with that noteId is on this board.');
      }

      /**
       * SEARCH FIRST, when the caller knows the word. Returned with the section
       * id of every hit, so a search leads straight into a bounded read or an
       * edit of exactly the right place — which is the whole point of having
       * grep rather than paging.
       */
      const needle = String((args as any)?.search ?? '').trim();
      if (needle) {
        const { searchDocument } = await import('../document/sections');
        const hits = await searchDocument(board, noteId, needle);
        return {
          ok: true as const,
          rev,
          noteId,
          search: needle,
          hits,
          note: hits.length
            ? `${hits.length} match(es). Each carries the section id it is in — read or edit that `
              + 'section directly rather than walking the document.'
            : `Nothing matching "${needle}" in this document.`,
        };
      }

      const structure = outline(board, noteId);
      const ids: string[] = Array.isArray((args as any)?.sectionIds)
        ? (args as any).sectionIds.map(String)
        : [];

      // The outline alone, which is the cheap call this whole design rests on.
      if ((args as any)?.outlineOnly === true) {
        return {
          ok: true as const,
          rev,
          noteId,
          outline: structure,
          words: structure.filter(s => s.level <= 1).reduce((n, s) => n + s.words, 0),
          note: 'Outline only. Ask for the sections you need with sectionIds — their ids are '
            + 'stable, so you can hold them across edits.',
        };
      }

      const { markdown, omitted, words } = await readSections(board, noteId, {
        ids: ids.length ? ids : undefined,
        budget: Number((args as any)?.budget) || undefined,
      });
      return {
        ok: true as const,
        rev,
        noteId,
        outline: structure,
        markdown,
        words,
        ...(omitted.length ? { omitted } : {}),
        note: omitted.length
          ? `YOU HAVE NOT SEEN ALL OF IT — ${omitted.length} section(s) did not fit: `
            + `${omitted.slice(0, 6).map(o => o.heading || '(opening)').join(', ')}. `
            + 'Ask for them by id, and do NOT describe the document as complete.'
          : 'The whole document.',
      };
    },

    /**
     * EDIT one section of a document.
     *
     * Scoped on purpose: the cost of a change is the size of the change, not
     * the size of the document. Always returns the outline AFTER the edit,
     * because an edit moves things and a caller holding the old one would
     * address the wrong section next.
     */
    'voidspace:board-document-edit': async args => {
      const { editSection } = await import('../document/sections');
      const noteId = String((args as any)?.noteId ?? '').trim();
      if (!noteId || !board.store.getBlock(noteId)) {
        return fail('not_found', 'No document with that noteId is on this board.');
      }
      const where = String((args as any)?.where ?? 'replace');
      if (!['replace', 'before', 'after', 'append', 'delete'].includes(where)) {
        return fail('invalid', `where must be replace, before, after, append or delete — not "${where}".`);
      }
      if (where !== 'append' && !String((args as any)?.sectionId ?? '').trim()) {
        return fail('invalid', 'sectionId is required for everything but append.');
      }

      try {
        const { outline: fresh } = await editSection(board, noteId, where as any, {
          sectionId: String((args as any)?.sectionId ?? '') || undefined,
          markdown: String((args as any)?.markdown ?? ''),
        });
        return {
          ok: true as const,
          rev,
          noteId,
          outline: fresh,
          note: `Section ${where}d. The outline above is the document AFTER the edit — use these `
            + 'ids from now on. The user sees the change immediately; it is their document.',
        };
      } catch (e: any) {
        return fail('failed', e?.message ?? String(e));
      }
    },

    'voidspace:board-document-create': async args => {
      const markdown = String((args as any)?.markdown ?? '');
      if (!markdown.trim()) {
        return fail('invalid', 'There is nothing to put in the document — `markdown` is empty.');
      }
      const format = ['pdf', 'docx', 'md'].includes(String((args as any)?.format))
        ? (String((args as any).format) as 'pdf' | 'docx' | 'md')
        : 'pdf';
      const title = String((args as any)?.title ?? '').trim();

      /**
       * ── PUT IT ON THE BOARD, WHERE IT CAN BE CHANGED ──────────────────────
       *
       * The default, and the thing that makes this more than a file printer. A
       * document that arrives only as a download is finished the moment it is
       * made: the user reads it, wants the second paragraph shorter, and has
       * nowhere to do that but Word. Landing it as an editable note means the
       * agent drafts and the person revises, which is the actual division of
       * labour.
       *
       * `place: false` is for the caller that genuinely only wants the file.
       */
      const place = (args as any)?.place !== false;
      let noteId: string | undefined;
      let droppedNote = '';
      if (place) {
        const focus = opts.documentFocus?.();
        try {
          // No coordinates. `placeMarkdownDocument` lays a document onto the
          // SHELF — beside the documents already on this board, and only then
          // pushed clear of anything standing there. See document/layout.ts.
          const placed = await placeMarkdownDocument(board, markdown, { width: 800 });
          noteId = placed.noteId;
          if (placed.dropped.length) {
            droppedNote = ` The canvas cannot hold ${placed.dropped.join(' or ')}, so `
              + 'that part is in the file but not in the editable copy — say so.';
          }
          // Open it, for the same reason the storyboard scrolls to a new shot:
          // work the agent made that the user cannot see reads as nothing
          // having happened.
          focus?.open(placed.noteId);
        } catch (e: any) {
          // A document that could not be placed is still a document. Report the
          // file honestly rather than failing the whole call.
          droppedNote = ` It could not be added to the board — ${e?.message ?? 'unknown error'}`;
        }
      }

      let made;
      try {
        made = await saveDocument(markdown, title, format, {
          pageSize: (args as any)?.pageSize === 'letter' ? 'letter' : 'a4',
          typeface: (args as any)?.typeface === 'sans' ? 'sans' : 'serif',
          ...pageSetup(args),
        });
      } catch (e: any) {
        return fail('failed', e?.message || 'That document could not be laid out.');
      }

      /**
       * The upload can fail on its own — no network, no space — and when it
       * does the FILE STILL EXISTS on the user's machine. Reporting that as a
       * total failure would send the model looking for a problem the user
       * cannot see, so it is reported as what it is: made, not shared.
       */
      let url: string | undefined;
      let shareNote = '';
      try {
        ({ url } = await uploadDocument(made));
      } catch (e: any) {
        shareNote = ` It could not be uploaded, so there is no link — ${e?.message ?? 'unknown error'} `
          + 'Tell the user it is in their Downloads instead.';
      }

      return {
        ok: true as const,
        rev,
        fileName: made.fileName,
        format: made.format,
        bytes: made.bytes,
        ...(noteId ? { noteId } : {}),
        ...(url ? { url } : {}),
        ...(made.pages ? { pages: made.pages } : {}),
        ...(made.droppedGlyphs ? { droppedGlyphs: made.droppedGlyphs } : {}),
        note: `Made ${made.fileName} and downloaded it to the user's machine.`
          + (noteId
            ? ' It is also OPEN ON THE BOARD as an editable document — tell them they can '
              + 'type in it directly and export again from the bar at the top.'
            : '')
          + (url ? ' The URL is a copy they can share.' : '')
          + shareNote
          + droppedNote
          + (made.droppedGlyphs
            ? ` ${made.droppedGlyphs} character(s) — emoji or non-Latin script — could not be set `
              + 'in a PDF and were left out; say so, and offer docx instead.'
            : ''),
      };
    },

    /**
     * Everything compile needs, serialized.
     *
     * THE INVARIANT IS CHECKED ON THE SERVER, not here — deliberately. It is
     * "this screenplay parses back to exactly N beats", and the only honest way
     * to test that is with the parser the studio actually uses
     * (`studio/src/spec/screenplay.ts`). That module lives in the website repo
     * and cannot be imported from this app, and a second copy of a parser is a
     * second answer to the one question compile exists to get right. So the
     * board serializes, and `/api/board/compile` verifies before it writes
     * anything.
     */
    'voidspace:board-compile-payload': async args => {
      const shots = readShots(board.std);
      if (!shots.length) {
        return fail('empty_board', 'This board has no shots yet, so there is nothing to build.');
      }

      const payload = compileBoard(board.std, {
        title: String(args.title ?? '') || 'Untitled board',
        aspect: String(args.aspect ?? '') || '9:16',
        goal: String(args.goal ?? ''),
      });

      // The stored snapshot must not be older than the project built from it.
      await opts.flushCloud?.().catch(() => {});

      return { ok: true as const, rev, boardId: board.workspace.id, ...payload };
    },

    /**
     * Record that the board has been compiled — WITHOUT locking it.
     *
     * This used to set `store.readonly` and mark the chrome dead, because
     * compiling was a one-way door. It is not one any more: recompiling mints a
     * new project, so the board has to stay editable or a person who spots a
     * mistake loses everything on it.
     *
     * The handler is kept rather than deleted so an older client bundle — one
     * still calling it after compile — gets a success instead of an unknown-verb
     * error. It now just reports where the board went.
     */
    'voidspace:board-lock': args => {
      const projectId = String(args.projectId ?? '');
      // The chrome is told a project EXISTS, not that the board is finished.
      // The page uses this to show "open the project", never to disable editing.
      if (projectId) document.documentElement.dataset.compiled = projectId;
      return {
        ok: true as const,
        rev,
        locked: false,
        compiledProjectId: projectId,
      };
    },

    /**
     * Frame the whole storyboard. The agent calls this after structural edits.
     *
     * Through the SHARED fit, so the left padding is measured from the asset
     * panel rather than assumed. The hardcoded 110 that used to be here put
     * shot 1 underneath the panel — the agent would lay out a storyboard and
     * the first thing it made was the one thing the user could not see.
     */
    'voidspace:board-fit': () => {
      fitBoard({ smooth: false });
      return { ok: true as const, rev };
    },

    /**
     * Render the board's tile preview and hand back a JPEG data URL.
     *
     * The parent asks for this after a save settles; it never renders itself,
     * because only this side has the shots. See `board/thumbnail.ts` for why
     * the preview is drawn from data rather than screenshotted off the canvas.
     *
     * `src` is the card's own small proxy, not `url` — a 480px tile has no use
     * for a master, and using it would make the preview the slow path.
     */
    'voidspace:board-thumbnail': async () => {
      const all = readShots(board.std);
      const dataUrl = await renderBoardThumbnail({
        shots: all.map(s => {
          const pick = (s.media ?? []).find(m => m.kind === 'image')
            ?? (s.media ?? []).find(m => !!m.poster);
          return {
            title: s.title ?? '',
            kind: s.kind ?? 'clip',
            mediaUrl: pick ? (pick.kind === 'image' ? (pick.src || pick.url) : (pick.poster || '')) : '',
          };
        }),
      });
      return { ok: true as const, rev, dataUrl, shots: all.length };
    },

    /** Which shot is at a model point. Used by the drop path's tests. */
    'voidspace:board-shot-at': args => ({
      ok: true as const,
      rev,
      shotId: shotAtPoint(board.std, [Number(args.x ?? 0), Number(args.y ?? 0)]),
    }),
  };

  const onMessage = async (e: MessageEvent) => {
    const data = e.data as Record<string, unknown> | null;
    const type = typeof data?.type === 'string' ? data.type : '';
    if (!type.startsWith('voidspace:board-')) return;
    const handler = handlers[type];
    if (!handler) return;

    /**
     * ── ONE AGENT ACTION IS ONE Ctrl+Z ──────────────────────────────────────
     *
     * BlockSuite merges consecutive writes into one undo unit until something
     * calls `captureSync()`. That is right for a person typing, and wrong the
     * moment a second author appears: with no boundary, whatever the agent does
     * next merges into whatever the USER did last, so one Ctrl+Z takes back both
     * — their sentence AND the agent's twelve cards — and there is no way to
     * undo the agent's work alone.
     *
     * Several individual paths already closed the unit themselves (`drawOnCanvas`,
     * `arrangeCanvas`, the shot block's own setters). That is exactly the problem:
     * it was per-path, so whether an agent action was separately undoable
     * depended on which verb it happened to be, and nothing checked the ones that
     * did not. Doing it HERE makes it true of all of them, including every verb
     * added later.
     *
     * READS ARE EXCLUDED on purpose. A checkpoint is harmless to the document but
     * not free to the user: `board_read` runs on effectively every turn, and
     * splitting somebody's in-progress typing into two undo units because an
     * agent glanced at the board is a worse bug than the one being fixed.
     */
    if (!READ_ONLY_RPC.has(type)) {
      try { board.std.store.captureSync(); } catch { /* never block an action over undo */ }
    }

    const requestId = data?.requestId;
    const reply: Reply = payload => {
      (e.source as Window | null)?.postMessage({ ...payload, requestId }, '*');
    };

    try {
      // Awaited: canvas placement fetches over the network, so a handler may be
      // async. Replying before it finishes would tell the agent "done" while the
      // canvas was still empty.
      reply({ type: `${type}-result`, ...((await handler(data!)) as object) });
    } catch (err) {
      // Structured, not thrown: the agent can read a reason and retry, whereas a
      // silent drop would hang its tool call until the bridge timed out.
      reply({
        type: 'voidspace:error',
        ok: false,
        reason: 'handler_threw',
        message: (err as Error)?.message ?? String(err),
      });
    }
  };

  window.addEventListener('message', onMessage);
  return () => {
    window.removeEventListener('message', onMessage);
    sub.unsubscribe?.();
    selectionSub.unsubscribe?.();
    digestSub.unsubscribe?.();
    // A pending debounce would fire into a torn-down board on the next remount.
    if (digestTimer) clearTimeout(digestTimer);
    // A remount must not leave a "Generating…" toast on screen forever.
    progress.forEach(close => close());
    progress.clear();
  };
}
