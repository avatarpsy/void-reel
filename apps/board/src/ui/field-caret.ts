/**
 * Putting a caret in a field that lives on the canvas — and then LEAVING THE
 * BROWSER ALONE.
 *
 * Extracted from the shot panel so the screenplay panel does not have to
 * rediscover any of it. Everything below was found by watching clicks fail, and
 * a second copy would drift from this one the first time either was touched.
 *
 * ── WHY A CLICK IS NOT ENOUGH ON ITS OWN ─────────────────────────────────────
 * Two separate things stop a click putting a caret in a contenteditable inside
 * an edgeless block, and BOTH have to be handled or the card looks editable and
 * silently swallows every keystroke:
 *
 *  1. The edgeless root `preventDefault()`s pointerdown to run its own
 *     selection, which also cancels the browser's default for a click on a
 *     contenteditable — focus it, and place the caret where you clicked.
 *
 *  2. Worse, the same gesture SELECTS the block as a canvas object, and
 *     `range-binding.ts:293` responds to any non-text selection by calling
 *     `host.focus()` — explicitly to stop a stray top-level contenteditable
 *     holding focus. Correct for a document, exactly wrong for a block with its
 *     own fields, and it fires a frame later, so focusing during pointerdown is
 *     undone before the user can type.
 *
 * `std.selection.clear()` AND NOT `gfx.selection.clear()`. They sound alike and
 * are opposites here: the gfx one calls `set({ elements: [] })`, leaving an
 * EMPTY `SurfaceSelection` in place — still a non-text selection, still
 * `recoverable: false`, so it satisfies the guard's `selections.length > 0` and
 * re-triggers the steal every tick. Measured: eighteen steal/refocus cycles from
 * one click. The std-level clear removes them outright and the caret stays put.
 *
 * ── THE PART THAT WAS WRONG FOR MONTHS, AND WHAT IT COST ─────────────────────
 * The first version placed a COLLAPSED caret on pointerdown and then did it
 * again inside `requestAnimationFrame` "once the gesture settles". That second
 * call is the bug people reported as "I can't select text in a shot":
 *
 *   • DRAG-SELECT — press, drag across three words. The rAF fires ~16 ms in,
 *     while the finger is still down, and collapses the range back to a caret.
 *     The selection restarts from there every frame it survives.
 *   • DOUBLE-CLICK A WORD — the second pointerdown re-enters this function and
 *     collapses the word the browser had just selected. Word-select never
 *     worked, anywhere on a shot card.
 *   • TRIPLE-CLICK A LINE — same, one click later.
 *
 * The lesson is the shape of the fix: the browser's own selection logic is
 * correct and irreplaceable, so this must only run when the field is NOT already
 * focused (i.e. the first click of a gesture), and the guard that defeats the
 * focus steal must never touch the DOM selection.
 */
import type { BlockStdScope } from '@blocksuite/std';

/** How long to keep watching for the steal. Two or three frames is enough in
 *  practice; this is generous and still ends long before a user notices. */
const GUARD_MS = 400;

/**
 * THE SELECTION TYPES THAT PROVOKE THE STEAL — and deliberately NOT `text`.
 *
 * `std.selection.clear()` with no argument clears EVERY type, including `text`,
 * which BlockSuite mirrors onto the DOM. Clearing what we did not mean to clear
 * is never right, so the two entry points name their types.
 */
const CANVAS_SELECTION_TYPES = ['surface', 'block'] as const;

