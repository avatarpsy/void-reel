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
import { stopInlinePlayback } from '../board/inline-player';
import { decodeMediaRef } from '../board/media-ref';
import { getParentToken, withToken } from '../board/parent-auth';
import {
  REF_KINDS, REF_KIND_LABEL, chosenTake, roleLabel, formatTime, isTimed, rolesFor,
  takeAsMedia, trimWindow,
  type MediaRole, type RefKind, type ShotMedia,
} from '../shot/model';
import { effectiveModel, referenceTag, slotSupport } from '../shot/models';
import {
  chooseTake, readShot, readShots, removeTake, setMediaRole, tagMedia, trimMedia,
  type ShotView,
} from '../shot/shots';
import { findBlock } from '../shot/blocks';

/** What the inspector was opened on. A canvas block has no shot and no fields. */
interface Target {
  media: ShotMedia;
  /** The shot it belongs to, or '' for a loose canvas block. */
  shotId: string;
  /**
   * THE ROW THIS CAME OUT OF — what ← and → walk.
   *
   * A shot has five takes and the question is always "which of these", never
   * "is this one good in isolation". Opening one and having to close it to see
   * the next makes a comparison into five separate acts of remembering. So the
   * viewer carries the row it was opened from and pages through it in place.
   *
   * Empty for a loose canvas block: the canvas has no row, it has a plan.
   */
  siblings?: ShotMedia[];
  /** Where in `siblings` the open item sits. */
  index?: number;
  /**
   * Set when the item is a TAKE rather than a reference.
   *
   * A take is an OUTPUT: it has no role, no tag and no trim to set — the shot
   * generated it and the only decisions are "this is the one" and "throw it
   * away". Its id also lives in a different list from `media`, so every write
   * path has to be told which one to look in.
   */
  take?: { shotId: string; takeId: string };
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
      // The agent can set a trim — or clear one — with the clip on screen, so
      // the loop has to start and stop with what it finds, not only with what
      // this dialog did.
      syncClamp();
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

  // ── paging through the row ────────────────────────────────────────────────

  /**
   * Open the sibling `step` along, wrapping at both ends.
   *
   * Wrapping rather than stopping: a row of takes is a carousel, not a list with
   * a beginning — going right off the last one to get back to the first is how
   * every other viewer of a set behaves, and a dead arrow at the end reads as a
   * broken button rather than as an edge.
   */
  function page(step: number): void {
    const row = target?.siblings;
    if (!target || !row || row.length < 2) return;
    const at = target.index ?? 0;
    const next = (at + step + row.length) % row.length;
    if (next === at) return;
    void open({
      ...target,
      media: row[next]!,
      index: next,
      ...(target.take ? { take: { shotId: target.take.shotId, takeId: row[next]!.id } } : {}),
    });
  }

  /** The chevrons over the stage. Absent for a row of one — a control that can
   *  only do nothing is worse than no control. */
  function navMarkup(): string {
    const n = target?.siblings?.length ?? 0;
    if (n < 2) return '';
    return `
      <button type="button" class="vs-inspect__page vs-inspect__page--prev"
              data-page="-1" aria-label="Previous">‹</button>
      <button type="button" class="vs-inspect__page vs-inspect__page--next"
              data-page="1" aria-label="Next">›</button>`;
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
    syncClamp();
  }

  /**
   * Remember something measured from the ELEMENT for an item with no shot.
   *
   * A canvas clip and a take both open with `shotId: ''`, so `commitTrim` has
   * nowhere to write and returns without doing anything. That is correct — there
   * is no reference to trim — but it also meant the duration read off the
   * `<video>` was thrown away, and everything downstream then reasoned about a
   * clip it believed was zero seconds long.
   */
  function rememberLocally(patch: Partial<ShotMedia>): void {
    if (!target || target.shotId) return;
    target.media = { ...target.media, ...patch };
  }

  // ── the trim bar ──────────────────────────────────────────────────────────

  function mediaEl(): HTMLMediaElement | null {
    return el.querySelector<HTMLMediaElement>('video, audio');
  }

