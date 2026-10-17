/**
 * HOW FULL THIS BOARD IS — said in plain words before a limit breaks anything.
 *
 * Two server limits can stop a board from saving, and until now both failed
 * silently:
 *
 *   - Every board: the saved file is refused over 24 MB (`/api/board/doc`).
 *     The local copy kept the work, the upload retried forever, and nobody was
 *     told. Measured 17 Oct 2026: a document of one to three pages costs about
 *     10 KB, so this is roughly 2,300 documents.
 *   - A SHARED board: the server refuses a board of more than 20,000 blocks
 *     (every paragraph, list item and table is a block; a one-to-three page
 *     document is about 20). Roughly 950 documents.
 *
 * Each is warned about once at 80% and again when it is reached. The numbers
 * come from the save path (bytes) and a cheap count of the block map.
 */
import { toast } from './toast';

export const BOARD_BYTES_CAP = 24 * 1024 * 1024;
export const SHARED_BLOCKS_CAP = 20_000;
const WARN = 0.8;
/** How often the same "full" message may come back while it stays full. */
const REPEAT_MS = 10 * 60_000;

const said = new Map<string, number>();
function once(key: string, message: string, kind: 'info' | 'error', repeatMs = Infinity): void {
  const last = said.get(key);
  if (last !== undefined && Date.now() - last < repeatMs) return;
  said.set(key, Date.now());
  toast(message, kind);
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

export type SizeVerdict = 'ok' | 'near' | 'full';

/** The saved size of the board, checked on every save. `full` means do not upload. */
export function checkBoardBytes(bytes: number): SizeVerdict {
  if (bytes > BOARD_BYTES_CAP) {
    once('bytes-full', `This board is full (${mb(bytes)} MB of 24 MB), so new changes are saved on this device only. Move some documents to a new board to keep saving online.`, 'error', REPEAT_MS);
    return 'full';
  }
  if (bytes > BOARD_BYTES_CAP * WARN) {
    once('bytes-near', `This board is nearly full (${mb(bytes)} MB of 24 MB). Start a new board for new documents.`, 'info');
    return 'near';
  }
  return 'ok';
}

/** The block count of a shared board, checked as it changes. */
export function checkSharedBlocks(blocks: number): SizeVerdict {
  if (blocks > SHARED_BLOCKS_CAP) {
    once('blocks-full', 'This shared board is full, so new changes cannot be saved. Delete some documents, or move them to another board.', 'error', REPEAT_MS);
    return 'full';
  }
  if (blocks > SHARED_BLOCKS_CAP * WARN) {
    once('blocks-near', `This shared board is ${Math.floor((blocks / SHARED_BLOCKS_CAP) * 100)}% full. Start a new board for new documents.`, 'info');
    return 'near';
  }
  return 'ok';
}
