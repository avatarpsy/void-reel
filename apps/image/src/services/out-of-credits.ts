/**
 * Out of credits → the HOST's upgrade sheet, not one of our own.
 *
 * Embedded in voidspace.ai (/ai/image), this editor hands the moment to the
 * parent page, which shows the one "out of credits / needs a higher plan"
 * sheet every Voidspace editor shares (website: components/app/CreditsSheet,
 * listening for `voidspace:out-of-credits`). Three homegrown popups here had
 * drifted from it in copy and in where they sent people.
 *
 * Returns false when there is no host to ask (the editor opened on its own),
 * so the caller falls back to its local popup.
 */
export function askHostForCredits(detail: {
  reason?: 'out' | 'plan';
  needed?: number;
  balance?: number;
}): boolean {
  try {
    if (typeof window === 'undefined' || !window.parent || window.parent === window) return false;
    window.parent.postMessage(
      {
        type: 'voidspace:out-of-credits',
        reason: detail.reason ?? 'out',
        needed: detail.needed,
        balance: detail.balance,
      },
      '*',
    );
    return true;
  } catch {
    return false;
  }
}
