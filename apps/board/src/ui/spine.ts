/**
 * THE SPINE — the film's structure, drawn over the board.
 *
 * ── WHAT IT IS FOR ───────────────────────────────────────────────────────────
 * The board holds a hierarchy and showed none of it. Acts, sequences and scenes
 * are all in the screenplay, a shot names the scene it covers, and a shot owns
 * its takes — so the whole shape of the film was in the document and the canvas
 * drew a row of identical cards. You could read a shot; you could not read the
 * FILM. This is the layer that says: these five shots are scene 3, these three
 * scenes are the chase, the chase is in act two.
 *
 * ── WHY IT IS DRAWN AND NOT BUILT OUT OF BLOCKS ──────────────────────────────
 * A bracket is not a thing on the board — it is a statement ABOUT things on the
 * board, and it changes the instant a shot is re-filed or a slugline is renamed.
 * As blocks they would be objects the user can select, drag out of alignment,
 * delete by accident and undo into existence, and every one of those would be a
 * lie about a structure they do not own. As a drawing there is nothing to get
 * out of step: it is recomputed from the plan, every frame it matters.
 *
 * One SVG over the canvas, in model space, moved by the same transform the
 * canvas uses. Nothing here takes a pointer event — see `pointer-events: none`
 * on the host — so it cannot come between the user and a card. It sits above
 * the editor because the editor paints an opaque background over everything
 * below it, and beneath our own controls; the marks live in the gutter and in
 * the gaps between cards, so there is nothing for them to obscure.
 *
 * ── AND WHY IT LOOKS HAND-DRAWN ──────────────────────────────────────────────
 * A ruled bracket reads as chrome: a thing the application drew, like a border
 * or a scrollbar, and the eye files it with the furniture. The point of these is
 * the opposite — they are the marks a director makes on a real board, and they
 * should read as annotation, as something a person put there. Two strokes with a
 * deterministic wobble do that, and the determinism matters: seeded off the
 * title, so a bracket does not shiver every time the viewport moves.
 */
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';

import type { MountedBoard } from '../blocksuite/editor';
import { GUTTER } from '../shot/layout';
import { SHOT_GAP, SHOT_W } from '../shot/model';
import { boardPlan } from '../shot/shots';

const NS = 'http://www.w3.org/2000/svg';

/** How far in from the row's left edge each level of bracket sits. */
const ACT_X = 26;
const SEQ_X = 132;
const SCENE_X = 232;

/**
 * A repeatable wobble.
 *
 * `Math.random` would make every repaint a different drawing, and the board
 * repaints on every pan — the brackets would crawl. Hashing the title gives each
 * bracket its own hand while keeping it the SAME hand for as long as it is the
 * same bracket.
 */
function wobbler(seed: string): (i: number, amount: number) => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (i, amount) => {
    let x = h ^ Math.imul(i + 1, 2654435761);
    x ^= x >>> 15;
    x = Math.imul(x, 2246822519);
    x ^= x >>> 13;
    return (((x >>> 0) / 4294967295) * 2 - 1) * amount;
  };
}

/**
 * A curly brace down the left of a block of rows, drawn as one path.
 *
 * The shape is the classic one — two arcs meeting at a spur in the middle — and
 * it is built from cubic segments rather than an arc command so the wobble can
 * be applied to the control points, which is what makes it look drawn rather
 * than warped.
 */
