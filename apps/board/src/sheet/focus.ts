/**
 * A sheet, full size — where it is edited.
 *
 * The same `vs-focus` shell as the screenplay and documents: "← Board", the
 * name you click to rename, one Download menu, Escape to leave, and the agent
 * chat still on the right (it lives in the parent page). The grid is loaded on
 * first open, so the board's start-up bundle does not carry it. Under 640 px
 * the grid is swapped for row cards (`cards.ts`).
 */
import type { MountedBoard } from '../blocksuite/editor';
import { enterFocusMode } from '../ui/focus-lock';
import { toast } from '../ui/toast';
import { copyBlockLink } from '../ui/copy-link';
import { readSheet, readTabs, type CellValue, type ColumnType, type SheetJsonTab } from './sheet-data';
import { SheetError, addTabPaced, deleteTab, moveTab, readTab, setTitle, sheetYBlock, updateTab } from './ops';
import { lastTab, rememberTab } from './block';
import { TEMPLATES, templateTab, type TemplateId } from './templates';
import type { SheetGrid } from './grid';
import type { SheetCards } from './cards';

export interface SheetFocus {
  open(blockId: string, tabId?: string): void;
  close(): void;
  isOpen(): boolean;
  openId(): string | null;
  destroy(): void;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ESC[c]!);

export function sheetFileName(title: string, ext: string): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'sheet';
  return `${base}.${ext}`;
}

/** The sheet as a file. `tabId` limits a CSV (or a workbook) to one tab. */
export async function buildSheetFile(
  board: MountedBoard,
  blockId: string,
  format: 'xlsx' | 'csv',
  tabId?: string,
): Promise<{ blob: Blob; fileName: string; bytes: number; tabs: number; rows: number }> {
  const sheet = readSheet(board.store.doc.spaceDoc, blockId);
  if (!sheet) throw new SheetError('not_found', 'That sheet is not on this board any more.');
  const tabs: SheetJsonTab[] = tabId ? sheet.tabs.filter(t => t.id === tabId) : sheet.tabs;
  if (!tabs.length) throw new SheetError('not_found', 'That tab is not in this sheet.');
  if (format === 'csv') {
    const { toDelimited } = await import('./csv');
    const { cellText } = await import('./sheet-data');
    const tab = tabs[0]!;
    const cols = tab.columns.filter(c => !c.hidden);
    const link = cols.some(c => c.type === 'link') ? await exportLinkResolver(board) : null;
    const text = (v: CellValue, type: ColumnType) => (type === 'link' && typeof v === 'string' && v && link ? link(v)?.text ?? v : cellText(v, type));
    const rows = [cols.map(c => c.name), ...tab.rows.map(r => cols.map(c => text(r.values[c.id] ?? null, c.type)))];
    // A BOM so Excel opens UTF-8 (names in Hindi, Tamil, emoji) correctly.
    const blob = new Blob(['﻿' + toDelimited(rows)], { type: 'text/csv;charset=utf-8' });
    const name = sheet.tabs.length > 1 ? `${sheet.title} - ${tab.name}` : sheet.title;
    return { blob, fileName: sheetFileName(name, 'csv'), bytes: blob.size, tabs: 1, rows: tab.rows.length };
  }
  const { writeXlsx } = await import('./xlsx');
  const bytes = await writeXlsx(tabs, sheet.title, await exportLinkResolver(board));
  const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return { blob, fileName: sheetFileName(sheet.title, 'xlsx'), bytes: blob.size, tabs: tabs.length, rows: tabs.reduce((n, t) => n + t.rows.length, 0) };
}

/**
 * Link cells in an export: the linked title, and a web address that opens it
 * (this board's link, or the other board's). Shots have no address of their own.
 */
