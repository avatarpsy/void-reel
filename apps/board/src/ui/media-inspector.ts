/**
 * The media inspector — where a reference stops being a picture and becomes a
 * direction.
 *
 * WHAT IT REPLACED, AND WHY IT HAD TO GROW. This started as a viewer: click a
 * tile, see it big, close it. That is not enough, because a tile is 104px and
 * every decision a reference carries — what it is, what it is called, how it
 * should be used, and WHICH FOUR SECONDS OF IT — needs the thing on screen at a
 * size you can judge. Splitting "look at it" from "say what it is" would mean
 * choosing the moment in one place and naming it in another.
 *
 * SO: media on the left at full size, the decisions on the right, and for
 * anything with a duration a trim bar underneath.
 *
 * THE TRIM IS THE PART THAT MATTERS MOST. A shot is a few seconds and a
 * recording is minutes: somebody who films one take and storyboards from it
 * means the four seconds where she turns to the window, not the take. So the
 * player is CLAMPED to the window — it starts at the in-point, stops at the
 * out-point, and loops there. What you watch is exactly what the shot gets,
 * which is the only way to know you picked the right moment without rendering
 * the video to find out.
 *
 * Plain DOM, like the rest of the chrome: it sits over the editor, owns no
 * document state, and must not join BlockSuite's render cycle.
 */
import type { MountedBoard } from '../blocksuite/editor';
import { readBlockMeta } from '../board/board-meta';
import { decodeMediaRef } from '../board/media-ref';
import { getParentToken, withToken } from '../board/parent-auth';
import {
  REF_KINDS, REF_KIND_LABEL, roleLabel, formatTime, isTimed, rolesFor, trimWindow,
  type MediaRole, type RefKind, type ShotMedia,
} from '../shot/model';
import { effectiveModel, referenceTag } from '../shot/models';
import {
  readShot, readShots, setMediaRole, tagMedia, trimMedia, type ShotView,
} from '../shot/shots';
import { findBlock } from '../shot/blocks';

/** What the inspector was opened on. A canvas block has no shot and no fields. */
interface Target {
  media: ShotMedia;
  /** The shot it belongs to, or '' for a loose canvas block. */
  shotId: string;
}

