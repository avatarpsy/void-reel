/**
 * A one-line transient message over the canvas.
 *
 * EXISTS BECAUSE SILENCE IS THE WORST FAILURE MODE HERE. Dropping an asset whose
 * library link has expired used to place nothing and say nothing, which reads as
 * "adding media is broken" when the truth is "that one file is gone". The board
 * places media asynchronously — a fetch, a probe, a block — so there is always a
 * gap in which the only honest thing to do is tell the user what happened.
 *
 * Deliberately not BlockSuite's own `toast()`: theirs mounts into the editor
 * host, and our chrome is a SIBLING of the viewport on purpose (putting anything
 * of ours inside `.affine-edgeless-viewport` is what used to kill space-pan and
 * swallow clicks). This one lands on the board root and styles itself from the
 * same `--vs-*` tokens as the rest of the chrome, so it follows the theme with
 * no per-component work.
 */
const HOLD_MS = 4_200;

export type ToastKind = 'info' | 'error';

let host: HTMLElement | null = null;

export function installToasts(container: HTMLElement): () => void {
  host = document.createElement('div');
  host.className = 'vs-toasts';
  container.append(host);
  return () => {
    host?.remove();
    host = null;
  };
}

function show(message: string, kind: ToastKind): HTMLElement | null {
  if (!host || !message) return null;
  const el = document.createElement('div');
  el.className = `vs-toast vs-toast--${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host.append(el);
  // Two frames, not one: the element must be laid out before the class that
  // animates it is added, or the transition never runs and it simply appears.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-in')));
  return el;
}

function dismiss(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove('is-in');
  setTimeout(() => el.remove(), 260);
}

export function toast(message: string, kind: ToastKind = 'error'): void {
  const el = show(message, kind);
  if (el) setTimeout(() => dismiss(el), HOLD_MS);
}

/**
 * "Still working on it" — shown only if the work outlives `afterMs`.
 *
 * THIS IS THE FIX FOR DUPLICATE DROPS. Placing an asset is asynchronous, and
 * when it was slow the canvas stayed empty with no sign anything had happened —
 * so the user dropped again, and got two copies. Every attempt to solve that
 * downstream (same-gesture timers, drop-target guards) was treating the symptom:
 * the real defect was a silent gap. Nothing appears for fast placements, which
 * are now the overwhelming majority.
 */
export function pendingToast(message: string, afterMs = 700): () => void {
  let el: HTMLElement | null = null;
  const timer = setTimeout(() => { el = show(message, 'info'); }, afterMs);
  return () => {
    clearTimeout(timer);
    dismiss(el);
  };
}
