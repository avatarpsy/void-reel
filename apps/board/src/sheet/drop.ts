/**
 * Dropping a spreadsheet on the board makes a SHEET, not a file card.
 *
 * .xlsx, .csv and .tsv — read here, with our own readers (`import.ts`), and
 * placed where the file was dropped. What could not be kept is said in the
 * toast, the same promise the document drop makes for Word files.
 */
import type { MountedBoard } from '../blocksuite/editor';
import { toast } from '../ui/toast';
import { SheetError, createSheetPaced } from './ops';

const SHEET_FILE = /\.(xlsx|xlsm|csv|tsv)$/i;
const MAX_BYTES = 12 * 1024 * 1024;

function dropPoint(e: DragEvent): { x: number; y: number } | undefined {
  try {
    const root = document.querySelector('affine-edgeless-root') as unknown as { gfx?: { viewport?: { toModelCoord?(x: number, y: number): [number, number] } } } | null;
    const vp = root?.gfx?.viewport;
    if (!vp?.toModelCoord) return undefined;
    const [x, y] = vp.toModelCoord(e.clientX, e.clientY);
    return { x: Math.round(x), y: Math.round(y) };
  } catch { return undefined; }
}

/** Turn one spreadsheet file into a new sheet on the board. Returns its id. */
export async function importSheetToBoard(
  board: MountedBoard,
  file: { name: string; bytes: Uint8Array },
  at?: { x: number; y: number },
): Promise<{ blockId: string; note: string; notes: string[]; rows: number; tabs: number }> {
  const { importSheetFile, importNote } = await import('./import');
  const result = await importSheetFile(file.name, file.bytes);
  const made = await createSheetPaced(board.std, board.surfaceId, { title: result.title, tabs: result.tabs, at });
  return { blockId: made.blockId, note: importNote(file.name, result), notes: result.notes, rows: result.rows, tabs: result.tabs.length };
}

export function installSheetDrop(board: MountedBoard, container: HTMLElement, open: (blockId: string) => void): () => void {
  const onDrop = async (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter(f => SHEET_FILE.test(f.name));
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (board.store.readonly) { toast('This board is open to view only.', 'info'); return; }
    const at = dropPoint(e);
    let first = '';
    for (const f of files) {
      if (f.size > MAX_BYTES) { toast(`${f.name} is too large to import here (12 MB at most).`, 'error'); continue; }
      try {
        toast(`Reading ${f.name}…`, 'info');
        const out = await importSheetToBoard(board, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }, first ? undefined : at);
        first ||= out.blockId;
        toast(out.note, out.notes.length ? 'error' : 'info');
      } catch (err) {
        toast(err instanceof SheetError || err instanceof Error ? (err as Error).message : `${f.name} could not be imported.`, 'error');
      }
    }
    if (first) open(first);
  };
  container.addEventListener('drop', onDrop, true);
  return () => container.removeEventListener('drop', onDrop, true);
}
