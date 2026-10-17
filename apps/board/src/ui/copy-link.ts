/**
 * "Copy link" for a document, sheet or script on the board.
 *
 * There is no per-document sharing: whoever can open the board can open the
 * link, and nobody else. So the link is the BOARD's link plus `open=<blockId>`
 * (and `tab=` for a sheet), which the board page and the shared-project page
 * both pass through to `openDeepLink` in main.ts.
 *
 *   not shared   https://voidspace.ai/ai/board?board=<id>&open=<block>
 *   shared       https://voidspace.ai/project/<id>/<slug>?open=<block>
 *                (the project link, as the Share dialog copies it — public
 *                 viewers, invited people and the owner can all open it)
 *   edit link    the same, with the edit link's `#edit=` when the board is
 *                not public and the owner turned the edit link on, so the
 *                person it is sent to can open it after signing in.
 */
import { sharedRequest } from '@openreel/asset-browser';

import { toast } from './toast';

interface ShareMetadata { url?: string; publicRead?: boolean; editUrl?: string | null; role?: string }

let share: { projectId: string; metadata: ShareMetadata | null } | null = null;

/** Set by main.ts when the board is opened as a shared project. */
export function setShareContext(ctx: { projectId: string; metadata: ShareMetadata | null }): void {
  share = ctx;
}

function withOpen(base: string, blockId: string, tab?: string): string {
  const hashAt = base.indexOf('#');
  const hash = hashAt >= 0 ? base.slice(hashAt) : '';
  const url = new URL(hashAt >= 0 ? base.slice(0, hashAt) : base, location.origin);
  url.searchParams.set('open', blockId);
  if (tab) url.searchParams.set('tab', tab); else url.searchParams.delete('tab');
  return url.href + hash;
}

/**
 * How this board's block links are made, reading the board's sharing once
 * (fresh, so a change made a minute ago counts). Used per link by "Copy link"
 * and for every link cell at once by the Excel export (which never carries the
 * edit link: a file travels further than a copied link).
 */
export async function linkBuilder(opts: { allowEditLink?: boolean } = { allowEditLink: true }): Promise<(blockId: string, tab?: string) => { url: string; editLink: boolean }> {
  if (share) {
    let meta = share.metadata;
    try { meta = await sharedRequest(share.projectId); share.metadata = meta; } catch { /* the cached copy */ }
    const base = meta?.url || `/project/${share.projectId}`;
    if (opts.allowEditLink && !meta?.publicRead && meta?.editUrl) { const edit = meta.editUrl; return (id, tab) => ({ url: withOpen(edit, id, tab), editLink: true }); }
    return (id, tab) => ({ url: withOpen(base, id, tab), editLink: false });
  }
  const board = new URLSearchParams(location.search).get('board') ?? '';
  return (id, tab) => ({ url: withOpen(`/ai/board?board=${encodeURIComponent(board)}`, id, tab), editLink: false });
}

/** The link for one block. */
export async function blockLink(blockId: string, tab?: string): Promise<{ url: string; editLink: boolean }> {
  return (await linkBuilder())(blockId, tab);
}

async function writeClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Copy a block's link and say so. */
export async function copyBlockLink(blockId: string, tab?: string): Promise<void> {
  const link = blockLink(blockId, tab);
  let ok = false;
  // Handing the clipboard a PROMISE keeps the click's permission while the
  // sharing settings are read (Safari drops it across an await).
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': link.then(r => new Blob([r.url], { type: 'text/plain' })) })]);
      ok = true;
    }
  } catch { ok = false; }
  try {
    const { url, editLink } = await link;
    if (!ok) ok = await writeClipboard(url);
    // E2E affordance, like `window.__board`: what was copied, without reading the clipboard.
    (window as unknown as { __boardLastLink?: string }).__boardLastLink = url;
    if (ok) toast(editLink ? 'Link copied. Anyone with it can edit after signing in.' : 'Link copied', 'info');
    else toast('Could not copy the link. Please try again.', 'error');
  } catch {
    toast('Could not copy the link. Please try again.', 'error');
  }
}
