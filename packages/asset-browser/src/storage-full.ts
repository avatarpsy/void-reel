/**
 * Storage full → the HOST's sheet, the same bridge as out-of-credits.
 *
 * When the person's storage is full the server still finishes a generation but
 * keeps it on the provider's 3-day link instead of copying it, and says so with
 * the `x-voidspace-storage-full: <expiresAt>` response header (website
 * server/utils/storage-full.ts). Every editor installs this once at boot: it
 * watches its own fetches for that header and posts `voidspace:storage-full`
 * to the parent page, which opens "Your storage is full" (CreditsSheet).
 * Headers only, never the body. A no-op when the editor is not embedded.
 */
const HEADER = 'x-voidspace-storage-full';

export function installStorageFullWatch(): void {
  if (typeof window === 'undefined' || !window.parent || window.parent === window) return;
  const current = window.fetch as typeof window.fetch & { __vsStorageWatch?: boolean };
  if (current.__vsStorageWatch) return;
  const orig = current.bind(window);
  const watched = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    try {
      const expiresAt = res.headers.get(HEADER);
      if (expiresAt) window.parent.postMessage({ type: 'voidspace:storage-full', expiresAt }, '*');
    } catch { /* opaque response */ }
    return res;
  }) as typeof window.fetch & { __vsStorageWatch?: boolean };
  watched.__vsStorageWatch = true;
  window.fetch = watched;
}