async function exportLinkResolver(board: MountedBoard): Promise<(v: string) => { text: string; url?: string } | null> {
  const [{ linkLabel, isHere }, { parseDocValue, docPath }, { linkBuilder }] = await Promise.all([
    import('./doc-link-board'), import('./doc-link'), import('../ui/copy-link'),
  ]);
  const build = await linkBuilder({ allowEditLink: false });
  return (v: string) => {
    const text = linkLabel(board.std, v).text;
    if (v.startsWith('board:')) return { text, url: `${location.origin}/ai/board?board=${encodeURIComponent(v.slice(6))}` };
    const ref = parseDocValue(v);
    if (!ref) return { text };
    if (isHere(ref)) return board.store.getBlock(ref.block) ? { text, url: build(ref.block, ref.tab).url } : { text };
    const path = docPath(ref);
    return { text, ...(path ? { url: location.origin + path } : {}) };
  };
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let leaveFocus: (() => void) | null = null;

export function installSheetFocus(
  board: MountedBoard,
  container: HTMLElement,
  opts: { makeCards: (blockId: string, tabId: string, rowKeys?: string[]) => void },
): SheetFocus {
  const el = document.createElement('div');
  el.className = 'vs-focus vs-sheet-focus';
  el.hidden = true;
  container.append(el);

  let blockId: string | null = null;
  let tabId = '';
  let grid: SheetGrid | null = null;
  let cards: SheetCards | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  let unobserve: (() => void) | null = null;
  const phone = window.matchMedia('(max-width: 640px)');

  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s);
  const readonly = () => board.store.readonly;

  function stats(): string {
    const y = blockId ? sheetYBlock(board.store, blockId) : null;
    if (!y) return '';
    const all = readTabs(y);
    const tabs = all.length;
    // The rows people SEE — a shot list counts its shots, not stored notes.
    const rows = all.reduce((n, t) => n + (readTab(board.std, blockId!, t.id)?.rows.length ?? 0), 0);
    return `${tabs} tab${tabs === 1 ? '' : 's'} · ${rows.toLocaleString('en')} row${rows === 1 ? '' : 's'}`;
  }

  function paintTabs(): void {
    const strip = q<HTMLElement>('[data-tabs]');
    const y = blockId ? sheetYBlock(board.store, blockId) : null;
    if (!strip || !y) return;
    const tabs = readTabs(y);
    if (!tabs.some(t => t.id === tabId) && tabs[0]) switchTab(tabs[0].id);
    strip.innerHTML = tabs.map(t => `
      <button type="button" class="vs-sheet-tab ${t.id === tabId ? 'is-on' : ''}" data-tab="${t.id}" title="${t.binding?.kind === 'shots' ? 'Linked to the shot cards on this board' : esc(t.name)}">
        ${t.binding?.kind === 'shots' ? '<span class="vs-sheet-tab__link"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6.5 9.5l3-3"/><path d="M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2"/><path d="M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"/></svg></span>' : ''}${esc(t.name)}
        ${t.id === tabId && !readonly() ? '<span class="vs-sheet-tab__menu" data-tab-menu="' + t.id + '" aria-label="Tab options">▾</span>' : ''}
      </button>`).join('')
      + (readonly() ? '' : '<button type="button" class="vs-sheet-tab vs-sheet-tab--add" data-act="add-tab">+ Add tab</button>');
    const hint = q<HTMLElement>('[data-hint]');
    if (hint) hint.textContent = stats();
    const name = q<HTMLInputElement>('[data-name]');
    const title = String(y.get('prop:title') ?? '') || 'Untitled sheet';
    if (name && document.activeElement !== name && name.value !== title) name.value = title;
    if (name) { name.style.width = `${Math.max(8, Math.min(40, (name.value || title).length + 2))}ch`; name.style.flex = 'none'; }
  }

  function switchTab(next: string): void {
    tabId = next;
    if (blockId) rememberTab(blockId, next);
    window.dispatchEvent(new CustomEvent('voidspace-sheet-tab', { detail: { blockId } }));
    grid?.setTab(next);
    cards?.setTab(next);
    paintTabs();
  }

  async function mountView(): Promise<void> {
    const host = q<HTMLElement>('[data-view]');
    if (!host || !blockId) return;
    grid?.destroy(); grid = null;
    cards?.destroy(); cards = null;
    host.innerHTML = '';
    const id = blockId;
    if (phone.matches) {
      const { SheetCards } = await import('./cards');
      if (blockId !== id) return;
      cards = new SheetCards(host, { std: board.std, blockId: id, tabId, readonly: readonly(), onTab: switchTab });
    } else {
      const { SheetGrid } = await import('./grid');
      if (blockId !== id) return;
      grid = new SheetGrid(host, {
        std: board.std, blockId: id, tabId, readonly: readonly(),
        onMakeCards: keys => opts.makeCards(id, tabId, keys),
      });
    }
  }

  function setMenu(which: 'download' | 'tab' | 'add' | null, anchor?: HTMLElement): void {
    const menu = q<HTMLElement>('[data-menu]');
    const pop = q<HTMLElement>('[data-tabpop]');
    if (menu) menu.hidden = which !== 'download';
    q('[data-act="menu"]')?.setAttribute('aria-expanded', String(which === 'download'));
    if (!pop) return;
    if (which !== 'tab' && which !== 'add') { pop.hidden = true; return; }
    const r = anchor?.getBoundingClientRect();
    const hr = el.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min((r?.left ?? 0) - hr.left, hr.width - 260))}px`;
    pop.style.bottom = `${hr.bottom - (r?.top ?? hr.bottom) + 6}px`;
    pop.innerHTML = which === 'add'
      ? `<div class="vsg-menu__title">Add a tab</div>${TEMPLATES.map(t => `<button type="button" data-template="${t.id}"><strong>${t.label}</strong><em>${t.hint}</em></button>`).join('')}`
      : `<button type="button" data-act="tab-rename">Rename</button>
         <button type="button" data-act="tab-left">Move left</button>
         <button type="button" data-act="tab-right">Move right</button>
         <button type="button" data-act="tab-freeze">Freeze first column on or off</button>
         <hr /><button type="button" class="is-danger" data-act="tab-delete">Delete tab</button>`;
    pop.hidden = false;
  }

  function paint(): void {
    el.innerHTML = `
      <header class="vs-focus__bar">
        <button type="button" class="vs-focus__back" data-act="close" title="Back to the board (Esc)">← Board</button>
        <div class="vs-focus__title">
          <input class="vs-focus__name" data-name value="" size="16" spellcheck="false" aria-label="Sheet name" placeholder="Untitled sheet" maxlength="120" ${readonly() ? 'readonly' : ''} />
          <span data-hint></span>
        </div>
        <div class="vs-focus__actions">
          ${readonly() ? '' : `<button type="button" class="vs-focus__btn" data-act="import" title="Add tabs from an Excel or CSV file">Import</button>
          <input type="file" data-file hidden style="display:none" accept=".xlsx,.xlsm,.csv,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />`}
          <button type="button" class="vs-focus__btn" data-act="copy-link" title="Copy a link to this tab. People who can open this board can open it.">Copy link</button>
          <div class="vs-focus__menu-wrap">
            <button type="button" class="vs-focus__btn vs-focus__btn--primary" data-act="menu" aria-haspopup="menu" aria-expanded="false">
              Download <span class="vs-focus__caret">&#9662;</span>
            </button>
            <div class="vs-focus__menu" data-menu hidden role="menu">
              <button type="button" role="menuitem" data-act="xlsx"><strong>Excel workbook (.xlsx)</strong><em>Every tab, with types, widths and dropdowns. Opens in Excel and Google Sheets.</em></button>
              <button type="button" role="menuitem" data-act="csv"><strong>CSV (this tab)</strong><em>Plain values. Opens anywhere.</em></button>
            </div>
          </div>
        </div>
      </header>
      <div class="vs-sheet-main"><div class="vsg-host" data-view style="display:flex;flex-direction:column;flex:1;min-height:0;position:relative"></div></div>
      <nav class="vs-sheet-tabs" data-tabs aria-label="Tabs"></nav>
      <div class="vsg-pop vsg-menu vs-sheet-tabpop" data-tabpop hidden role="menu" style="position:absolute;width:260px"></div>`;
  }

  async function download(format: 'xlsx' | 'csv'): Promise<void> {
    if (!blockId) return;
    grid?.commitEdit();
    try {
      const out = await buildSheetFile(board, blockId, format, format === 'csv' ? tabId : undefined);
      saveBlob(out.blob, out.fileName);
      toast(`Downloaded ${out.fileName}`, 'info');
    } catch (e) {
      toast(e instanceof SheetError ? e.message : 'That file could not be made.', 'error');
    }
  }

  async function importFile(file: File): Promise<void> {
    if (!blockId) return;
    const id = blockId;
    try {
      if (file.size > 12 * 1024 * 1024) { toast(`${file.name} is too large to import here (12 MB at most).`, 'error'); return; }
      toast(`Reading ${file.name}…`, 'info');
      const { importSheetFile, importNote } = await import('./import');
      const result = await importSheetFile(file.name, new Uint8Array(await file.arrayBuffer()));
      let first = '';
      for (const tab of result.tabs) {
        const t = await addTabPaced(board.store, id, tab);
        first ||= t;
      }
      if (first) switchTab(first);
      toast(importNote(file.name, result), result.notes.length ? 'error' : 'info');
    } catch (e) {
      toast(e instanceof SheetError || e instanceof Error ? (e as Error).message : `${file.name} could not be imported.`, 'error');
    }
  }

  el.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    const tabMenu = t.closest<HTMLElement>('[data-tab-menu]');
    if (tabMenu) { e.stopPropagation(); setMenu('tab', tabMenu); return; }
    const tab = t.closest<HTMLElement>('[data-tab]');
    if (tab && tab.dataset.tab !== tabId) { switchTab(tab.dataset.tab!); return; }
    const tpl = t.closest<HTMLElement>('[data-template]')?.dataset.template as TemplateId | undefined;
    if (tpl && blockId) {
      setMenu(null);
      const id = blockId;
      const spec = templateTab(tpl).tab;
      if (tpl === 'blank') spec.name = `Sheet ${readTabs(sheetYBlock(board.store, id)!).length + 1}`;
      void addTabPaced(board.store, id, spec).then(next => switchTab(next))
        .catch(err => toast(err instanceof SheetError ? err.message : 'That tab could not be added.', 'error'));
      return;
    }
    if (!act) return;
    const run = (fn: () => void) => { try { fn(); } catch (err) { toast(err instanceof SheetError ? err.message : 'That did not work.', 'error'); } };
    switch (act) {
      case 'close': close(); return;
      case 'copy-link': if (blockId) void copyBlockLink(blockId, tabId || undefined); return;
      case 'menu': setMenu(q<HTMLElement>('[data-menu]')?.hidden === false ? null : 'download'); return;
      case 'xlsx': setMenu(null); void download('xlsx'); return;
      case 'csv': setMenu(null); void download('csv'); return;
      case 'import': q<HTMLInputElement>('[data-file]')?.click(); return;
      case 'add-tab': setMenu('add', t.closest<HTMLElement>('[data-act]')!); return;
      case 'tab-rename': {
        setMenu(null);
        const y = blockId ? sheetYBlock(board.store, blockId) : null;
        const cur = y ? readTabs(y).find(x => x.id === tabId)?.name ?? '' : '';
        const btn = q<HTMLElement>(`[data-tab="${tabId}"]`);
        if (!btn) return;
        btn.innerHTML = `<input class="vs-sheet-tab__input" value="${esc(cur)}" maxlength="80" style="width:${Math.max(80, cur.length * 8)}px;font:inherit;border:0;background:transparent;color:inherit;outline:none" />`;
        const input = btn.querySelector('input')!;
        input.focus(); input.select();
        const done = (save: boolean) => { if (save && input.value.trim() && blockId) run(() => updateTab(board.store, blockId!, tabId, { name: input.value })); paintTabs(); };
        input.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
        input.addEventListener('blur', () => done(true), { once: true });
        return;
      }
      case 'tab-left': case 'tab-right': {
        setMenu(null);
        const y = blockId ? sheetYBlock(board.store, blockId) : null;
        if (!y || !blockId) return;
        const tabs = readTabs(y); const i = tabs.findIndex(x => x.id === tabId);
        if (act === 'tab-left' && i > 0) run(() => moveTab(board.store, blockId!, tabId, tabs[i - 1]!.id));
        if (act === 'tab-right' && i < tabs.length - 1) run(() => moveTab(board.store, blockId!, tabId, tabs[i + 2]?.id ?? null));
        paintTabs();
        return;
      }
      case 'tab-freeze': {
        setMenu(null);
        const y = blockId ? sheetYBlock(board.store, blockId) : null;
        const cur = y ? readTabs(y).find(x => x.id === tabId)?.frozen ?? 1 : 1;
        if (blockId) run(() => updateTab(board.store, blockId!, tabId, { frozen: cur ? 0 : 1 }));
        return;
      }
      case 'tab-delete': {
        setMenu(null);
        if (!blockId) return;
        const y = sheetYBlock(board.store, blockId);
        const name = y ? readTabs(y).find(x => x.id === tabId)?.name ?? 'this tab' : 'this tab';
        if (!window.confirm(`Delete "${name}" and everything in it? You can undo with Ctrl+Z.`)) return;
        run(() => deleteTab(board.store, blockId!, tabId));
        paintTabs();
        return;
      }
    }
  });
  el.addEventListener('dblclick', e => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    if (tab && tab.dataset.tab === tabId && !readonly()) {
      const btn = document.createElement('button'); btn.dataset.act = 'tab-rename';
      el.append(btn); btn.click(); btn.remove();
    }
  });
  el.addEventListener('change', e => {
    const input = e.target as HTMLInputElement;
    if (input.matches('[data-file]') && input.files?.[0]) { void importFile(input.files[0]); input.value = ''; }
  });
  el.addEventListener('keydown', e => {
    const name = q<HTMLInputElement>('[data-name]');
    if (e.target !== name) return;
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); name!.blur(); }
    if (e.key === 'Escape') { const y = blockId ? sheetYBlock(board.store, blockId) : null; name!.value = String(y?.get('prop:title') ?? ''); name!.blur(); }
  });
  el.addEventListener('input', e => {
    const name = q<HTMLInputElement>('[data-name]');
    if (e.target === name && name) name.style.width = `${Math.max(8, Math.min(40, name.value.length + 2))}ch`;
  });
  el.addEventListener('focusout', e => {
    const name = q<HTMLInputElement>('[data-name]');
    if (e.target === name && blockId && !readonly()) {
      try { setTitle(board.store, blockId, name!.value); } catch (err) { toast(err instanceof SheetError ? err.message : 'The name was not saved.', 'error'); }
    }
  });
  const onDocPointer = (e: Event) => {
    const t = e.target as HTMLElement;
    if (!t.closest?.('.vs-focus__menu-wrap')) { const m = q<HTMLElement>('[data-menu]'); if (m && !m.hidden) setMenu(null); }
    if (!t.closest?.('[data-tabpop], [data-tab-menu], [data-act="add-tab"]')) { const p = q<HTMLElement>('[data-tabpop]'); if (p && !p.hidden) p.hidden = true; }
  };
  document.addEventListener('pointerdown', onDocPointer, true);
  const onPhone = () => { if (!el.hidden) void mountView(); };
  phone.addEventListener('change', onPhone);

  function open(id: string, wantTab?: string): void {
    const y = sheetYBlock(board.store, id);
    if (!y) { toast('That sheet is not on this board any more.', 'error'); return; }
    if (!el.hidden && blockId === id) { if (wantTab) switchTab(wantTab); return; }
    if (!el.hidden) close();
    blockId = id;
    const tabs = readTabs(y);
    tabId = (wantTab && tabs.some(t => t.id === wantTab) ? wantTab : null)
      ?? (tabs.find(t => t.id === lastTab(id))?.id) ?? tabs[0]?.id ?? '';
    paint();
    el.hidden = false;
    leaveFocus?.();
    leaveFocus = enterFocusMode('sheet');
    paintTabs();
    void mountView();
    let queued = false;
    const onDeep = () => {
      if (queued) return; queued = true;
      requestAnimationFrame(() => { queued = false; if (!el.hidden) paintTabs(); });
    };
    y.observeDeep(onDeep);
    const onRole = () => { grid?.setReadonly(readonly()); cards?.setReadonly(readonly()); };
    window.addEventListener('collaboration-role', onRole);
    unobserve = () => { y.unobserveDeep(onDeep); window.removeEventListener('collaboration-role', onRole); };
    onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || ev.defaultPrevented) return;
      const t = ev.target as HTMLElement;
      if (t.closest?.('.vsg-pop, .vsg-modal, [data-editor], input, textarea:not([data-sink])')) return;
      const m = q<HTMLElement>('[data-menu]');
      if (m && !m.hidden) { setMenu(null); return; }
      close();
    };
    document.addEventListener('keydown', onKey);
    window.parent?.postMessage({ type: 'voidspace:board-sheet-opened', blockId: id }, '*');
  }

  function close(): void {
    if (el.hidden) return;
    grid?.destroy(); grid = null;
    cards?.destroy(); cards = null;
    unobserve?.(); unobserve = null;
    el.hidden = true;
    el.innerHTML = '';
    leaveFocus?.(); leaveFocus = null;
    if (onKey) document.removeEventListener('keydown', onKey);
    onKey = null;
    blockId = null;
  }

  const onOpen = (e: Event) => {
    const id = (e as CustomEvent).detail?.blockId;
    const tab = (e as CustomEvent).detail?.tab;
    if (typeof id === 'string') open(id, typeof tab === 'string' ? tab : undefined);
  };
  container.addEventListener('voidspace-open-sheet', onOpen);

  return {
    open, close,
    isOpen: () => !el.hidden,
    openId: () => (el.hidden ? null : blockId),
    destroy() {
      container.removeEventListener('voidspace-open-sheet', onOpen);
      document.removeEventListener('pointerdown', onDocPointer, true);
      phone.removeEventListener('change', onPhone);
      close();
      el.remove();
    },
  };
}
