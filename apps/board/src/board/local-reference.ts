import type { BlockStdScope } from '@blocksuite/std';
import type { BoardWorkspace } from '../blocksuite/workspace';
export function localReferenceKey(url: string): string | null {
  return url.startsWith('vs-local:') ? decodeURIComponent(url.slice('vs-local:'.length)) : null;
}
export function displayReference(std: BlockStdScope, url: string, ready: () => void): string {
  const key = localReferenceKey(url);
  return key ? (std.store.doc.workspace as BoardWorkspace).blobSource.native?.preview(key, ready) || '' : url;
}
export async function providerReference(std: BlockStdScope, url: string): Promise<string> {
  const key = localReferenceKey(url);
  if (!key) return url;
  const native = (std.store.doc.workspace as BoardWorkspace).blobSource.native;
  if (!native) throw new Error('The local reference cannot be read on this device. Relink its original.');
  return native.providerReference(key);
}
