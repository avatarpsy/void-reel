/**
 * `boardMeta` — the sidecar for media placed on the OPEN CANVAS.
 *
 * A top-level `Y.Map` keyed by block id, sibling to the block tree. Inside the
 * doc because it must merge under concurrent edits, undo together with the block
 * it describes, and survive offline; a second sync channel would be a second
 * source of truth. NOT inside block props, because those belong to BlockSuite's
 * schema and a field we invent there is a field an upgrade can take away.
 *
 * WHAT IS NO LONGER HERE, AND WHY THAT MATTERS
 * This map used to carry a shot's whole vocabulary: which template part a block
 * was, which field, what role its media played, which page each lane was showing.
 * All of that described things INSIDE a shot — and a shot now owns its media as
 * props (`shot/model.ts`), so those entries had become a second, weaker answer to
 * questions the shot could answer itself. Keeping both is how a reference ends up
 * labelled FIRST FRAME on the canvas and REFERENCE in the compiled screenplay.
 *
 * What is left is the minimum needed to identify a LOOSE canvas block: which
 * Library asset it came from, and where the full-quality file is. The viewer
 * reads it to know what to play; nothing else does.
 */
import type * as Y from 'yjs';

/** The doc-level key. Fixed, because reading a board written by an older build
 *  must find the same map. */
const META_KEY = 'boardMeta';

export interface BlockMeta {
  /** Voidspace Library id. */
  mediaId?: string;
  /** Which library the id belongs to; the id spaces are separate. */
  scope?: 'mine' | 'shared' | 'device';
  kind?: 'image' | 'video' | 'audio';
  /** The FULL-QUALITY url. The canvas shows a display-sized variant; anything
   *  built from this board must not be built from a 720px proxy. */
  originalUrl?: string;
  /** What the user would call it — the viewer's title. */
  name?: string;
  /** Who put it there. Lets the agent avoid re-offering what it already made. */
  createdBy?: 'user' | 'agent';

  /**
   * ── WHERE THIS CAME FROM ───────────────────────────────────────────────────
   *
   * THE FIX FOR THE THING THAT ACTUALLY BREAKS ITERATION. Someone generates an
   * image from three references. Five minutes and nine pictures later they say
   * "that one, but warmer" — and nobody in the room knows what "that one" was
   * made from. Not the user, who has scrolled past the chat message, and not the
   * agent, which has no record at all. So "but warmer" becomes a fresh guess
   * rather than an edit, the result does not match, and the user concludes the
   * model is bad at following instructions.
   *
   * This is deliberately the answer to "let the user mark things up" rather than
   * a tagging system: it costs the user NOTHING. Nobody has to remember to label
   * anything mid-flow, which is the reason tag systems on canvases go unused.
   * The board remembers instead.
   */
  /** The prompt that made it. Present on generated media only. */
  prompt?: string;
  /** The canvas blocks used as references, so "the same but…" can re-use them. */
  referenceIds?: string[];
  /** Which model made it — a look is partly the model, and they change. */
  model?: string;
  /** The page a web import came from, and who to credit. */
  sourceUrl?: string;
  credit?: string;

  /**
   * ── WHAT SCENE THIS IS ABOUT ───────────────────────────────────────────────
   *
   * A reference had exactly two homes: INSIDE a shot, where it is used to
   * generate that shot's picture, or LOOSE on the canvas, where it belongs to
   * nobody. There was no way to say the thing people actually say — "this is the
   * look of the kitchen scene" — which is most of what a mood board IS.
   *
   * So: a loose canvas block may name the scene it is about. It is still not
   * compiled (only a shot's own references are), and it is still the user's to
   * drag anywhere. What it buys is that the scene can be ASKED: `board_canvas_read`
   * reports it, so "what have we got for scene 3" is answerable, and
   * `board_arrange { sceneKey }` can gather them back beside that scene's row.
   *
   * A SCENE, NOT A SEQUENCE. A scene is the unit shots attach to, the unit that
   * has a row on the board, and the unit the agent works through one at a time.
   * Anything coarser is a FRAME with a title — which is how grouping already
   * works here, and one mechanism beats two.
   *
   * DELIBERATELY NOT SNAPPED. `relayoutShots` does not move these when the grid
   * moves, because a reference the user dragged somewhere is a decision, and
   * silently putting it back is the behaviour the board already refuses for a
   * renamed slugline: drift is SURFACED and re-pointed on request, never
   * re-bound behind the user's back.
   */
  sceneKey?: string;
}

function map(doc: Y.Doc): Y.Map<BlockMeta> {
  return doc.getMap<BlockMeta>(META_KEY);
}

export function readBlockMeta(doc: Y.Doc, blockId: string): BlockMeta | undefined {
  return map(doc).get(blockId);
}

/**
 * Merge fields onto one block's meta.
 *
 * Merging rather than replacing because the writers are independent and neither
 * should have to know what the other stores.
 */
export function writeBlockMeta(doc: Y.Doc, blockId: string, patch: BlockMeta): void {
  const m = map(doc);
  m.set(blockId, { ...(m.get(blockId) ?? {}), ...patch });
}

export function deleteBlockMeta(doc: Y.Doc, blockId: string): void {
  map(doc).delete(blockId);
}

export function allBlockMeta(doc: Y.Doc): Record<string, BlockMeta> {
  return Object.fromEntries(map(doc).entries());
}

/**
 * Drop meta for blocks that no longer exist.
 *
 * Called after deletions rather than on every change: the map is tiny, and
 * pruning inside an observer would run mid-transaction while ids are still
 * settling. Left unpruned it is not a correctness bug — nothing reads meta for a
 * missing block — but it would grow forever across a long editing session and
 * ride along in every cloud snapshot.
 */
export function pruneBlockMeta(doc: Y.Doc, liveIds: Set<string>): number {
  const m = map(doc);
  const dead: string[] = [];
  m.forEach((_v, id) => { if (!liveIds.has(id)) dead.push(id); });
  if (!dead.length) return 0;
  doc.transact(() => { dead.forEach(id => m.delete(id)); });
  return dead.length;
}
