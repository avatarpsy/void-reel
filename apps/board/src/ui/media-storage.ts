import { addImages } from '@blocksuite/affine/blocks/image';
import { addAttachments } from '@blocksuite/affine/blocks/attachment';
import type { MountedBoard } from '../blocksuite/editor';
import { isMediaRef } from '../board/media-ref';
import { normaliseMediaCard } from '../board/asset-media';
import { writeBlockMeta } from '../board/board-meta';
import { toast } from './toast';
import { readShots } from '../shot/shots';
import { localReferenceKey } from '../board/local-reference';
import '../theme/media-storage.css';

/** Explicit file entry points share the native insert helpers and blob store.
 * Claim only media files; text/document paste remains the editor's own job. */
export function installMediaStorage(board: MountedBoard, root: HTMLElement, chrome: HTMLElement): void {
  const store = board.workspace.blobSource.native!;
  const panel = document.createElement('section');
  panel.className = 'vs-media-storage'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Board files');
  panel.innerHTML = '<header><strong>Board files</strong><button data-close aria-label="Close board files">×</button></header>'
    + '<p>Originals stay on this device. Cloud backup uses your available storage. Choose your Voidspace folder to keep a disk backup too.</p>'
    + '<div class="vs-media-storage-actions"><button data-add>Add files</button><button data-folder>Choose Voidspace folder</button></div>'
    + '<p data-folder-status role="status"></p><div data-files></div>';
  chrome.append(panel);
  const button = document.createElement('button'); button.className = 'vs-board-btn';
  button.textContent = 'Files'; button.type = 'button';
  button.onclick = () => { panel.hidden = !panel.hidden; render(); };
  chrome.querySelector('.vs-board-bar')?.append(button);
  panel.querySelector<HTMLButtonElement>('[data-close]')!.onclick = () => { panel.hidden = true; };
  const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
  input.accept = 'image/*,audio/*,video/*'; input.hidden = true; panel.append(input);

  const originalKeys = (): Map<string, string[]> => {
    const keys = new Map<string, string[]>();
    for (const [id] of board.workspace.doc.getMap('blocks')) {
      const model = board.store.getBlock(id)?.model;
      if (!model || !['affine:image', 'affine:attachment'].includes(model.flavour)) continue;
      const key = String((model.props as { sourceId?: string }).sourceId || '');
      if (!key || isMediaRef(key)) continue;
      keys.set(key, [...(keys.get(key) || []), id]);
    }
    for (const shot of readShots(board.std)) {
      for (const media of shot.media) {
        const key = localReferenceKey(media.url);
        if (key) keys.set(key, [...new Set([...(keys.get(key) || []), shot.id])]);
      }
    }
    return keys;
  };
  const reportError = (e: unknown) => toast(e instanceof Error ? e.message : 'Could not save that file. Please retry.', 'error');
  let rendering = false;
  const render = () => {
    if (rendering) return;
    rendering = true;
    requestAnimationFrame(() => {
      rendering = false;
      const keys = originalKeys(); let issues = 0;
      for (const [key, ids] of keys) {
        const status = store.status(key);
        if (['missing', 'unsaved', 'browser'].includes(status.state)) issues++;
        for (const id of ids) {
          const node = board.std.view.getBlock(id) as unknown as HTMLElement | null;
          if (node) {
            node.dataset.mediaSave = status.state;
            node.dataset.mediaSaveLabel = status.state === 'cloud' ? 'Cloud backup' : status.state === 'missing' ? 'Original missing · Open Files to relink'
              : status.state === 'uploading' ? 'Backing up…' : status.state === 'folder' ? 'Saved to folder'
                : status.state === 'unsaved' ? 'Not saved · Download original' : status.state === 'checking' ? 'Checking file…' : 'This browser only · Open Files';
            node.title = status.message;
          }
        }
      }
      button.textContent = issues ? `Files · ${issues} need attention` : 'Files';
      if (panel.hidden) return;
      const list = panel.querySelector('[data-files]')!; list.replaceChildren();
      if (!keys.size) { const p = document.createElement('p'); p.textContent = 'No locally imported files on this board.'; list.append(p); }
      for (const [key, ids] of keys) {
        const row = document.createElement('article');
        const title = document.createElement('strong'); title.textContent = store.records.get(key)?.name || `Original file (${ids.length} card${ids.length > 1 ? 's' : ''})`;
        const status = document.createElement('p'); status.textContent = store.status(key).message;
        const actions = document.createElement('div'); actions.className = 'vs-media-storage-actions';
        const action = (label: string, fn: () => Promise<unknown>) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { b.disabled = true; void fn().catch(reportError).finally(() => { b.disabled = false; render(); }); }; actions.append(b); };
        action('Retry backup', () => store.mirror(key));
        action('Download original', () => store.download(key));
        action('Relink original', async () => {
          const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/*,audio/*,video/*';
          picker.hidden = true; panel.append(picker);
          picker.oncancel = () => picker.remove();
          picker.onchange = async () => {
            const file = picker.files?.[0]; picker.remove(); if (!file) return;
            try {
              // A new content key, not replacement bytes under an old hash.
              const newKey = await board.workspace.blobSync.set(file);
              for (const id of ids) {
                const block = board.store.getBlock(id);
                if (block?.model.flavour === 'voidspace:shot') {
                  const media = (block.model.props as { media: { url: string; displayUrl?: string }[] }).media;
                  board.store.updateBlock(block.model, () => {
                    for (const m of media) if (localReferenceKey(m.url) === key) {
                      m.url = `vs-local:${encodeURIComponent(newKey)}`;
                      delete m.displayUrl;
                    }
                  });
                } else if (block) {
                  board.store.updateBlock(block.model, { sourceId: newKey });
                  writeBlockMeta(board.workspace.doc, id, { originalUrl: `vs-local:${encodeURIComponent(newKey)}`, name: file.name });
                }
              }
              toast('Original relinked. Its position and size are unchanged.');
            } catch (e) { reportError(e); }
          };
          picker.click();
        });
        row.append(title, status, actions); list.append(row);
      }
    });
  };

  async function insert(files: File[], point?: [number, number]): Promise<void> {
    for (const file of files) {
      if (file.size > 200 * 1024 * 1024) { toast(`${file.name} exceeds the 200 MB import limit.`, 'error'); continue; }
      const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'video';
      const ids = kind === 'image'
        ? await addImages(board.std, [file], { point, maxWidth: 420, shouldTransformPoint: true })
        : await addAttachments(board.std, [file], point, true);
      if (!ids.length) throw new Error(`${file.name} could not be placed on the board.`);
      for (const id of ids) {
        normaliseMediaCard(board.std, id, kind);
        writeBlockMeta(board.workspace.doc, id, { name: file.name, kind, createdBy: 'user' });
      }
      if (point) point = [point[0] + 36, point[1] + 36];
    }
    render();
  }
  input.onchange = () => { void insert([...input.files || []]).catch(reportError); input.value = ''; };
  panel.querySelector<HTMLButtonElement>('[data-add]')!.onclick = () => input.click();
  panel.querySelector<HTMLButtonElement>('[data-folder]')!.onclick = () => {
    const status = panel.querySelector('[data-folder-status]')!;
    void store.chooseFolder().then(() => { status.textContent = 'Folder connected. Originals and this board are backed up under boards/.'; render(); }).catch(e => { status.textContent = e instanceof Error ? e.message : 'Folder backup failed.'; });
  };
  const mediaFiles = (dt: DataTransfer | null): File[] => [...dt?.files || []].filter(f => /^(image|audio|video)\//.test(f.type));
  root.addEventListener('drop', e => {
    const files = mediaFiles(e.dataTransfer); if (!files.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    void insert(files, [e.clientX, e.clientY]).catch(reportError);
  }, true);
  root.addEventListener('dragover', e => {
    if ([...e.dataTransfer?.items || []].some(i => i.kind === 'file' && /^(image|audio|video)\//.test(i.type))) e.preventDefault();
  }, true);
  document.addEventListener('paste', e => {
    // Do not steal media pasted into a document, text field or chat composer.
    if ((e.target as HTMLElement)?.closest?.('input,textarea,[contenteditable="true"]')) return;
    const files = mediaFiles(e.clipboardData); if (!files.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    void insert(files).catch(reportError);
  }, true);
  store.addEventListener('change', render);
  store.addEventListener('backup-error', e => { panel.querySelector('[data-folder-status]')!.textContent = (e as CustomEvent).detail; toast((e as CustomEvent).detail, 'error'); });
  board.workspace.doc.on('update', render);
  new MutationObserver(render).observe(root, { childList: true, subtree: true });
  for (const key of originalKeys().keys()) void store.get(key);
  render();
}
