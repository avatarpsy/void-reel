/**
 * The sheet on the canvas — a read-only preview card.
 *
 * Same rule as the screenplay card: the canvas shows the work, focus mode is
 * where it is edited. A virtualised, editable grid inside a zoomed canvas
 * breaks click targets and phone typing, so the card draws a plain table of
 * the active tab's first rows and nothing on it takes a key.
 *
 *   click          selects it; a drag moves it, like any object
 *   double-click   opens focus mode
 *   "Open sheet"   the same, on the card and in the board bar
 */
import { GfxBlockComponent } from '@blocksuite/std';
import { html, nothing } from 'lit';
import * as Y from 'yjs';

import type { SheetBlockModel } from './model';
import { cellText, readTabs, type SheetColumn } from './sheet-data';
import { readTab, sheetYBlock, valueOf } from './ops';
import { prettyDateShort } from './format';

const PREVIEW_ROWS = 12;

export function lastTab(blockId: string): string | null {
  try { return localStorage.getItem(`vs-sheet-tab:${blockId}`); } catch { return null; }
}
export function rememberTab(blockId: string, tabId: string): void {
  try { localStorage.setItem(`vs-sheet-tab:${blockId}`, tabId); } catch { /* per viewer only */ }
}

export function requestOpenSheet(from: EventTarget, blockId: string): void {
  from.dispatchEvent(new CustomEvent('voidspace-open-sheet', { bubbles: true, composed: true, detail: { blockId } }));
}

export class SheetBlockComponent extends GfxBlockComponent<SheetBlockModel> {
  private disposeDoc: (() => void) | null = null;
  private queued = false;

  override connectedCallback(): void {
    super.connectedCallback();
    const y = sheetYBlock(this.store, this.model.id);
    const repaint = () => {
      if (this.queued) return;
      this.queued = true;
      requestAnimationFrame(() => { this.queued = false; if (this.isConnected) this.requestUpdate(); });
    };
    y?.observeDeep(repaint);
    const sub = this.store.slots.blockUpdated.subscribe(e => {
      if ((e as { flavour?: string }).flavour === 'voidspace:shot') repaint();
    });
    const onTab = (e: Event) => { if ((e as CustomEvent).detail?.blockId === this.model.id) repaint(); };
    window.addEventListener('voidspace-sheet-tab', onTab);
    this.disposeDoc = () => { y?.unobserveDeep(repaint); sub.unsubscribe(); window.removeEventListener('voidspace-sheet-tab', onTab); };
  }

  override disconnectedCallback(): void {
    this.disposeDoc?.();
    this.disposeDoc = null;
    super.disconnectedCallback();
  }

  override renderGfxBlock() {
    const y = sheetYBlock(this.store, this.model.id);
    const tabs = y ? readTabs(y) : [];
    const remembered = lastTab(this.model.id);
    const tab = tabs.find(t => t.id === remembered) ?? tabs[0];
    const snap = tab ? readTab(this.std, this.model.id, tab.id) : null;
    const title = (y?.get('prop:title') as string) || 'Untitled sheet';
    const cols: SheetColumn[] = [];
    let width = 40;
    for (const c of snap?.columns ?? []) {
      if (c.hidden) continue;
      if (width > 960) break;
      cols.push(c); width += Math.min(c.width, 300);
    }
    const rows = snap?.rows.slice(0, PREVIEW_ROWS) ?? [];
    const total = snap?.rows.length ?? 0;
    const open = (e: Event) => { e.stopPropagation(); requestOpenSheet(this, this.model.id); };
    const cell = (row: (typeof rows)[number], c: SheetColumn) => {
      if (!y || !snap) return '';
      const v = valueOf(this.std, y as Y.Map<unknown>, snap.tab, row, c);
      if (v === null || v === '') return '';
      if (c.type === 'status') {
        const parts = c.multi ? String(v).split(/\s*,\s*/) : [String(v)];
        return html`${parts.slice(0, 3).map(p => html`<span class="vsg-chip" data-c=${c.options?.find(o => o.label === p)?.color ?? 'grey'}>${p}</span> `)}`;
      }
      if (c.type === 'checkbox') return v === true ? '✓' : '';
      if (c.type === 'date' && typeof v === 'string') return prettyDateShort(v);
      return cellText(v, c.type).split('\n')[0];
    };
    return html`<div class="vss-card" @dblclick=${open}>
      <div class="vss-head">
        <span class="vss-icon" aria-hidden="true">▦</span>
        <span class="vss-title">${title}</span>
        <span class="vss-meta">${total.toLocaleString('en')} row${total === 1 ? '' : 's'}${tabs.length > 1 ? ` · ${tabs.length} tabs` : ''}</span>
        <button type="button" class="vss-open" @pointerdown=${(e: Event) => e.stopPropagation()} @click=${open}>Open sheet</button>
      </div>
      ${tabs.length > 1 ? html`<div class="vss-tabs">${tabs.map(t => html`<span class="vss-tab ${t.id === tab?.id ? 'is-on' : ''}">${t.name}</span>`)}</div>` : nothing}
      <div class="vss-table">
        ${cols.length ? html`<table style="width:${width}px">
          <colgroup><col style="width:40px" />${cols.map(c => html`<col style="width:${Math.min(c.width, 300)}px" />`)}</colgroup>
          <thead><tr><th class="vss-n"></th>${cols.map(c => html`<th>${c.name}</th>`)}</tr></thead>
          <tbody>${rows.map((r, i) => html`<tr><td class="vss-n">${i + 1}</td>${cols.map(c => html`<td class=${c.type === 'number' || c.type === 'duration' ? 'is-num' : ''}>${cell(r, c)}</td>`)}</tr>`)}</tbody>
        </table>` : html`<div class="vss-empty">No columns yet.</div>`}
        ${!rows.length && cols.length ? html`<div class="vss-empty">No rows yet. Double-click to open the sheet.</div>` : nothing}
        ${total > PREVIEW_ROWS ? html`<div class="vss-fade"></div>` : nothing}
      </div>
      <div class="vss-foot"><span>${tab?.binding?.kind === 'shots' ? 'Linked to the shot cards on this board' : tab?.name ?? ''}</span>
        <span>${total > PREVIEW_ROWS ? `${(total - PREVIEW_ROWS).toLocaleString('en')} more` : ''}</span></div>
    </div>`;
  }
}
