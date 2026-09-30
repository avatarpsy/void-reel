/**
 * Out of credits → the HOST's upgrade sheet, not one of our own.
 *
 * Embedded in voidspace.ai (/ai), this editor hands the moment to the
 * parent page, which shows the one "out of credits / needs a higher plan"
 * sheet every Voidspace editor shares (website: components/app/CreditsSheet,
 * listening for `voidspace:out-of-credits`). The AI audio, voiceover and
 * caption tools used to end a refused spend as a bare error toast.
 *
 * Returns false when there is no host to ask (the editor opened on its own),
 * so the caller falls back to its own error message.
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

/**
 * For a failed Voidspace call: when it was OUR ledger refusing the spend (402,
 * "need N, have M"), hand it to the host's sheet. A 402 about cloud storage is
 * a different problem and is left to the caller's own message.
 */
export function reportIfOutOfCredits(status: number, message: string): boolean {
  if (status !== 402 || /storage|space/i.test(message)) return false;
  const sig = message.match(/need\s+([\d.]+)[^\d]*have\s+([\d.]+)/i);
  return askHostForCredits({
    needed: sig ? Number(sig[1]) : undefined,
    balance: sig ? Number(sig[2]) : undefined,
  });
}