function bracePath(x: number, y: number, height: number, depth: number, seed: string): string {
  const w = wobbler(seed);
  const mid = y + height / 2;
  const lip = Math.min(30, height / 6);
  const j = (i: number) => w(i, Math.max(1.5, depth * 0.18));

  return [
    `M ${x + depth + j(0)} ${y + j(1)}`,
    `C ${x + depth * 0.2 + j(2)} ${y + lip + j(3)}, ${x + depth * 0.9 + j(4)} ${y + lip + j(5)}, `
      + `${x + depth * 0.35 + j(6)} ${mid - lip + j(7)}`,
    `C ${x + depth * 0.1 + j(8)} ${mid + j(9)}, ${x - depth * 0.1 + j(10)} ${mid + j(11)}, `
      + `${x + j(12)} ${mid + j(13)}`,
    `C ${x - depth * 0.1 + j(14)} ${mid + j(15)}, ${x + depth * 0.1 + j(16)} ${mid + j(17)}, `
      + `${x + depth * 0.35 + j(18)} ${mid + lip + j(19)}`,
    `C ${x + depth * 0.9 + j(20)} ${y + height - lip + j(21)}, `
      + `${x + depth * 0.2 + j(22)} ${y + height - lip + j(23)}, `
      + `${x + depth + j(24)} ${y + height + j(25)}`,
  ].join(' ');
}

