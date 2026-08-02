/**
 * Voidspace auth, seen from inside the iframe.
 *
 * Firebase lives in the PARENT page, so the board cannot mint a token; it asks
 * and the parent answers (`voidspace:board-get-token`). Everything else about the
 * library goes straight from here to the Voidspace API — the parent is never in
 * the data path.
 *
 * THREE THINGS HERE ARE LOAD-BEARING, and each was a real bug:
 *
 *  1. A STARTUP RACE IS NOT A SIGNED-OUT USER. The board mounts and asks for a
 *     token before the parent has finished registering its handler, so the first
 *     ask can time out. The old code treated that as "no auth", sent no header,
 *     and rendered the resulting 401 as a permanent failure — a working library
 *     looking broken because of an ordering artefact. Asking is now retried on a
 *     backoff, and the parent also PUSHES a token as soon as the iframe loads, so
 *     in practice the first consumer already has one.
 *
 *  2. THERE MUST BE A SYNCHRONOUS TOKEN. `<video src>` and `<audio src>` cannot
 *     send an Authorization header, so authenticated media takes `?t=<token>` —
 *     and a Lit render function cannot await. `cachedToken()` is what makes a
 *     player renderable in one pass.
 *
 *  3. TOKENS EXPIRE IN ABOUT AN HOUR. A board is left open far longer than that.
 *     A background refresh keeps the cached token young enough that a URL built
 *     from it is always still valid when the element gets round to loading it.
 */

/** Re-ask well before Firebase's ~1 h expiry, so a built URL is never stale. */
const REFRESH_MS = 20 * 60_000;
/**
 * One ask's budget.
 *
 * The parent is a Vue component in the same browser answering a postMessage: it
 * replies in single-digit milliseconds or it is not going to reply at all. An
 * earlier 2.5 s budget meant a board with no parent (served standalone, or a
 * signed-out visitor) spent TEN SECONDS on the boot screen waiting for four
 * timeouts that were never going to resolve.
 */
const ASK_TIMEOUT_MS = 800;
/**
 * Backoff for the startup race.
 *
 * The window being covered is "the iframe mounted before the page registered its
 * handler", which is milliseconds wide — the bridge subscribes during `setup()`.
 * These steps exist for a slow first paint, not for a missing parent.
 */
const RETRY_DELAYS_MS = [0, 300, 900, 2_000];

/**
 * How long "the parent has no token for us" stays believed.
 *
 * Without this every consumer pays the full startup backoff of its own: the boot
 * sequence asked once (4.6 s), then the cloud pull asked again (another 4.6 s),
 * and a signed-out board took NINE SECONDS to open. If the parent said nothing
 * for four and a half seconds, it will say nothing to the caller ten
 * milliseconds later either. A pushed token clears this immediately, so a real
 * sign-in is never delayed by it.
 */
const NO_TOKEN_TTL = 30_000;

let token: string | null = null;
let fetchedAt = 0;
let deniedAt = 0;
let inflight: Promise<string | null> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The last token we were given, or null.
 *
 * Synchronous on purpose — see (2) above. Callers that can await should prefer
 * `getParentToken()`, which will go and get one.
 */
export function cachedToken(): string | null {
  return token;
}

/**
 * Hosts a token may be sent to.
 *
 * The board's own origin (it is served from the website) and Voidspace's own
 * domains. Everything else — a picture pasted from the web, a third-party CDN
 * url that reached the Library — is somebody else's server.
 */
function isOurs(url: string): boolean {
  try {
    const { host } = new URL(url, location.href);
    if (host === location.host) return true;
    return /(^|\.)voidspace\.(ai|app|work)$/i.test(host);
  } catch {
    // A relative url that failed to parse against our own origin is not
    // something to guess about.
    return false;
  }
}