/**
 * ── THE ACTUAL CAUSE, FOUND IN A BROWSER ─────────────────────────────────────
 *
 * `RangeBinding._onNativeSelectionChanged` (`@blocksuite/std/src/inline/range/
 * range-binding.ts`) runs on every `selectionchange` inside the editor host. If
 * the range's endpoints are not inside one of ITS inline editors — a `v-text`
 * element — it concludes the selection is invalid and calls
 * `selection.removeRange(range)`. Verbatim, line 229:
 *
 *     if (!startElement?.closest('v-text') && !endElement?.closest('v-text')) {
 *       this.selectionManager.clear(['text']);
 *       selection.removeRange(range);
 *
 * A shot's fields are plain `contenteditable` divs on a custom gfx block, not
 * BlockSuite rich text — so every selection made in one was destroyed on the
 * next frame. Measured: `rangeCount` 1 → 0, focus still in the field, the text
 * node untouched, and NOTHING in our own code called a Selection method. That is
 * why the two earlier attempts at this bug both failed: the caret-replacing rAF
 * and the over-broad `clear()` were real faults, but neither was THIS one, and
 * fixing them changed nothing a user would notice.
 *
 * ── THE FIX IS THEIRS, NOT A WORKAROUND ──────────────────────────────────────
 * `RANGE_SYNC_EXCLUDE_ATTR` — `data-range-sync-exclude="true"` — exists for
 * exactly this case; `active.ts` documents it as "the input or textarea in the
 * widget should be ignored". It is checked in two places that both matter:
 *
 *   • `_onNativeSelectionChanged` returns early, so the range survives;
 *   • `isActiveInEditor()` returns false, so the handler bails before it can
 *     reach the `host.focus({ preventScroll: true })` steal at line 293 — the
 *     very thing `holdFocus` below was written to fight.
 *
 * Applying it at the field is therefore both halves of the fix, from the API
 * BlockSuite provides. The guard is kept as a belt-and-braces for the first
 * frame, before the attribute has been read.
 */
export const RANGE_SYNC_EXCLUDE = 'data-range-sync-exclude';

/**
 * The selection, if it is entirely inside this field.
 *
 * Cloned so it survives the frame. A range that straddles the field's boundary
 * is not ours to restore — putting it back would move the caret somewhere the
 * user never clicked.
 */
function rangeInside(el: HTMLElement): Range | null {
  const sel = el.ownerDocument.defaultView?.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return el.contains(range.startContainer) && el.contains(range.endContainer)
    ? range.cloneRange()
    : null;
}

/**
 * Caret at the click, not at the start — landing at position 0 of text the user
 * clicked the END of is its own small betrayal.
 *
 * RE-RESOLVED FROM THE POINT, never cloned from a Range captured earlier: a Lit
 * re-render replaces the text node inside the field, so a Range held across one
 * points at a node no longer in the document. The POINT stays valid; the nodes
 * do not.
 */
function caretFromPoint(el: HTMLElement, clientX: number, clientY: number): void {
  const doc = el.ownerDocument;
  const sel = doc.defaultView?.getSelection();
  if (!sel) return;

  const legacy = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const range = legacy.caretRangeFromPoint?.(clientX, clientY);

  // Only if it actually landed in this field — a point resolving into a sibling
  // would move the caret somewhere the user did not click.
  if (range && el.contains(range.startContainer)) {
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }

  // Fall back to the end of the text, which is where someone who clicked a
  // filled field almost always wants to be.
  caretAtEnd(el);
}

/**
 * Caret after the last character.
 *
 * INSIDE THE TEXT NODE, not `selectNodeContents(el).collapse(false)`. The latter
 * is legal and leaves the range anchored to the ELEMENT at a child-node offset,
 * which browsers render in the right place but which every other piece of code
 * then has to special-case — including the guard below, whose "is this range
 * still inside the field" check reads `startContainer`.
 */