/** The arrow between two shots in a row — this cuts to that. */
function cutPath(fromRight: number, toLeft: number, y: number, seed: string): string {
  const w = wobbler(seed);
  const j = (i: number) => w(i, 2.2);
  const midY = y + j(0);
  return `M ${fromRight + 6} ${midY} `
    + `C ${fromRight + (toLeft - fromRight) * 0.4} ${midY + j(1) * 3}, `
    + `${fromRight + (toLeft - fromRight) * 0.6} ${midY + j(2) * 3}, ${toLeft - 12} ${midY}`;
}

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export function installSpine(board: MountedBoard, container: HTMLElement): () => void {
  const gfx = board.std.get(GfxControllerIdentifier);

  const host = document.createElement('div');
  host.className = 'vs-spine';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'vs-spine__svg');
  host.append(svg);
  /**
   * FIRST CHILD, so it is the lowest of the chrome in document order as well as
   * by z-index. The panel and the toolbars are appended after and stay on top,
   * which is right: they are controls and this is a drawing.
   */
  container.prepend(host);

  /** Rebuilt wholesale rather than diffed: the whole thing is a few dozen nodes
   *  and the plan changes as a unit, so there is nothing a diff would save. */
  function paint(): void {
    const plan = boardPlan(board.std);
    svg.replaceChildren();

    // A board with no structure gets no chrome at all — see `hasStructure`.
    if (plan.flat) { host.hidden = true; return; }
    host.hidden = false;

    // ── ACTS, outermost ─────────────────────────────────────────────────────
    for (const act of plan.acts) {
      svg.append(el('path', {
        d: bracePath(ACT_X, act.y - 40, act.height + 80, 44, `act:${act.title}`),
        class: 'vs-spine__brace vs-spine__brace--act',
      }));
      /**
       * WELL CLEAR OF THE SEQUENCE LABEL BELOW IT. An act and its first sequence
       * begin on the same row, so their headings start at the same y — set a few
       * pixels apart they printed over each other, and the one thing a heading
       * cannot be is unreadable.
       */
      const label = el('text', {
        x: ACT_X + 58, y: act.y - 82, class: 'vs-spine__label vs-spine__label--act',
      });
      label.textContent = act.title.toUpperCase();
      svg.append(label);
    }

    // ── SEQUENCES, inside them ──────────────────────────────────────────────
    for (const seq of plan.sequences) {
      svg.append(el('path', {
        d: bracePath(SEQ_X, seq.y - 16, seq.height + 32, 30, `seq:${seq.title}`),
        class: 'vs-spine__brace vs-spine__brace--seq',
      }));
      const label = el('text', {
        x: SEQ_X + 42, y: seq.y - 26, class: 'vs-spine__label vs-spine__label--seq',
      });
      label.textContent = seq.title;
      svg.append(label);
    }

    // ── SCENES, and the shots that cover them ───────────────────────────────
    for (const row of plan.rows) {
      const mid = row.y + row.height / 2;

      if (row.sceneKey) {
        // A tick and the scene's own name, level with its row of shots.
        svg.append(el('path', {
          d: `M ${SCENE_X + 76} ${row.y + 8} L ${SCENE_X + 84} ${mid} L ${SCENE_X + 76} ${
            row.y + row.height - 8}`,
          class: 'vs-spine__tick',
        }));
        const n = el('text', { x: SCENE_X, y: mid - 6, class: 'vs-spine__scene-n' });
        n.textContent = `sc ${row.sceneNumber}`;
        svg.append(n);
        const h = el('text', { x: SCENE_X, y: mid + 16, class: 'vs-spine__scene-h' });
        // Trimmed rather than wrapped: a slugline is one line by definition, and
        // a wrapped one would push into the cards.
        h.textContent = row.heading.length > 34
          ? `${row.heading.slice(0, 33)}…` : row.heading;
        svg.append(h);
      } else {
        const n = el('text', { x: SCENE_X, y: mid, class: 'vs-spine__scene-n' });
        n.textContent = 'not on the script yet';
        svg.append(n);
      }

      /**
       * THE CUT, drawn between one shot and the next.
       *
       * Only WITHIN a row: an arrow from the last shot of one scene to the first
       * of the next would be drawing the cut between scenes, which is what the
       * bracket above already says and would cross the whole board to say it.
       */
      for (let i = 0; i + 1 < row.shotIds.length; i++) {
        const fromRight = GUTTER + i * (SHOT_W + SHOT_GAP) + SHOT_W;
        const toLeft = GUTTER + (i + 1) * (SHOT_W + SHOT_GAP);
        svg.append(el('path', {
          d: cutPath(fromRight, toLeft, mid, `cut:${row.sceneKey}:${i}`),
          class: 'vs-spine__cut',
          'marker-end': 'url(#vs-spine-arrow)',
        }));
      }

      // An empty scene says so, in the space its shots would occupy.
      if (!row.shotIds.length) {
        const empty = el('text', {
          x: GUTTER, y: mid + 5, class: 'vs-spine__empty',
        });
        empty.textContent = 'no shots yet';
        svg.append(empty);
      }
    }

    // The arrowhead, defined once and referenced by every cut.
    const defs = document.createElementNS(NS, 'defs');
    const marker = el('marker', {
      id: 'vs-spine-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5,
      markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse',
    });
    marker.append(el('path', { d: 'M 0 1 L 9 5 L 0 9 z', class: 'vs-spine__head' }));
    defs.append(marker);
    svg.prepend(defs);
  }

  /**
   * FOLLOW THE CANVAS EXACTLY.
   *
   * The same transform BlockSuite gives its own blocks
   * (`GfxBlockComponent.getCSSTransform`), so a bracket cannot drift a pixel
   * from the cards it encloses at any zoom. Writing `transform` directly rather
   * than re-rendering: this runs on every frame of a pan.
   */
  function place(): void {
    const { translateX, translateY, zoom } = gfx.viewport;
    svg.style.transformOrigin = '0 0';
    svg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${zoom})`;
    // The stroke has to be scaled back out, or a brace drawn at 10% zoom is a
    // hairline and at 400% is a slab.
    svg.style.setProperty('--vs-spine-zoom', String(zoom));
  }

  place();
  paint();

  const onViewport = gfx.viewport.viewportUpdated.subscribe(place);

  /**
   * ONE REPAINT PER FRAME, not one per write.
   *
   * `blockUpdated` fires on every mutation — every pointermove of a drag, and
   * once per card when the board re-flows. Painting synchronously on each meant
   * rebuilding every brace, label and arrow on the board tens of times inside a
   * single frame, all but the last of them thrown away before anything was
   * shown. `boardPlan` is memoised per revision, but a re-flow moves the
   * revision on every card it touches, so the memo was missing every time.
   *
   * Nothing a person can see changes faster than a frame, which is the honest
   * rate for a drawing.
   */
  let queued = false;
  const onDoc = board.store.slots.blockUpdated.subscribe(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (host.isConnected) paint();
    });
  });

  return () => {
    onViewport.unsubscribe();
    onDoc.unsubscribe();
    host.remove();
  };
}
