/**
 * The image editor is never used without its agent.
 *
 * The editor is served at `/image/`, but the product surface is `/ai/image`
 * — a Nuxt page that puts this editor on the left and the Voidspace agent on the
 * right, exactly as `/ai` hosts the video editor.
 *
 * It deliberately does NOT live under `/studio/`: that namespace belongs to the
 * video editor's static SPA, and `server/middleware/studio-spa-fallback.ts` serves
 * that SPA for ANY unrecognised path beneath it — so a Nuxt page there silently
 * renders the video editor instead.
 *
 * Loading `/image/` directly gets you a working editor with no assistant, which
 * looks like the feature is simply broken.
 *
 * The video editor relies purely on every link pointing at `/ai`. That is not
 * enough in practice: a bookmark, an old tab, a pasted URL, a link in a message
 * from last week, or any entry point someone forgets to update all land on the
 * bare editor, and nothing announces that the agent is missing. So this surface
 * ENFORCES it instead of relying on convention — one redirect covers every path
 * in, including the ones that do not exist yet.
 *
 * Runs before React mounts, so there is no flash of the un-hosted editor and no
 * project load that is about to be thrown away.
 *
 * NOT redirected:
 *   • Inside an iframe — that IS the hosted case. This is the check that keeps
 *     the redirect from looping: /ai/image embeds /image/, so the embedded
 *     copy must load normally.
 *   • `?standalone=1` — deliberate escape hatch for debugging the editor on its
 *     own, and for anyone who genuinely wants the bare app.
 */

/** Where the agent-hosted editor lives. */
const AGENT_HOST_PATH = '/ai/image';

export function redirectToAgentHost(): boolean {
  try {
    // Embedded → this is the hosted case; carry on and let the RPC bridge take over.
    // `window.top` access can throw on a cross-origin ancestor; a throw means we
    // are definitely framed, so the catch below also declines to redirect.
    if (window.top !== window.self) return false;

    const url = new URL(window.location.href);

    // Only ever act on the editor's own path — never hijack anything else that
    // might load this bundle.
    if (!/^\/image(\/|\/index\.html)?$/.test(url.pathname)) return false;

    if (url.searchParams.get('standalone') === '1') return false;

    // Forward the whole query verbatim: ?project=, ?carousel=, ?src=&from=,
    // ?returnTo= — the host page reads the ones it knows and the editor iframe
    // receives them again. Dropping them here would silently lose the very
    // project the user clicked on.
    const target = `${AGENT_HOST_PATH}${url.search}${url.hash}`;

    // `replace`, not `assign`: the bare editor must not sit in history, or Back
    // from the hosted page lands on it again and bounces straight forward.
    window.location.replace(target);
    return true;
  } catch {
    // Cross-origin ancestor (framed by something we cannot inspect) — treat as
    // embedded and load normally rather than risking a redirect loop.
    return false;
  }
}
