// project-cloud-sync.ts
// -----------------------------------------------------------------------------
// Mirror the current editor project to the cloud. TWO things go up, and they
// answer different questions:
//
//   THE DOCUMENT   the whole layered project, to Cloud Storage. This is the
//                  file. Reopening it on ANY device restores the real thing.
//   THE LISTING    metadata + a small cover + one flattened page thumbnail, to
//                  Firestore. This is what the Images tab draws, and what a
//                  reader can show before the document has downloaded.
//
// The document used to be local-only: IndexedDB, and nothing else. That made
// every composition hostage to one browser — clear it and the layers were gone,
// open it elsewhere and you got a picture of work you could no longer edit. The
// local copy is still written (it is instant, and it works offline), but it is
// now a CACHE rather than the only copy.
//
// Called on a long debounce after edits settle (and on page hide), NOT on every
// keystroke — rendering + two uploads is far heavier than the local save.
// -----------------------------------------------------------------------------

import type { Project } from '../types/project';
import { exportArtboard } from './export-service';
import { getVoidspaceIdToken } from './voidspace-storage';
import { projectDisplayName } from './project-name';
import { compactProjectDocument } from './project-document';
import { setCloudSaveStatus } from './project-cloud-status';

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
/** Same dedupe for the document, tracked separately: the listing needs a render
 *  and can fail on its own, and a failed thumbnail must not block the file. */
let lastDocKey = '';

/**
 * Upload the FULL project document.
 *
 * Deliberately independent of the listing sync below: this is the user's work,
 * and it must not be gated on a thumbnail render succeeding. It is also much
 * cheaper — no canvas export, just a serialise and a PUT.
 */
export async function saveProjectDocument(project: Project | null): Promise<boolean> {
  if (!project?.id) return false;
  const key = `${project.id}:${project.updatedAt ?? ''}`;
  if (key === lastDocKey) return true;

  const token = await getVoidspaceIdToken();
  const updatedAt = project.updatedAt ?? Date.now();
  if (!token) {
    setCloudSaveStatus(project.id, { state: 'error', updatedAt, message: 'Sign in to back up this project. Download a project copy before clearing browser data.' });
    return false;
  }
  setCloudSaveStatus(project.id, { state: 'saving', updatedAt, message: 'Backing up the editable project…' });

  try {
    const res = await fetch('/api/studio/image-doc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        projectId: project.id,
        doc: compactProjectDocument(project),
        updatedAt: project.updatedAt ?? Date.now(),
      }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      setCloudSaveStatus(project.id, { state: 'error', updatedAt,
        message: (detail.statusMessage || detail.message || 'Cloud backup failed.') + ' Retry, or download a project copy before clearing browser data.' });
      console.warn('[project-cloud-sync] document save failed:', res.status);
      return false;
    }
    const result = await res.json();
    if (result.skipped === 'stale') {
      setCloudSaveStatus(project.id, { state: 'error', updatedAt,
        message: 'A newer version is already backed up. Download this project copy, then reopen the cloud version before editing further.' });
      return false;
    }
    lastDocKey = key;
    setCloudSaveStatus(project.id, { state: 'saved', updatedAt, message: 'Editable project backed up to your account.' });
    return true;
  } catch (e) {
    setCloudSaveStatus(project.id, { state: 'error', updatedAt, message: 'Cloud backup could not connect. Retry, or download a project copy before clearing browser data.' });
    // Never disrupt editing. The local autosave already holds this state, and
    // the next debounce or the page-hide flush will try again.
    console.warn('[project-cloud-sync] document save error:', e);
    return false;
  }
}

/**
 * Render thumbnails for the current project and POST them to the cloud listing.
 * No-op when signed out. Safe to call often — it dedupes on (id, updatedAt) and
 * swallows its own errors (a failed mirror must never disrupt editing).
 */
export async function syncProjectToCloud(project: Project | null): Promise<void> {
  if (!project || !project.artboards.length) return;

  /**
   * THE DOCUMENT FIRST, AND UNCONDITIONALLY.
   *
   * Started before the thumbnails and not awaited against them: rendering a
   * cover can fail on a huge artboard or a tainted canvas, and losing the file
   * because its picture would not render is the exact failure this whole change
   * exists to remove.
   */
  void saveProjectDocument(project);

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
        // The library shows this. A project keeps the format it was born with
        // as its name forever unless somebody renames it, which made a hundred
        // decks share one card — see `projectDisplayName`.
        name: projectDisplayName(project),
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