/**
 * Append `?t=` when we have a token AND the URL is one of ours.
 *
 * THE HOST CHECK IS NOT OPTIONAL. A `?t=` query is a bearer credential written
 * into a URL, and a URL is logged by every server it reaches. Without this, a
 * board holding one externally-hosted picture — perfectly ordinary, a link
 * pasted onto the canvas or a legacy row whose url points at a third-party CDN —
 * hands the user's Firebase ID token to that host's access log the moment the
 * tile paints. This function has always claimed to check; it did not.
 *
 * An external url is still returned UNCHANGED rather than blocked: it does not
 * need the token, and it loads perfectly well without one.
 */
export function withToken(url: string): string {
  if (!token) return url;
  if (/^(blob:|data:)/i.test(url)) return url;
  if (/[?&]t=/.test(url)) return url;
  if (!isOurs(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
}

function askOnce(): Promise<string | null> {
  return new Promise(resolve => {
    const id = `tok_${Math.random().toString(36).slice(2, 10)}`;
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      resolve(value);
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; requestId?: string; token?: string } | null;
      if (d?.requestId !== id) return;
      // NOT OUR OWN ASK. The request carries the same `requestId`, and when the
      // board runs top-level (`vite preview`, a headless probe) `window.parent`
      // IS this window — so the ask comes straight back through this listener
      // and resolves it with an undefined token. Every request then "failed"
      // instantly and auth looked permanently broken outside the Nuxt page.
      if (d.type === 'voidspace:board-get-token') return;
      finish(typeof d.token === 'string' && d.token ? d.token : null);
    };
    window.addEventListener('message', onMsg);
    window.parent?.postMessage({ type: 'voidspace:board-get-token', requestId: id }, '*');
    setTimeout(() => finish(null), ASK_TIMEOUT_MS);
  });
}

/**
 * A token, asking the parent if the cached one is old or missing.
 *
 * Concurrent callers share one ask: on a cold board the asset panel, the blob
 * source and the drop path all want a token in the same tick, and three parallel
 * conversations with the parent would be three chances to hit the race in (1).
 */
export function getParentToken(force = false): Promise<string | null> {
  if (!force && token && Date.now() - fetchedAt < REFRESH_MS) return Promise.resolve(token);
  // Recently asked and got nothing — see NO_TOKEN_TTL.
  if (!force && !token && Date.now() - deniedAt < NO_TOKEN_TTL) return Promise.resolve(null);
  if (inflight) return inflight;

  inflight = (async () => {
    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      const got = await askOnce();
      if (got) {
        token = got;
        fetchedAt = Date.now();
        deniedAt = 0;
        return got;
      }
    }
    deniedAt = Date.now();
    // Genuinely signed out, or the parent is not a Voidspace page. Keep any
    // token we already had: an expired one still beats none for a public URL,
    // and the sources degrade to an honest failure rather than a blank grid.
    return token;
  })().finally(() => { inflight = null; });

  return inflight;
}

/**
 * Start listening for pushed tokens and keep the cached one fresh.
 *
 * The push is what closes the startup race in practice: `pages/ai/board.vue`
 * sends one the moment the iframe fires `load`, which is before any block has
 * asked for a blob.
 */
export function installParentAuth(): () => void {
  const onMsg = (e: MessageEvent) => {
    const d = e.data as { type?: string; token?: string } | null;
    if (d?.type !== 'voidspace:board-token') return;
    if (typeof d.token === 'string' && d.token) {
      token = d.token;
      fetchedAt = Date.now();
      // A real sign-in must not be held back by a stale "no token" answer.
      deniedAt = 0;
    }
  };
  window.addEventListener('message', onMsg);

  void getParentToken();
  timer = setInterval(() => { void getParentToken(true); }, REFRESH_MS);

  return () => {
    window.removeEventListener('message', onMsg);
    if (timer) clearInterval(timer);
    timer = null;
  };
}

/** Test seam — lets a headless probe run the media paths without a parent. */
export function __setToken(value: string | null): void {
  token = value;
  fetchedAt = value ? Date.now() : 0;
  deniedAt = 0;
}
