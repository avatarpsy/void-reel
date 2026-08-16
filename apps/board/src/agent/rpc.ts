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

import type { MountedBoard } from '../blocksuite/editor';
import { placeAsset } from '../board/asset-media';
import {
  COLOR_NAMES, drawOnCanvas, editCanvas, mediaUrlOf, readCanvas, readSelection,
  type EditOp, type ElementSpec,
} from '../board/canvas';
import { pendingToast } from '../ui/toast';
import { renderBoardThumbnail } from '../board/thumbnail';
import { compileBoard, describeShot } from '../shot/screenplay';
import {
  MEDIA_ROLES, REF_KINDS, SHOT_H, SHOT_W, chosenTake, isTimed, normaliseShotKind, rolesFor,
  trimWindow, type MediaRole, type RefKind, type ShotTake,
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
  allModels, checkShot, effectiveModel, estimateShotCredits, findModel, plannedSeconds,
  referenceTag, setModelCatalogue, type ModelCaps,
} from '../shot/models';
import {
  addMedia, addTake, chooseTake, createShots, deleteShot, moveMedia, readShot, readShots,
  relayoutShots, removeMedia, removeTake, setMediaRole, setShotFields, shotAtPoint, tagMedia,
  trimMedia, updateTake,
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
      const warnings = checkShot(s);
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
        // SAID OUT LOUD, every read. A warning the agent has to go and ask for
        // is a warning it will not ask for.
        warnings: warnings.map(w => w.message),
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
       * WHETHER THE MODEL SPEAKS, resolved here rather than on the page.
       *
       * Two gates, and both matter. The user's choice comes first — a silent
       * shot stays silent even on a model that could talk. But `dialogue` is
       * only ever sent to a model that HAS native dialogue: asking one that
       * cannot for it either errors deep in a provider or, worse, is accepted
       * and ignored, and the user is charged for a clip that was never going to
       * speak. `checkShot` already warns on the card when a narration is written
       * against a model that cannot voice it.
       */
      const wantsDialogue = shot.voiceMode === 'dialogue' && !!caps?.nativeDialogue;

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
        voiceMode: wantsDialogue ? 'dialogue' : 'silent',
        /** Set when a narration was written but this model cannot voice it —
         *  the line still gets spoken, separately, as TTS over the clip. */
        narrationIsSeparate: !!shot.voiceover.trim() && !wantsDialogue,
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

      /** A tidy grid in clear space, unless the caller said where. */
      const COLS = 4;
      const CELL_W = 340;
      const CELL_H = 250;
      const origin = { x: 0, y: SHOT_H + 240 };

      const placedIds: string[] = [];
      const problems: string[] = [];
      let missingDisplay = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const url = String(row.displayUrl ?? row.url ?? '');
        if (!url) { problems.push(`Item ${i + 1} had no url.`); continue; }
        if (!row.displayUrl) missingDisplay++;

        const kind = row.kind === 'video' || row.kind === 'audio' ? row.kind : 'image';
        const at = rows.length > 1
          ? {
              x: origin.x + (i % COLS) * CELL_W,
              y: origin.y + Math.floor(i / COLS) * CELL_H,
            }
          : null;

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
          // Provenance travels with the asset — see `BlockMeta`.
          ...(typeof row.prompt === 'string' ? { prompt: row.prompt } : {}),
          ...(Array.isArray(row.referenceIds) ? { referenceIds: row.referenceIds.map(String) } : {}),
          ...(typeof row.model === 'string' ? { model: row.model } : {}),
          ...(typeof row.sourceUrl === 'string' ? { sourceUrl: row.sourceUrl } : {}),
          ...(typeof row.credit === 'string' ? { credit: row.credit } : {}),
        });

        // A DEAD LINK IS NOT A CRASH. The agent needs to be told an asset could
        // not be loaded so it can say so, rather than reporting success over an
        // empty canvas.
        if (!placed.ok) { problems.push(`${row.name ?? url}: ${placed.message}`); continue; }
        placedIds.push(placed.blockId);

        // Arranged AFTER placement: the insert helpers size a card from the real
        // media, so overriding the box here would undo the aspect they just
        // worked out. Only the position moves.
        if (at) {
          const model = board.store.getBlock(placed.blockId)?.model;
          const box = model ? bounds(model.props as { xywh?: string }) : null;
          if (model && box) {
            board.store.updateBlock(model, { xywh: `[${at.x},${at.y},${box.w},${box.h}]` });
          }
        }
      }

      if (!placedIds.length) {
        return fail(
          'unavailable',
          problems.join(' ') || 'Nothing could be placed on the canvas.',
        );
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
      const items = readCanvas(board.std, selectionOnly);
      const selection = readSelection(board.std);
      return {
        ok: true as const,
        rev,
        count: items.length,
        /** The vocabulary `board_draw` takes, so a read teaches the write. */
        colors: COLOR_NAMES,
        items,
        /** What the user is pointing at, always — even on a full read. */
        selectedIds: selection.ids,
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
    // A remount must not leave a "Generating…" toast on screen forever.
    progress.forEach(close => close());
    progress.clear();
  };
}
