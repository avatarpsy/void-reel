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
import type { MountedBoard } from '../blocksuite/editor';
import { placeAsset } from '../board/asset-media';
import { compileBoard, describeShot } from '../shot/screenplay';
import {
  MEDIA_ROLES, REF_KINDS, SHOT_H, SHOT_W, isTimed, normaliseShotKind, rolesFor, trimWindow,
  type MediaRole, type RefKind,
} from '../shot/model';
import { allBlocks, findBlock, searchBlocks, setBlockCatalogue } from '../shot/blocks';
import {
  SEQUENCE_PURPOSES, nextSceneId, nextSequenceId, plannedRuntimeSec, readScreenplay,
  sceneLetter, writeScreenplay,
} from '../shot/screenplay-doc';
import {
  allModels, checkShot, effectiveModel, estimateShotCredits, findModel, referenceTag,
  setModelCatalogue, type ModelCaps,
} from '../shot/models';
import {
  addMedia, createShots, deleteShot, moveMedia, readShot, readShots,
  relayoutShots, removeMedia, setMediaRole, setShotFields, shotAtPoint, tagMedia, trimMedia,
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
  const sp = readScreenplay(board.std);

  /**
   * WHICH SCENES STILL HAVE NO SHOTS.
   *
   * Reported rather than left to be worked out, because it IS the agent's to-do
   * list — the whole "now let us go scene by scene" flow is driven by this one
   * array. An agent that had to derive it from two other arrays sometimes would
   * not bother, and would then declare a storyboard finished with a hole in it.
   */
  const shotCountByScene = new Map<string, number>();
  for (const sh of shots) {
    if (!sh.sceneId) continue;
    shotCountByScene.set(sh.sceneId, (shotCountByScene.get(sh.sceneId) ?? 0) + 1);
  }
  const seqNumber = new Map(sp.sequences.map((q, i) => [q.id, i + 1] as const));

  return {
    ok: true as const,
    rev,
    boardId: board.workspace.id,
    surfaceId: board.surfaceId,
    shotCount: shots.length,
    /**
     * THE SCREENPLAY — Sequence → Scene → Shot.
     *
     * Sent on EVERY read, not behind a separate tool, because the structure is
     * what makes any individual shot answerable. An agent asked to improve shot
     * 4 can only talk about shot 4 unless something says shot 4 is the turn.
     */
    screenplay: {
      title: sp.title,
      logline: sp.logline,
      audience: sp.audience,
      voice: sp.voice,
      notes: sp.notes,
      plannedRuntimeSec: plannedRuntimeSec(sp),
      sequences: sp.sequences.map((q, i) => ({
        id: q.id,
        n: i + 1,
        title: q.title,
        purpose: q.purpose,
        summary: q.summary,
        targetSec: q.targetSec,
        music: q.music,
        look: q.look,
        sceneIds: sp.scenes.filter(c => c.sequenceId === q.id).map(c => c.id),
      })),
      scenes: sp.scenes.map((c, i) => ({
        id: c.id,
        letter: sceneLetter(i),
        sequenceId: c.sequenceId,
        sequence: seqNumber.get(c.sequenceId) ?? 0,
        slug: c.slug,
        summary: c.summary,
        shotCount: shotCountByScene.get(c.id) ?? 0,
      })),
      /** Scene ids with nothing shot for them — where the work is. */
      emptyScenes: sp.scenes.filter(c => !shotCountByScene.has(c.id)).map(c => c.id),
      /** Sequences with no scenes at all — one level further back. */
      emptySequences: sp.sequences
        .filter(q => !sp.scenes.some(c => c.sequenceId === q.id))
        .map(q => q.id),
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
        /** Which scene this shot covers. '' when unplaced, which is legal. */
        sceneId: s.sceneId,
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
}

export function installBoardRpc(board: MountedBoard, opts: BoardRpcOptions = {}): () => void {
  // Every block change bumps the revision, whoever made it. Nothing else needs
  // doing here any more: a shot's media live in its own props, so deleting a
  // shot takes its references with it and there is no sidecar left to prune.
  const sub = board.store.slots.blockUpdated.subscribe(() => { rev++; });

  /** Every mutating handler starts the same way. */
  const guard = (args: Record<string, unknown>) => {
    const locked = checkWritable(board);
    if (!locked.ok) return locked;
    return checkRev(args.expectRev);
  };

  /** Resolve a shot id, or say plainly that it is gone. */
  const needShot = (id: string) =>
    readShot(board.std, id)
      ? null
      : fail('not_found', `No shot with id ${id}. Call board_read for the current ids.`);

  const handlers: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {
    /** Read the board. Cheap, no side effects — the agent may call it freely. */
    'voidspace:board-read': () => digest(board),

    /**
     * THE SCREENPLAY — written whole, in one call.
     *
     * Whole rather than incrementally, because a screenplay is a SHAPE: a tool
     * that could only append would let an agent bolt a fourth sequence onto a
     * three-sequence piece without ever reconsidering the first three. Rewriting
     * is one undo step, so a bad restructure costs the user one Ctrl+Z.
     *
     * Ids are preserved across a rewrite when the caller sends them back, which
     * is how shots keep their scene. An agent that drops an id gets a new scene
     * and its shots become unplaced — recoverable, and visible immediately,
     * because the panel will say "no shots" against it.
     */
    'voidspace:board-write-screenplay': args => {
      const g = guard(args); if (!g.ok) return g;
      const current = readScreenplay(board.std);
      const patch: Record<string, unknown> = {};
      for (const k of ['title', 'logline', 'audience', 'voice', 'notes'] as const) {
        if (typeof args[k] === 'string') patch[k] = args[k];
      }

      if (Array.isArray(args.sequences)) {
        const taken = new Set<string>();
        patch.sequences = (args.sequences as unknown[]).map(raw => {
          const q = (raw ?? {}) as Record<string, unknown>;
          // Two sequences sharing an id would silently merge their scenes, so a
          // duplicate is given a fresh id rather than accepted.
          let id = String(q.id ?? '').trim() || nextSequenceId(
            [...current.sequences, ...[...taken].map(t => ({ id: t } as never))],
          );
          while (taken.has(id)) id = `${id}b`;
          taken.add(id);
          return {
            id,
            title: String(q.title ?? ''),
            purpose: SEQUENCE_PURPOSES.includes(q.purpose as never) ? q.purpose : 'setup',
            summary: String(q.summary ?? ''),
            targetSec: Number(q.targetSec) > 0 ? Number(q.targetSec) : 0,
            music: String(q.music ?? ''),
            look: String(q.look ?? ''),
          };
        });
      }

      if (Array.isArray(args.scenes)) {
        const taken = new Set<string>();
        patch.scenes = (args.scenes as unknown[]).map(raw => {
          const c = (raw ?? {}) as Record<string, unknown>;
          let id = String(c.id ?? '').trim() || nextSceneId(
            [...current.scenes, ...[...taken].map(t => ({ id: t } as never))],
          );
          while (taken.has(id)) id = `${id}b`;
          taken.add(id);
          return {
            id,
            sequenceId: String(c.sequenceId ?? ''),
            slug: String(c.slug ?? ''),
            summary: String(c.summary ?? ''),
          };
        });
      }

      if (!Object.keys(patch).length) {
        return fail(
          'empty',
          'Give at least one of: title, logline, audience, voice, notes, sequences, scenes.',
        );
      }

      writeScreenplay(board.std, board.surfaceId, patch as never);
      rev++;
      return digest(board);
    },

    /**
     * Put a shot in a scene, or take it out of one.
     *
     * Separate from `board-update-shot` because it is a STRUCTURAL move rather
     * than an edit to the shot's content, and because it needs to validate
     * against the screenplay — a shot pointing at a scene that does not exist is
     * how a storyboard starts claiming coverage it has not got.
     */
    'voidspace:board-set-scene': args => {
      const g = guard(args); if (!g.ok) return g;
      const shotId = String(args.shotId ?? '');
      const missing = needShot(shotId); if (missing) return missing;
      const sceneId = String(args.sceneId ?? '').trim();
      if (sceneId) {
        const sp = readScreenplay(board.std);
        if (!sp.scenes.some(c => c.id === sceneId)) {
          return fail(
            'unknown_scene',
            `No scene "${sceneId}" in the screenplay. Call board_read for the scene ids, `
            + 'or write the screenplay first with board_write_screenplay.',
          );
        }
      }
      setShotFields(board.std, shotId, { sceneId } as never);
      rev++;
      return digest(board);
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
      const sceneId = String(args.sceneId ?? '').trim();
      if (sceneId && !readScreenplay(board.std).scenes.some(c => c.id === sceneId)) {
        return fail(
          'unknown_scene',
          `No scene "${sceneId}" in the screenplay. Call board_read for the scene ids, `
          + 'or write the screenplay first with board_write_screenplay.',
        );
      }
      const made = createShots(board.std, board.surfaceId, titles);
      if (sceneId) {
        for (const id of made) setShotFields(board.std, id, { sceneId } as never);
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

      const url = String(args.url ?? args.originalUrl ?? '');
      if (!url) return fail('empty', 'No media url was given.');
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
     * Place a Library asset on the OPEN CANVAS — thinking space, not a shot.
     *
     * Kept for the agent's "put this where I can see it" case: mood boards,
     * alternatives to compare, anything not yet committed to a scene. Anything
     * meant for a scene goes through `board-attach-media`, which is both cheaper
     * and the only route compile reads.
     */
    'voidspace:board-insert-media': async args => {
      const g = guard(args); if (!g.ok) return g;
      const url = String(args.displayUrl ?? args.url ?? '');
      if (!url) return fail('empty', 'No media url was given.');
      const kind = args.kind === 'video' || args.kind === 'audio' ? args.kind : 'image';
      const placed = await placeAsset(board.std, {
        displayUrl: url,
        originalUrl: typeof args.originalUrl === 'string' ? args.originalUrl : undefined,
        kind,
        mediaId: typeof args.mediaId === 'string' ? args.mediaId : undefined,
        scope: args.scope === 'shared' || args.scope === 'device' ? args.scope : 'mine',
        name: typeof args.name === 'string' ? args.name : undefined,
        posterUrl: typeof args.posterUrl === 'string' ? args.posterUrl : undefined,
        bytes: typeof args.bytes === 'number' ? args.bytes : undefined,
      });
      // A DEAD LINK IS NOT A CRASH. The agent needs to be told the asset could
      // not be loaded so it can say so, rather than reporting success over an
      // empty canvas.
      if (!placed.ok) return fail(placed.reason, placed.message);
      return { ...digest(board), insertedId: placed.blockId };
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
  };
}