function caretAtEnd(el: HTMLElement): void {
  const doc = el.ownerDocument;
  const sel = doc.defaultView?.getSelection();
  if (!sel) return;

  const range = doc.createRange();
  // The deepest last text node — a field is plain text, but a paste can leave
  // it holding more than one node.
  let last: Node = el;
  while (last.lastChild) last = last.lastChild;

  if (last.nodeType === Node.TEXT_NODE) {
    range.setStart(last, (last as globalThis.Text).length);
  } else {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Hold focus against BlockSuite's steal — WITHOUT touching the selection.
 *
 * This is the whole difference from the version that broke selecting. It clears
 * the canvas selection (which is what provokes the steal) every frame, and it
 * only intervenes in the DOM when focus has ACTUALLY left the field — in which
 * case the browser has already discarded the selection, so restoring the last
 * range we saw is a repair rather than an overwrite.
 *
 * While focus is ours it does nothing but remember where the selection is, so a
 * drag-select extends exactly as it would in a plain textarea.
 */
/**
 * WHAT "WHERE THE USER IS" MEANS, for the two kinds of field on a card.
 *
 * A contenteditable's caret is a DOM `Range`; an `<input>`'s is a pair of
 * integer offsets, and the Selection API says nothing useful about it —
 * `rangeInside` on an input returns null, because the range genuinely is not
 * inside it. One guard serves both by asking the element which it is.
 */
interface CaretMemory {
  read(): unknown;
  restore(mark: unknown): void;
}

function caretMemory(el: HTMLElement): CaretMemory {
  const input = el as HTMLInputElement;
  const isFormField = /^(INPUT|TEXTAREA)$/.test(el.tagName);

  if (isFormField) {
    return {
      read: () => {
        // A number input throws on selectionStart in some browsers, and returns
        // null in others. Neither is worth a broken guard.
        try { return { s: input.selectionStart, e: input.selectionEnd }; } catch { return null; }
      },
      restore: mark => {
        const m = mark as { s: number | null; e: number | null } | null;
        if (!m || m.s === null || m.e === null) return;
        try { input.setSelectionRange(m.s, m.e); } catch { /* see above */ }
      },
    };
  }

  return {
    read: () => rangeInside(el),
    restore: mark => {
      const range = mark as Range | null;
      const sel = el.ownerDocument.defaultView?.getSelection();
      if (!sel || !range || !el.contains(range.startContainer)) return;
      sel.removeAllRanges();
      sel.addRange(range);
    },
  };
}

function holdFocus(std: BlockStdScope, el: HTMLElement): void {
  const doc = el.ownerDocument;
  const started = performance.now();
  const caret = caretMemory(el);
  let lastGood: unknown = caret.read();
  let done = false;

  /**
   * A GESTURE THAT STARTS SOMEWHERE ELSE ENDS THE GUARD.
   *
   * Without this the guard spends its full budget clearing `std.selection` every
   * frame — so a user who typed into a field and immediately clicked a shape
   * watched their selection evaporate, and the board looked like it refused to
   * select anything for a quarter of a second after every edit. The guard exists
   * to survive the aftermath of ONE gesture; the next gesture elsewhere is the
   * signal that it is over.
   *
   * SCOPED BY TARGET, not by a timer. An earlier version registered this inside
   * `setTimeout(…, 0)` purely so it could not catch the pointerdown that led
   * here — which quietly assumed `setTimeout(0)` runs before the next animation
   * frame. It does not, reliably, in either direction: measured here, rAF wins.
   * So the guard could still be unarmed a frame later, and the "click away right
   * after typing" case it exists for was a coin flip.
   *
   * Asking WHERE the gesture started answers the real question and has no timing
   * in it at all: inside this field it is the same interaction continuing (and
   * `takeCaret` re-arms the guard anyway); outside it, the user has moved on.
   */
  const host = (std.host ?? null) as HTMLElement | null;

  const release = () => {
    done = true;
    window.removeEventListener('pointerdown', stop, { capture: true });
    doc.removeEventListener('focusin', onFocusIn, true);
    el.removeEventListener('keydown', onEscape);
  };

  const stop = (e: Event) => {
    if (el.contains(e.target as Node | null)) return;
    release();
  };
  window.addEventListener('pointerdown', stop, { capture: true });

  /**
   * ── THE STEAL DOES NOT STOP AFTER A QUARTER OF A SECOND ──────────────────
   *
   * Everything below the rAF tick is a 400ms budget, and that was enough for
   * the burst of selection churn a click provokes. It is not enough for a
   * PERSON. Click the length box, take your hand off the mouse to reach the
   * keyboard, and the pointer drifts across the canvas: the edgeless layer
   * updates `std.selection`, `RangeBinding._onStdSelectionChanged` runs, and
   * line 293 of range-binding calls `host.focus({ preventScroll: true })` — a
   * second steal, on a path `data-range-sync-exclude` does not guard, because
   * that attribute is only consulted for NATIVE selection changes.
   *
   * Measured, with the box focused and the pointer merely moved over empty
   * canvas: `document.activeElement` went from `INPUT.shot__durin` to
   * `EDITOR-HOST`, and every keystroke after it went to the canvas. That is the
   * whole of "I have to keep my cursor on the box, otherwise it goes out of
   * focus" — the field was fine as long as the mouse never moved.
   *
   * ── WHY ONLY THE HOST, AND WHY THAT IS SAFE ──────────────────────────────
   * Focus is taken back ONLY when it lands on the editor host itself. Nobody
   * focuses the host by hand: a real click on the canvas fires `pointerdown`
   * first, and `stop` above has already ended the guard by the time focus
   * moves. So host-as-destination means the steal and nothing else. Focus that
   * goes anywhere else — another field, a button, the browser chrome — is the
   * user leaving, and is let go.
   *
   * This lives until the user does something that means they are done with the
   * field, not until a timer expires.
   */
  function onFocusIn(e: FocusEvent): void {
    if (done) return;
    if (!el.isConnected) { release(); return; }

    const to = e.target as Node | null;
    if (to && el.contains(to)) {
      lastGood = caret.read() ?? lastGood;
      return;
    }
    // No host to compare against — we cannot tell the steal from a departure,
    // so we claim neither and let the rAF tick below do its bounded job.
    if (!host) return;
    if (to !== host) { release(); return; }

    el.focus({ preventScroll: true });
    caret.restore(lastGood);
  }
  doc.addEventListener('focusin', onFocusIn, true);

  // Escape is the deliberate way out (see stopFieldKeys) — it blurs, and the
  // guard must not undo that.
  const onEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') release(); };
  el.addEventListener('keydown', onEscape);

  const tick = () => {
    // ONLY THE TICK ENDS HERE. The focusin guard above outlives this budget on
    // purpose — see its comment — so the 400ms expiry stops polling without
    // tearing the rest down. A disconnected element is a real end for both.
    if (done || !el.isConnected) { release(); return; }
    if (performance.now() - started > GUARD_MS) return;

    // The provocation, removed. Cheap, and it is the actual fix — the steal only
    // fires while a non-text selection exists.
    // Only the canvas types — clearing 'text' here is what wiped the user's
    // own selection a frame after they made it. See CANVAS_SELECTION_TYPES.
    if (std.selection.value.some(sel => CANVAS_SELECTION_TYPES.some(t => sel.type === t))) {
      std.selection.clear([...CANVAS_SELECTION_TYPES]);
    }

    if (doc.activeElement === el) {
      // Ours. Remember where the user is, and otherwise keep hands off.
      lastGood = caret.read() ?? lastGood;
    } else {
      // Stolen. Take it back, and put the selection where it was — the browser
      // discarded it when focus moved, so there is nothing here to overwrite.
      el.focus({ preventScroll: true });
      caret.restore(lastGood);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Claim the caret for a canvas-hosted field.
 *
 * Call from `pointerdown`. Safe to call on every click of a double- or
 * triple-click: the second and third calls see the field already focused and
 * deliberately do nothing, which is what lets word- and line-select work.
 *
 * NEVER call `preventDefault()` on the event that leads here. The native default
 * for a pointerdown on a contenteditable IS caret placement and drag-select
 * initiation; cancelling it is what makes a field look editable and behave like
 * a picture.
 */
export function takeCaret(
  std: BlockStdScope,
  el: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  const doc = el.ownerDocument;

  std.selection.clear([...CANVAS_SELECTION_TYPES]);

  /**
   * ONLY THE FIRST CLICK OF A GESTURE PLACES A CARET.
   *
   * If the field already has focus the browser is mid-gesture — the second
   * click of a double-click, a drag that began here, a click inside an existing
   * selection — and its own handling is exactly right. Overwriting it is what
   * made selecting text impossible on every shot card.
   */
  if (doc.activeElement !== el) {
    el.focus({ preventScroll: true });
    caretFromPoint(el, clientX, clientY);
  }

  holdFocus(std, el);
}

/**
 * Claim a canvas-hosted `<input>` / `<textarea>` — the LENGTH box, the block
 * search, a graphic's fill fields.
 *
 * ── WHY `data-range-sync-exclude` WAS NOT ENOUGH, THOUGH IT LOOKS LIKE IT ────
 * The attribute really is BlockSuite's own answer, and it really does stop the
 * steal — in `_onNativeSelectionChanged`, which runs off `selectionchange` and
 * begins `if (!isActiveInEditor(this.host)) return;`. That was the path the
 * contenteditables were losing focus down, so applying it there fixed them and
 * looked like it fixed everything.
 *
 * There is a SECOND steal, and it is a different function with a different
 * trigger: `range-binding.ts` also reacts to the SELECTION MODEL changing, and
 * that handler does not consult `isActiveInEditor` at all —
 *
 *     if (!text && selections.length > 0) {
 *       const hasRecoverable = selections.find(s => s.constructor.recoverable);
 *       if (!hasRecoverable) this.host.focus({ preventScroll: true });
 *     }
 *
 * A shot card is SELECTED on the canvas while you work in it, and a
 * `SurfaceSelection` is not recoverable — so every focus into a form control on
 * a selected card was handed straight back to the editor host. Measured, on a
 * click into the LENGTH box: `pointerdown → focus → mousedown → click → blur`,
 * with `document.activeElement` ending as `EDITOR-HOST`. Exactly "I can't select
 * the field and edit it".
 *
 * The cure is the one `takeCaret` already uses for the same steal: remove the
 * provocation. Clear the canvas selection and keep clearing it for a few frames,
 * so `selections.length > 0` is false when the handler runs.
 *
 * NO CARET PLACEMENT, and no `preventDefault`. An input positions its own caret
 * and runs its own drag-select, and both are better than anything done for it.
 */
export function claimFormField(std: BlockStdScope, el: HTMLElement): void {
  std.selection.clear([...CANVAS_SELECTION_TYPES]);
  if (el.ownerDocument.activeElement !== el) el.focus({ preventScroll: true });
  holdFocus(std, el);
}

/**
 * Focus a field programmatically, caret at the end.
 *
 * For the ways in that are not a click — the keyboard, a "rename" affordance, an
 * agent asking the user to fill something in. Shares the focus guard, because
 * the steal does not care how focus arrived.
 */
export function focusField(std: BlockStdScope, el: HTMLElement): void {
  std.selection.clear([...CANVAS_SELECTION_TYPES]);
  el.focus({ preventScroll: true });
  caretAtEnd(el);
  holdFocus(std, el);
}

/**
 * Keep the canvas out of the way while typing.
 *
 * The editor's dispatcher listens on the host for keys — Backspace deletes the
 * selected block, space starts panning. Without this, typing in a field would
 * also drive the canvas.
 *
 * Escape blurs, which is the only reliable way off a canvas field: clicking away
 * is ambiguous (it might be the start of a drag) and Tab is claimed below.
 */
export function stopFieldKeys(e: KeyboardEvent): void {
  e.stopPropagation();
  if (e.key === 'Escape') (e.target as HTMLElement).blur();
}
