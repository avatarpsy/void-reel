// carousel-publish.ts
// -----------------------------------------------------------------------------
// The two things a carousel publish needs besides its caption: page images that
// OUTLIVE the draft, and the avatar it is published as.
//
// Pages used to go through /api/studio/upload-temp: Kie temp storage, gone in
// 3 days. A draft approved or scheduled later, and the feed copy of every
// published carousel, then pointed at dead images. They now go through the
// board's durable door (upload-attachment with `x-voidspace-durable-only: 1`),
// which answers `{ placement: 'durable', url }` or says why it would not.
//
// Drafts also went out as `avatar_name: 'You'` with no avatar id, so they
// published as avatarId "". The avatar is now resolved the way the video
// editor's PublishDialog resolves it (`avatar_automation_subscriptions/{uid}`),
// read over Firestore REST with the person's own token: this bundle has no
// Firebase SDK, and the rules let a user read their own subscription doc.
// -----------------------------------------------------------------------------

import { NotSignedInError } from './voidspace-storage';

/** The server would not keep the page (storage full, file rejected). Its words are for the person. */
export class DurableUploadRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'DurableUploadRefusedError'; }
}

const STORAGE_FULL = 'Your storage is full, so the carousel pages could not be saved. Free up space or upgrade, then publish again.';

/** Upload one rendered page so its url never expires. */
export async function uploadDurablePage(file: File, token: string): Promise<string> {
  const form = new FormData();
  form.append('file', file, file.name);
  let res: Response;
  try {
    res = await fetch('/api/studio/upload-attachment', {
      method: 'POST',
      // NO Content-Type: the browser sets the multipart boundary.
      headers: { Authorization: `Bearer ${token}`, 'x-voidspace-durable-only': '1', 'x-voidspace-surface': 'image' },
      body: form,
    });
  } catch {
    throw new Error('The pages could not be uploaded. Check your connection and try again.');
  }
  if (res.status === 401) throw new NotSignedInError();
  if (res.status === 507 || res.status === 413) {
    const text = await res.text().catch(() => '');
    throw new DurableUploadRefusedError(res.status === 507 ? STORAGE_FULL : (text || 'A page is too large to upload.'));
  }
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  const json = await res.json().catch(() => null) as { placement?: string; url?: string; reason?: string; note?: string } | null;
  if (json?.placement === 'durable' && json.url) return String(json.url);
  // `temp_failed` is the server's storage hiccuping; anything else is the quota.
  if (json?.reason === 'temp_failed') throw new Error('Saving the pages did not work just now. Try again in a moment.');
  throw new DurableUploadRefusedError(STORAGE_FULL);
}

export interface PublishAvatar { avatarId: string; avatarName?: string }

/** The Firebase project id is the token's audience. */
function projectIdFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.aud === 'string' && payload.aud ? payload.aud : null;
  } catch {
    return null;
  }
}

type FsValue = { stringValue?: string; arrayValue?: { values?: FsValue[] }; mapValue?: { fields?: Record<string, FsValue> } };

/**
 * The avatar a carousel is published as: the same pick as the video
 * PublishDialog — the automation avatar with connected social accounts, else
 * the first one. Null when there is none or it cannot be read; the draft then
 * goes without one rather than failing the publish.
 */
export async function resolvePublishAvatar(token: string, uid: string): Promise<PublishAvatar | null> {
  const project = projectIdFromToken(token);
  if (!project) return null;
  try {
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents/avatar_automation_subscriptions/${encodeURIComponent(uid)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const doc = await res.json() as { fields?: Record<string, FsValue> };
    const avatars = (doc.fields?.automationAvatars?.arrayValue?.values ?? [])
      .map(v => v.mapValue?.fields ?? {})
      .map(f => ({
        avatarId: f.avatarId?.stringValue || f.id?.stringValue || '',
        avatarName: f.avatarName?.stringValue || undefined,
        connected: (f.socialAccountsConnected?.arrayValue?.values ?? []).length > 0,
      }))
      .filter(a => a.avatarId);
    const pick = avatars.find(a => a.connected) ?? avatars[0];
    return pick ? { avatarId: pick.avatarId, ...(pick.avatarName ? { avatarName: pick.avatarName } : {}) } : null;
  } catch {
    return null;
  }
}