  /**
   * Is there a WINDOW to hold playback inside?
   *
   * ── THE BUG THIS EXISTS TO PREVENT ───────────────────────────────────────
   * The clamp used to run for anything with a duration, and `trimWindow` on an
   * item whose `durationSec` is unknown returns `{ start: 0, end: 0 }` — an
   * empty window, not an absent one. So the loop found `currentTime > 0` on the
   * first frame after playback began and dragged the playhead back to zero, at
   * sixty frames a second, forever. The video was genuinely playing: decoding,
   * showing a pause button, reporting `0:00 / 0:05` and never moving.
   *
   * That is every clip on the CANVAS, because a canvas block has no shot, so
   * `commitTrim` has nowhere to record the duration it just measured.
   *
   * Both halves are fixed: the duration is remembered locally (see
   * `rememberLocally`), and the clamp only runs when there is a real window to
   * clamp to. An untrimmed clip is just a clip, and a player needs no help
   * playing one.
   */
  function clampable(): boolean {
    const item = current();
    if (!item) return false;
    const { start, end, trimmed } = trimWindow(item);
    return trimmed && end > start;
  }

  /** Start or stop the loop to match what is currently set. Called whenever the
   *  window could have changed — including by somebody other than this dialog. */
  function syncClamp(): void {
    if (clampable()) {
      if (!clampRaf) clampRaf = requestAnimationFrame(clampLoop);
      return;
    }
    if (clampRaf) cancelAnimationFrame(clampRaf);
    clampRaf = 0;
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
    // Re-checked every frame, not just at the start: the trim can be cleared
    // while the dialog is open, and a loop that kept running on the old window
    // would go on yanking the playhead to a point nobody has asked for.
    if (!m || !item || !clampable()) { clampRaf = 0; return; }
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
    const allRoles = rolesFor(
      shot?.kind ?? 'clip',
      item.kind,
      findBlock(shot?.composition ?? '')?.slots,
    );

    /**
     * AND NOT THE ONES THIS MODEL CANNOT READ.
     *
     * `rolesFor` answers "legal for this kind of shot", which is the half that
     * does not change when you swap models. The other half is the model's own:
     * offering "last frame" for a model with no end-frame input is offering a
     * choice that silently does nothing, and this dropdown is where somebody
     * goes to make exactly that choice deliberately.
     *
     * THE CURRENT ROLE IS ALWAYS KEPT, even when unsupported. A reference
     * already tagged `lastFrame` on a model that ignores it must still show what
     * it is — a select that silently re-reads as something else would rewrite
     * the user's decision on open, and `checkShot` is what explains the problem.
     *
     * `rolesFor` cannot do this itself: it lives in `model.ts`, which `models.ts`
     * imports, so taking `ModelCaps` there would be a cycle.
     */
    const caps = shot && shot.kind !== 'hyperframes' ? effectiveModel(shot.model) : null;
    const roles = allRoles.filter(r =>
      r === item.role || slotSupport(caps, r).supported);
    const esc = (s: string) => s.replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

    // The same `caps` the role list was filtered with. A graphic has no model,
    // so it has no @-tags either — the block reads its media by ROLE, not by a
    // name in a prompt.
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

  /**
   * WHERE THIS CAME FROM — shown for loose canvas media.
   *
   * A canvas item has no shot, so the inspector used to open with the picture
   * and an empty right-hand side. For a GENERATED picture that is the wrong
   * moment to say nothing: this is exactly when someone is deciding whether to
   * keep it, iterate on it, or throw it away, and the question they have is
   * "what did I ask for?" — which, nine pictures later, nobody remembers.
   *
   * Read-only on purpose. It is a record of what happened, not a form.
   */
  function provenanceMarkup(blockId: string): string {
    const meta = readBlockMeta(board.doc, blockId);
    if (!meta) return '';

    const esc = (s: string) => s.replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const rows: string[] = [];

    if (meta.prompt) {
      rows.push(`
        <label class="vs-inspect__field vs-inspect__field--grow">
          <span>WHAT IT WAS MADE FROM</span>
          <p class="vs-inspect__prov">${esc(meta.prompt)}</p>
        </label>`);
    }
    if (meta.referenceIds?.length) {
      rows.push(`
        <label class="vs-inspect__field">
          <span>REFERENCES</span>
          <p class="vs-inspect__prov">${meta.referenceIds.length} image${meta.referenceIds.length === 1 ? '' : 's'} from this board</p>
        </label>`);
    }
    if (meta.model) {
      rows.push(`
        <label class="vs-inspect__field">
          <span>MODEL</span>
          <p class="vs-inspect__prov">${esc(meta.model)}</p>
        </label>`);
    }
    if (meta.sourceUrl) {
      rows.push(`
        <label class="vs-inspect__field">
          <span>SOURCE</span>
          <p class="vs-inspect__prov"><a href="${esc(meta.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(meta.credit || meta.sourceUrl)}</a></p>
        </label>`);
    }

    if (!rows.length) return '';
    return `<aside class="vs-inspect__side">${rows.join('')}
      <p class="vs-inspect__hint">
        Ask for “the same but…” and the agent works from this, rather than guessing.
      </p>
    </aside>`;
  }

  /**
   * WHAT YOU DO WITH A TAKE — the only two things there are.
   *
   * A take is an output, so none of the reference fields apply to it: there is
   * no role to give a finished clip, no name the prompt will use, and no trim
   * (the shot's length is what the generation produced). What there is, and what
   * the whole row exists to answer, is WHICH ONE.
   *
   * Says what the tick means as well as offering it: every ready take reaches
   * the editor, and the chosen one is the one that PLAYS. That is the single
   * most misread thing on the shot card, and this is where somebody is looking
   * straight at the decision.
   */
  function takeMarkup(t: NonNullable<Target['take']>): string {
    const shot = readShot(board.std, t.shotId);
    const take = shot?.takes.find(x => x.id === t.takeId);
    const chosen = shot ? chosenTake(shot.takes, shot.chosenTakeId)?.id === t.takeId : false;
    const esc = (s: string) => s.replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

    const rows: string[] = [];
    if (shot?.title) {
      rows.push(`<label class="vs-inspect__field"><span>SHOT</span>
        <p class="vs-inspect__prov">${esc(shot.title)}</p></label>`);
    }
    if (take?.model) {
      rows.push(`<label class="vs-inspect__field"><span>MADE BY</span>
        <p class="vs-inspect__prov">${esc(take.model)}</p></label>`);
    }
    if (take?.durationSec) {
      rows.push(`<label class="vs-inspect__field"><span>LENGTH</span>
        <p class="vs-inspect__prov">${take.durationSec.toFixed(1)}s</p></label>`);
    }
    if (take?.error) {
      rows.push(`<label class="vs-inspect__field"><span>WHY IT FAILED</span>
        <p class="vs-inspect__prov">${esc(take.error)}</p></label>`);
    }

    return `<aside class="vs-inspect__side">
      ${rows.join('')}
      <div class="vs-inspect__acts">
        <button type="button" data-take-use class="vs-inspect__act vs-inspect__act--go"
                ${chosen ? 'disabled' : ''}>
          ${chosen ? '✓ This one plays' : 'Make this the one that plays'}
        </button>
        <button type="button" data-take-drop class="vs-inspect__act">Discard this take</button>
      </div>
      <p class="vs-inspect__hint">
        Every ready take goes to the editor, stacked at this moment on its own track.
        The chosen one plays; the rest sit above it, ready to cut to. Discarding only
        takes it off the shot — the file stays in your Library.
      </p>
    </aside>`;
  }

  function trimMarkup(item: ShotMedia): string {
    if (!isTimed(item.kind)) return '';
    /**
     * ONLY WHERE IT CAN BE WRITTEN.
     *
     * `trimMedia` addresses a reference inside a shot, so with no shot there is
     * nowhere for the window to go: every drag of a handle was silently
     * discarded and the bar sprang back the instant it repainted. A control that
     * cannot keep what you set it to is worse than an absent one — and takes and
     * canvas clips have no trim to set in the first place.
     */
    if (!target?.shotId || target.take) return '';
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
    // TWO THINGS PLAYING AT ONCE IS THE WORST OUTCOME. A card can be streaming
    // inline when the user double-clicks it to see it properly, and without this
    // the dialog's own player starts over the top of it — two copies of the same
    // audio, a fraction of a second apart.
    stopInlinePlayback();
    /**
     * AND NEITHER IS THE PREVIOUS ONE. Paging with ← replaces the dialog's
     * markup, which drops the old `<video>` on the floor still holding its
     * stream and its clamp loop — walk five takes and the tab is running five
     * decoders and five rAF loops, which is exactly what "the player gets
     * glitchy" feels like by the third one.
     */
    stopMedia();
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

    const row = t.siblings ?? [];
    const counter = row.length > 1
      ? `<span class="vs-inspect__count">${(t.index ?? 0) + 1} / ${row.length}</span>`
      : '';

    el.innerHTML = `
      <div class="vs-inspect__scrim" data-close></div>
      <div class="vs-inspect__box" role="dialog" aria-label="${item.name}">
        <header>
          <span class="vs-inspect__name">${item.name}</span>
          ${counter}
          <button type="button" data-close aria-label="Close">✕</button>
        </header>
        <div class="vs-inspect__body">
          <div class="vs-inspect__main">
            <div class="vs-inspect__stage">
              <div class="vs-inspect__media">${body}</div>${navMarkup()}
            </div>
            ${trimMarkup(item)}
          </div>
          ${t.take
            // A take is an output: which one plays, or throw it away.
            ? takeMarkup(t.take)
            : shot
              ? `<aside class="vs-inspect__side">${fieldsMarkup(item, shot)}</aside>`
              // No shot — this is loose canvas media. It has no role and no tag
              // to set, but it may well have a story worth reading.
              : provenanceMarkup(item.id)}
        </div>
      </div>`;
    el.hidden = false;

    /**
     * SAY SO when it cannot play. A dead library link is common enough that
     * silence reads as a broken player rather than as a missing file.
     *
     * REPLACES THE MEDIA, NOT THE STAGE. It used to write over the stage's whole
     * contents, which took the ‹ › chevrons with it — so a shot whose second
     * take had a dead link became a dead end: the message was right, and the
     * only way past it was to close the dialog and open a different tile. One
     * broken file must not strand the four that are fine.
     */
    el.querySelector<HTMLElement>('video, audio, img')?.addEventListener('error', () => {
      const media = el.querySelector('.vs-inspect__media');
      if (media) {
        media.innerHTML =
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
          // Where there is a shot, this is document state the agent can reason
          // about without opening anything.
          commitTrim({ durationSec: m.duration });
          // Where there is not — a canvas clip, a take — it still has to be
          // known HERE, or `trimWindow` reports a zero-length window and the
          // clamp treats every frame past the first as out of bounds.
          rememberLocally({ durationSec: m.duration });
          const { start } = trimWindow(current() ?? item);
          // Only when there is somewhere else to start. Assigning 0 is harmless
          // on most browsers and a needless seek on all of them.
          if (start > 0) m.currentTime = start;
        }
        paintTrim();
        syncClamp();
      }, { once: true });
    }
    paintTrim();

    watchExternalEdits();

    onKey = (e: KeyboardEvent) => {
      // NOT WHILE TYPING, for any of these. Escape in a field means "stop
      // editing this", and ← / → mean "move the caret" — stealing either one
      // would make the note box unusable while the dialog is the only place to
      // write in it.
      const a = document.activeElement as HTMLElement | null;
      const typing = !!a && el.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName);

      if (e.key === 'Escape') {
        if (typing) { a!.blur(); return; }
        close();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      // ← / → walk the row. Claimed rather than left to bubble: the board behind
      // the dialog pans on arrow keys, and a viewer that scrolls the canvas
      // underneath itself is disorienting.
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); page(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); page(1); }
    };
    document.addEventListener('keydown', onKey, true);
  }

  // ── input ─────────────────────────────────────────────────────────────────

  el.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-close]')) { close(); return; }
    if (t.closest('[data-trim-clear]')) { commitTrim({ inSec: null, outSec: null }); return; }

    const step = t.closest<HTMLElement>('[data-page]')?.dataset.page;
    if (step) { page(Number(step)); return; }

    const take = target?.take;
    if (take && t.closest('[data-take-use]')) {
      chooseTake(board.std, take.shotId, take.takeId);
      // Repaint in place rather than closing: the point of being here is to
      // compare, and picking one is rarely the last thing somebody does.
      void open({ ...target! });
      return;
    }
    if (take && t.closest('[data-take-drop]')) {
      removeTake(board.std, take.shotId, take.takeId);
      /**
       * WALK TO THE NEXT ONE, or leave if that was the last.
       *
       * Closing on every discard would make "throw away the three bad ones" into
       * three round trips through the strip. The row is rebuilt from what is
       * left, and the index stays put so the take that slid into this slot is
       * the one now on screen.
       */
      const rest = (target!.siblings ?? []).filter(m => m.id !== take.takeId);
      if (!rest.length) { close(); return; }
      const at = Math.min(target!.index ?? 0, rest.length - 1);
      void open({
        ...target!,
        media: rest[at]!,
        siblings: rest,
        index: at,
        take: { shotId: take.shotId, takeId: rest[at]!.id },
      });
      return;
    }
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
    const detail = (e as CustomEvent<OpenMediaDetail>).detail;
    const media = detail?.media ?? (detail as unknown as ShotMedia);
    if (!media?.id) return;
    const host = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-block-id]');
    const hostId = host?.dataset.blockId ?? '';
    const shotId = readShot(board.std, hostId) ? hostId : '';

    /**
     * THE ROW, WORKED OUT HERE RATHER THAN SENT.
     *
     * The card raises one event carrying the item and which row it came from,
     * and the viewer reads the row off the shot. That keeps the card ignorant of
     * the viewer (it cannot know the shape a dialog wants) and means the row is
     * whatever the DOCUMENT says right now — not a snapshot taken when the
     * template last painted, which is how a deleted take stays walkable.
     */
    const shot = shotId ? readShot(board.std, shotId) : null;
    const takes = detail?.row === 'takes' && shot
      ? shot.takes.filter(t => t.status === 'ready').map(takeAsMedia)
      : null;
    const siblings = takes ?? (shot ? shot.media : []);
    const index = Math.max(0, siblings.findIndex(m => m.id === media.id));

    void open({
      media: siblings[index] ?? media,
      shotId: takes ? '' : shotId,
      siblings,
      index,
      ...(takes && shotId ? { take: { shotId, takeId: media.id } } : {}),
    });
  };
  container.addEventListener('voidspace-open-media', onOpenMedia);

  /**
   * A CANVAS BLOCK, by id — the corner ⤢ on a clip or track card.
   *
   * Double-click already did this and still does; the button exists because a
   * gesture with nothing drawn on screen is a feature only its author knows
   * about. Both land here so there is one definition of what opening a canvas
   * block means.
   */
  const onOpenBlock = (e: Event) => {
    const id = (e as CustomEvent<{ blockId?: string }>).detail?.blockId;
    if (id) openCanvasBlock(id);
  };
  container.addEventListener('voidspace-open-block', onOpenBlock);

  /** Build the viewer's target from a loose canvas block. Null when the block is
   *  not media, or its link is gone. */
  function openCanvasBlock(id: string): boolean {
    const meta = readBlockMeta(board.doc, id);
    if (!meta?.kind) return false;
    const props = board.store.getBlock(id)?.model.props as { sourceId?: string } | undefined;
    const ref = props?.sourceId ? decodeMediaRef(props.sourceId) : null;
    const src = ref?.src ?? meta.originalUrl;
    if (!src) return false;
    void open({
      shotId: '',
      media: {
        id, kind: meta.kind, role: 'reference',
        src, url: meta.originalUrl || src, name: meta.name || meta.kind,
        ...(ref?.poster ? { poster: ref.poster } : {}),
      },
    });
    return true;
  }

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
    if (!openCanvasBlock(id)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  container.addEventListener('dblclick', onDblClick, true);

  return () => {
    container.removeEventListener('voidspace-open-media', onOpenMedia);
    container.removeEventListener('voidspace-open-block', onOpenBlock);
    container.removeEventListener('dblclick', onDblClick, true);
    close();
    el.remove();
  };
}

/**
 * What a card sends when it wants something opened.
 *
 * `row` names WHICH list the item came out of, because a shot has two and they
 * are addressed differently: a reference lives in `media` and carries a role, a
 * take lives in `takes` and carries a status. Sending the row rather than the
 * whole list keeps the message small and keeps the viewer reading live document
 * state — see `onOpenMedia`.
 */
export interface OpenMediaDetail {
  media: ShotMedia;
  row?: 'media' | 'takes';
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