export function installMediaInspector(board: MountedBoard, container: HTMLElement): () => void {
  const el = document.createElement('div');
  el.className = 'vs-inspect';
  el.hidden = true;
  container.append(el);

  let target: Target | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  /** Stops the clamp loop when the dialog closes or the media is swapped. */
  let clampRaf = 0;
  /** Live while the dialog is open — see `watchExternalEdits`. */
  let storeSub: { unsubscribe?: () => void } | null = null;

  // ── lifecycle ─────────────────────────────────────────────────────────────

  function stopMedia(): void {
    if (clampRaf) cancelAnimationFrame(clampRaf);
    clampRaf = 0;
    el.querySelectorAll('video, audio').forEach(n => {
      const m = n as HTMLMediaElement;
      m.pause();
      m.removeAttribute('src');
      m.load();
    });
  }

  function close(): void {
    stopMedia();
    el.innerHTML = '';
    el.hidden = true;
    target = null;
    storeSub?.unsubscribe?.();
    storeSub = null;
    if (onKey) document.removeEventListener('keydown', onKey, true);
    onKey = null;
  }

  /**
   * Repaint when something OTHER than this dialog changes the reference.
   *
   * The agent can set a trim or a note while the inspector is open — "start it
   * where she turns" is a perfectly ordinary thing to say with the clip on
   * screen. Without this the bar keeps showing the old window and the player
   * keeps clamping to it, so the user watches the wrong seconds and is told
   * they are the right ones. The panel's own edits repaint directly; this
   * covers everyone else's.
   */
  function watchExternalEdits(): void {
    storeSub?.unsubscribe?.();
    storeSub = board.store.slots.blockUpdated.subscribe(() => {
      if (!target?.shotId) return;
      const next = current();
      if (!next) { close(); return; }   // the reference was removed under us
      target.media = next;
      paintTrim();
      syncFields(next);
    });
  }

  /**
   * Push external field changes into the inputs — but never into the one being
   * typed in, which would move the caret and lose the last few characters.
   */
  function syncFields(item: ShotMedia): void {
    const active = document.activeElement;
    const set = (f: string, v: string) => {
      const node = el.querySelector<HTMLInputElement>(`[data-f="${f}"]`);
      if (!node || node === active) return;
      if (node.value !== v) node.value = v;
    };
    set('tag', item.tag ?? '');
    set('note', item.note ?? '');
    set('refKind', item.refKind ?? '');
    set('role', item.role);
  }

  /** Re-read the shot so the panel reflects what was just written. */
  function current(): ShotMedia | null {
    if (!target) return null;
    if (!target.shotId) return target.media;
    const shot = readShot(board.std, target.shotId);
    return shot?.media.find(m => m.id === target!.media.id) ?? null;
  }

  function commit(patch: Parameters<typeof tagMedia>[3]): void {
    if (!target?.shotId) return;
    tagMedia(board.std, target.shotId, target.media.id, patch);
    const next = current();
    if (next) target.media = next;
  }

  function commitTrim(patch: Parameters<typeof trimMedia>[3]): void {
    if (!target?.shotId) return;
    trimMedia(board.std, target.shotId, target.media.id, patch);
    const next = current();
    if (next) target.media = next;
    paintTrim();
  }

  // ── the trim bar ──────────────────────────────────────────────────────────

  function mediaEl(): HTMLMediaElement | null {
    return el.querySelector<HTMLMediaElement>('video, audio');
  }

  /**
   * Keep the playhead inside the window.
   *
   * A rAF loop rather than `timeupdate`, which fires roughly 4×/second — a
   * quarter of a second of the wrong footage is plainly visible and, on a
   * two-second reference, is most of it.
   */
  function clampLoop(): void {
    const m = mediaEl();
    const item = current();
    if (!m || !item) return;
    const { start, end } = trimWindow(item);
    if (m.currentTime < start - 0.05 || m.currentTime > end) {
      m.currentTime = start;
      // LOOP rather than stop: the point of the window is to judge a moment,
      // and judging it means seeing it more than once.
      if (m.paused) void m.play().catch(() => {});
    }
    clampRaf = requestAnimationFrame(clampLoop);
  }

  function paintTrim(): void {
    const item = current();
    const bar = el.querySelector<HTMLElement>('[data-trim]');
    if (!item || !bar) return;
    const dur = item.durationSec ?? 0;
    const { start, end, trimmed } = trimWindow(item);
    const pct = (v: number) => (dur > 0 ? Math.max(0, Math.min(100, (v / dur) * 100)) : 0);

    const region = bar.querySelector<HTMLElement>('.vs-trim__region');
    if (region) {
      region.style.left = `${pct(start)}%`;
      region.style.width = `${Math.max(0.5, pct(end) - pct(start))}%`;
    }
    bar.querySelector<HTMLElement>('[data-handle="in"]')!.style.left = `${pct(start)}%`;
    bar.querySelector<HTMLElement>('[data-handle="out"]')!.style.left = `${pct(end)}%`;

    const read = el.querySelector<HTMLElement>('[data-trim-read]');
    if (read) {
      read.textContent = trimmed
        ? `${formatTime(start)} → ${formatTime(end)}  ·  ${(end - start).toFixed(1)}s of ${formatTime(dur)}`
        : `whole clip · ${formatTime(dur)}`;
    }
    el.querySelector<HTMLElement>('[data-trim-clear]')!.hidden = !trimmed;
  }

  /** Drag a handle. Pointer capture, so a fast drag outside the bar keeps it. */
  function startHandleDrag(e: PointerEvent, which: 'in' | 'out'): void {
    const bar = el.querySelector<HTMLElement>('[data-trim]');
    const item = current();
    if (!bar || !item?.durationSec) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);

    const rect = bar.getBoundingClientRect();
    const dur = item.durationSec;
    const at = (clientX: number) =>
      Math.max(0, Math.min(dur, ((clientX - rect.left) / rect.width) * dur));

    const move = (ev: PointerEvent) => {
      const t = at(ev.clientX);
      // Written on every move, not just on release: the player is clamped to
      // the window, so dragging the in-point SCRUBS — you hear and see where
      // you are landing, which is the whole reason to do this here rather than
      // by typing numbers.
      commitTrim(which === 'in' ? { inSec: t } : { outSec: t });
      const m = mediaEl();
      if (m) m.currentTime = which === 'in' ? t : Math.max(0, t - 0.4);
    };
    const up = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  /**
   * WORDED FOR WHAT YOU ARE LOOKING AT.
   *
   * Every field used to carry the same sound-effect example — "use this sting
   * under the intro, right as she says hello everybody" — while the user was
   * staring at a photograph. A hint that describes a different kind of asset
   * is worse than none: it reads as though the panel does not know what it has
   * open, and it teaches the wrong thing about what the field is for.
   */
  const HINTS: Record<ShotMedia['kind'], { tag: string; note: string }> = {
    image: {
      tag: 'sarah, the-kitchen, hero-mug',
      note: 'e.g. match this grade, not the colours — and keep her jacket',
    },
    video: {
      tag: 'the-turn, b-roll-street, take-04',
      note: 'e.g. copy this push-in, but slower — the part where she turns',
    },
    audio: {
      tag: 'intro-sting, main-theme, room-tone',
      note: 'e.g. use this sting under the intro, right as she says “hello everybody”',
    },
  };

  function fieldsMarkup(item: ShotMedia, shot: ShotView | null): string {
    /**
     * ONLY THE ROLES THIS THING CAN ACTUALLY HAVE.
     *
     * The list used to be every non-audio role for anything that was not audio,
     * so a video offered "first frame" and "last frame" — which no model reads
     * from a clip — and a still offered "motion reference", which is a camera
     * move copied from footage and means nothing on a photograph. Both are
     * choices the user can make and then wonder why nothing happened.
     *
     * A graphic gets a different vocabulary again: its media fill the block's
     * holes (background, figure, inset, logo, texture), and none of the
     * generation roles apply. `rolesFor` owns all of that — see shot/model.ts.
     */
    // THE BLOCK DECIDES for a graphic — see `rolesFor`. Tagging a reference as
    // `screenshot` is what fills browser-mockup's screenshot well, so the list
    // here and the wells on the card are the same list by construction.
    const roles = rolesFor(
      shot?.kind ?? 'clip',
      item.kind,
      findBlock(shot?.composition ?? '')?.slots,
    );
    const esc = (s: string) => s.replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

    // A graphic has no model, so it has no @-tags either — the block reads its
    // media by ROLE, not by a name in a prompt.
    const caps = shot && shot.kind !== 'hyperframes' ? effectiveModel(shot.model) : null;
    const promptTag = referenceTag(caps, shot?.media ?? [], item.id);

    return `
      <label class="vs-inspect__field">
        <span>WHAT IT IS FOR</span>
        <select data-f="role">
          ${roles.map(r => `<option value="${r}"${r === item.role ? ' selected' : ''}>${roleLabel(r)}</option>`).join('')}
        </select>
      </label>

      <label class="vs-inspect__field">
        <span>NAME${promptTag ? ` <em>the prompt calls this ${promptTag}</em>` : ''}</span>
        <input data-f="tag" type="text" placeholder="${esc(HINTS[item.kind].tag)}"
               value="${esc(item.tag ?? '')}" />
      </label>

      <label class="vs-inspect__field">
        <span>WHAT IT IS OF</span>
        <select data-f="refKind">
          <option value=""${item.refKind ? '' : ' selected'}>—</option>
          ${REF_KINDS.map(k => `<option value="${k}"${k === item.refKind ? ' selected' : ''}>${REF_KIND_LABEL[k]}</option>`).join('')}
        </select>
      </label>

      <label class="vs-inspect__field vs-inspect__field--grow">
        <span>HOW TO USE IT</span>
        <textarea data-f="note" rows="4"
          placeholder="${esc(HINTS[item.kind].note)}"
        >${esc(item.note ?? '')}</textarea>
      </label>`;
  }

  function trimMarkup(item: ShotMedia): string {
    if (!isTimed(item.kind)) return '';
    return `
      <div class="vs-trim">
        <div class="vs-trim__head">
          <span>THE PART THAT IS THE REFERENCE</span>
          <span data-trim-read class="vs-trim__read"></span>
          <button type="button" data-trim-clear class="vs-trim__clear" hidden>Use whole clip</button>
        </div>
        <div class="vs-trim__bar" data-trim>
          <div class="vs-trim__region"></div>
          <button type="button" class="vs-trim__handle" data-handle="in" aria-label="Start"></button>
          <button type="button" class="vs-trim__handle" data-handle="out" aria-label="End"></button>
        </div>
        <div class="vs-trim__hint">
          Drag the handles — playback stays inside them, so what you see is what the shot gets.
        </div>
      </div>`;
  }

  async function open(t: Target): Promise<void> {
    target = t;
    // A fresh token per open: a board left open for an hour has a stale one, and
    // an element `src` cannot carry an Authorization header.
    await getParentToken().catch(() => null);
    const item = t.media;

    /**
     * FULL QUALITY FOR STILLS. The tile draws the display variant because a
     * 104px tile does not need more; this is where the picture is JUDGED, and a
     * 320px thumbnail stretched across a dialog is exactly the "why is it not
     * opening full" complaint. Video still plays the proxy — that is what
     * proxies are for.
     */
    // Read ONCE and pass it down: the fields need the shot's kind (a graphic
    // has different roles and no model) and its media list (for @-tag numbering).
    const shot = t.shotId ? readShot(board.std, t.shotId) : null;

    const src = withToken(item.kind === 'image' ? (item.url || item.src) : item.src);
    const body = item.kind === 'image'
      ? `<img src="${src}" alt="" />`
      : item.kind === 'video'
        ? `<video src="${src}" controls autoplay playsinline preload="metadata"></video>`
        : `<audio src="${src}" controls autoplay preload="metadata"></audio>`;

    el.innerHTML = `
      <div class="vs-inspect__scrim" data-close></div>
      <div class="vs-inspect__box" role="dialog" aria-label="${item.name}">
        <header>
          <span class="vs-inspect__name">${item.name}</span>
          <button type="button" data-close aria-label="Close">✕</button>
        </header>
        <div class="vs-inspect__body">
          <div class="vs-inspect__main">
            <div class="vs-inspect__stage">${body}</div>
            ${trimMarkup(item)}
          </div>
          ${shot ? `<aside class="vs-inspect__side">${fieldsMarkup(item, shot)}</aside>` : ''}
        </div>
      </div>`;
    el.hidden = false;

    // SAY SO when it cannot play. A dead library link is common enough that
    // silence reads as a broken player rather than a missing file.
    el.querySelector<HTMLElement>('video, audio, img')?.addEventListener('error', () => {
      const stage = el.querySelector('.vs-inspect__stage');
      if (stage) {
        stage.innerHTML =
          '<p class="vs-inspect__fail">This file is missing from your library, so it can’t play.</p>';
      }
    }, { once: true });

    const m = mediaEl();
    if (m) {
      m.addEventListener('loadedmetadata', () => {
        // The only place that knows how long the media is. Recorded so the trim
        // bar has a scale and so the agent can reason about the clip's length
        // without opening it.
        if (Number.isFinite(m.duration) && m.duration > 0) {
          commitTrim({ durationSec: m.duration });
          const { start } = trimWindow(current() ?? item);
          m.currentTime = start;
        }
        paintTrim();
        if (!clampRaf) clampRaf = requestAnimationFrame(clampLoop);
      }, { once: true });
    }
    paintTrim();

    watchExternalEdits();

    onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Not while typing in a field — Escape there means "stop editing this".
      const a = document.activeElement as HTMLElement | null;
      if (a && el.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) {
        a.blur();
        return;
      }
      close();
    };
    document.addEventListener('keydown', onKey, true);
  }

  // ── input ─────────────────────────────────────────────────────────────────

  el.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-close]')) { close(); return; }
    if (t.closest('[data-trim-clear]')) { commitTrim({ inSec: null, outSec: null }); return; }
  });

  el.addEventListener('pointerdown', e => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-handle]');
    if (handle) startHandleDrag(e as PointerEvent, handle.dataset.handle as 'in' | 'out');
  });

  /** Commit on `change`/blur, not on every keystroke — one undo step per edit. */
  el.addEventListener('change', e => {
    const f = (e.target as HTMLElement).dataset?.f;
    const value = (e.target as HTMLInputElement).value;
    if (f === 'tag') commit({ tag: value });
    else if (f === 'note') commit({ note: value });
    else if (f === 'refKind') commit({ refKind: (value || undefined) as RefKind | undefined });
    else if (f === 'role' && target?.shotId) {
      setMediaRole(board.std, target.shotId, target.media.id, value as MediaRole);
      const next = current();
      if (next) target.media = next;
    }
  });

  // ── ways in ───────────────────────────────────────────────────────────────

  /**
   * A shot tile, clicked. The event CARRIES the media, so there is no hit test.
   * The shot id comes from the element it bubbled through — a reference only
   * exists inside a shot, and that is how it is addressed for writing.
   */
  const onOpenMedia = (e: Event) => {
    const media = (e as CustomEvent<ShotMedia>).detail;
    if (!media?.id) return;
    const host = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-block-id]');
    const shotId = host?.dataset.blockId ?? '';
    void open({ media, shotId: readShot(board.std, shotId) ? shotId : '' });
  };
  container.addEventListener('voidspace-open-media', onOpenMedia);

  /**
   * A loose canvas block, double-clicked. No shot, so no fields — it is
   * thinking space, and nothing on it is compiled.
   *
   * DOUBLE-click here and SINGLE on a tile, deliberately: on the canvas a single
   * click selects, which is how every canvas works and what dragging depends on.
   */
  const onDblClick = (e: MouseEvent) => {
    const host = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-block-id]');
    const id = host?.dataset.blockId ?? '';
    if (!id) return;
    const meta = readBlockMeta(board.doc, id);
    if (!meta?.kind) return;
    const props = board.store.getBlock(id)?.model.props as { sourceId?: string } | undefined;
    const ref = props?.sourceId ? decodeMediaRef(props.sourceId) : null;
    const src = ref?.src ?? meta.originalUrl;
    if (!src) return;
    e.preventDefault();
    e.stopPropagation();
    void open({
      shotId: '',
      media: {
        id, kind: meta.kind, role: 'reference',
        src, url: meta.originalUrl || src, name: meta.name || meta.kind,
      },
    });
  };
  container.addEventListener('dblclick', onDblClick, true);

  return () => {
    container.removeEventListener('voidspace-open-media', onOpenMedia);
    container.removeEventListener('dblclick', onDblClick, true);
    close();
    el.remove();
  };
}

