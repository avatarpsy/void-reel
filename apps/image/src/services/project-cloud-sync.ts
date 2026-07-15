// project-cloud-sync.ts
// -----------------------------------------------------------------------------
// Mirror the current editor project to the cloud so it appears in the Studio
// "Images" tab (consistent with how videos/music/chats auto-list). We send ONLY
// a lightweight listing record: metadata + a small cover thumbnail + one
// flattened thumbnail per page. The full, layer-preserving project stays in
// local IndexedDB (useAutoSave) — reopening on the same browser restores it
// exactly; another device rebuilds a flattened preview from these thumbnails.
//
// Called on a long debounce after edits settle (and on page hide), NOT on every
// keystroke — rendering + a Firestore write is far heavier than the local save.
// -----------------------------------------------------------------------------

import type { Project } from '../types/project';
import { exportArtboard } from './export-service';
import { getVoidspaceIdToken } from './voidspace-storage';

const COVER_MAX = 384; // px, longest side — for the list tile
const PAGE_MAX = 768; // px, longest side — for the cross-device flattened fallback
const MAX_PAGES = 20; // cap page thumbnails so the sync stays cheap

/** Reduce an artboard's WxH to a compact "w:h" ratio string for tile sizing. */
function aspectRatioString(w: number, h: number): string {
  if (!w || !h) return '1:1';
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.round(w), Math.round(h)) || 1;
  const rw = Math.round(w) / g;
  const rh = Math.round(h) / g;
  // Keep it readable — collapse awkward ratios to their decimal-nearest common one.
  if (rw > 32 || rh > 32) {
    const r = w / h;
    const common: [number, string][] = [
      [1, '1:1'], [4 / 5, '4:5'], [5 / 4, '5:4'], [3 / 4, '3:4'], [4 / 3, '4:3'],
      [9 / 16, '9:16'], [16 / 9, '16:9'], [2 / 3, '2:3'], [3 / 2, '3:2'],
    ];
    let best = '1:1';
    let bestD = Infinity;
    for (const [val, label] of common) {
      const d = Math.abs(val - r);
      if (d < bestD) { bestD = d; best = label; }
    }
    return best;
  }
  return `${rw}:${rh}`;
}

async function artboardThumb(project: Project, artboardId: string, maxSide: number): Promise<string | null> {
  const artboard = project.artboards.find((a) => a.id === artboardId);
  if (!artboard) return null;
  const longest = Math.max(artboard.size.width, artboard.size.height) || 1;
  const scale = Math.min(1, maxSide / longest);
  try {
    const blob = await exportArtboard(project, artboard, {
      format: 'jpg',
      quality: 'medium',
      scale,
      background: 'include',
    });
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn('[project-cloud-sync] thumb render failed:', e);
    return null;
  }
}

// Skip re-sending an unchanged project (same id + updatedAt as the last success).
let lastSyncedKey = '';

/**
 * Render thumbnails for the current project and POST them to the cloud listing.
 * No-op when signed out. Safe to call often — it dedupes on (id, updatedAt) and
 * swallows its own errors (a failed mirror must never disrupt editing).
 */
export async function syncProjectToCloud(project: Project | null): Promise<void> {
  if (!project || !project.artboards.length) return;

  const key = `${project.id}:${project.updatedAt ?? ''}`;
  if (key === lastSyncedKey) return;

  const token = await getVoidspaceIdToken();
  if (!token) return; // not signed in — listing is a cloud feature

  const first = project.artboards[0];
  const cover = await artboardThumb(project, first.id, COVER_MAX);
  if (!cover) return;

  const pages: string[] = [];
  for (const ab of project.artboards.slice(0, MAX_PAGES)) {
    const t = await artboardThumb(project, ab.id, PAGE_MAX);
    if (t) pages.push(t);
  }

  try {
    const res = await fetch('/api/studio/image-project', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        name: project.name || 'Untitled',
        aspectRatio: aspectRatioString(first.size.width, first.size.height),
        pageCount: project.artboards.length,
        cover,
        pages,
        updatedAt: project.updatedAt ?? Date.now(),
      }),
    });
    if (res.ok) lastSyncedKey = key;
    else console.warn('[project-cloud-sync] mirror failed:', res.status);
  } catch (e) {
    console.warn('[project-cloud-sync] mirror error:', e);
  }
}