/**
 * EVERYTHING ON THIS BOARD — the source for the panel's "In this board" scope.
 *
 * BOTH PLACES MEDIA CAN LIVE, and missing one is what made this scope lie:
 *
 *   • attached to a SHOT, as a reference;
 *   • sitting on the OPEN CANVAS, as thinking space.
 *
 * Reading only the shots meant an image the user had just dropped on the canvas
 * was absent from the tab that claims to list what is on the board. It is on
 * the board — they can see it — so the tab was simply wrong.
 *
 * Canvas items carry no shot, which is also the honest signal for "not in a
 * scene yet": that is exactly the media worth being able to find and drag into
 * one.
 */
export function boardMedia(
  board: MountedBoard,
): Array<ShotMedia & { shotId: string; shotTitle: string }> {
  const fromShots = readShots(board.std).flatMap(s =>
    s.media.map(m => ({ ...m, shotId: s.id, shotTitle: s.title })));

  const fromCanvas: Array<ShotMedia & { shotId: string; shotTitle: string }> = [];
  for (const flavour of ['affine:image', 'affine:attachment']) {
    for (const block of board.store.getBlocksByFlavour(flavour)) {
      const meta = readBlockMeta(board.doc, block.id);
      const props = block.model.props as { sourceId?: string };
      const ref = props?.sourceId ? decodeMediaRef(props.sourceId) : null;
      const src = ref?.src ?? meta?.originalUrl;
      const kind = meta?.kind ?? ref?.kind;
      if (!src || !kind) continue;
      fromCanvas.push({
        id: block.id,
        kind,
        role: 'reference',
        src,
        url: meta?.originalUrl || src,
        poster: ref?.poster,
        name: meta?.name || `canvas ${kind}`,
        mediaId: meta?.mediaId,
        scope: meta?.scope,
        shotId: '',
        shotTitle: 'on the canvas',
      });
    }
  }
  return [...fromShots, ...fromCanvas];
}
