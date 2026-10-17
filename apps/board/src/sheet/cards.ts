/**
 * The sheet on a phone — one card per row.
 *
 * A grid on a 390 px screen is a keyhole: two columns at a time and a keyboard
 * covering half of them. Under 640 px focus mode shows this instead: a tab
 * picker, a search box, and one card per row with its fields stacked. Tapping a
 * card opens it as a sheet from the bottom with a real input per field — the
 * phone's own date and time pickers, its own keyboard — saved as you go.
 */
import type { BlockStdScope } from '@blocksuite/std';
import { html, nothing, render, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import * as Y from 'yjs';

import { type CellValue, type DisplayRow, type SheetColumn, MULTI_SEPARATOR, cellText, formatDuration, readTabs } from './sheet-data';
import { SheetError, addRows, readTab, setCells, sheetYBlock, valueOf, type TabSnapshot } from './ops';
import { prettyDate } from './format';
import { toast } from '../ui/toast';

export class SheetCards {
  private host: HTMLElement;
  private std: BlockStdScope;
  private blockId: string;
  tabId: string;
  private readonly: boolean;
  private q = '';
  private openKey: string | null = null;
  private snap: TabSnapshot | null = null;
  private y: Y.Map<unknown> | null;
  private frame = 0;
  private cleanup: Array<() => void> = [];
  private onTab: (tabId: string) => void;

  constructor(host: HTMLElement, opts: { std: BlockStdScope; blockId: string; tabId: string; readonly: boolean; onTab: (tabId: string) => void }) {
    this.host = host; this.std = opts.std; this.blockId = opts.blockId; this.tabId = opts.tabId; this.readonly = opts.readonly; this.onTab = opts.onTab;
    host.classList.add('vsc');
    this.y = sheetYBlock(this.std.store, this.blockId);
    const repaint = () => this.schedule();
    this.y?.observeDeep(repaint);
    this.cleanup.push(() => this.y?.unobserveDeep(repaint));
    const sub = this.std.store.slots.blockUpdated.subscribe(e => { if ((e as { flavour?: string }).flavour === 'voidspace:shot') repaint(); });
    this.cleanup.push(() => sub.unsubscribe());
    this.renderNow();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.cleanup.forEach(f => f());
    render(nothing, this.host);
    this.host.classList.remove('vsc');
  }

  setTab(tabId: string): void { this.tabId = tabId; this.openKey = null; this.schedule(); }
  setReadonly(ro: boolean): void { this.readonly = ro; this.schedule(); }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.renderNow(); });
  }

  private value(row: DisplayRow, col: SheetColumn): CellValue {
    return this.y && this.snap ? valueOf(this.std, this.y, this.snap.tab, row, col) : null;
  }

  private write(row: DisplayRow, col: SheetColumn, value: unknown): void {
    if (this.readonly) return;
    try {
      const res = setCells(this.std, this.blockId, [{ row: row.key, col: col.id, value }]);
      const made = res.created[row.key];
      if (made && this.openKey === row.key) this.openKey = made;
    } catch (e) {
      toast(e instanceof SheetError ? e.message : 'That could not be saved.', 'error');
    }
  }

  private renderNow(): void {
    this.snap = readTab(this.std, this.blockId, this.tabId);
    render(this.view(), this.host);
  }

  private view(): TemplateResult {
    const tabs = this.y ? readTabs(this.y) : [];
    const snap = this.snap;
    const cols = (snap?.columns ?? []).filter(c => !c.hidden);
    const q = this.q.trim().toLowerCase();
    const rows = (snap?.rows ?? []).filter(r => !q || cols.some(c => cellText(this.value(r, c), c.type).toLowerCase().includes(q)));
    const titleCol = cols.find(c => c.type === 'text' || c.type === 'longtext') ?? cols[0];
    const open = this.openKey ? snap?.rows.find(r => r.key === this.openKey) : undefined;
    return html`
      <div class="vsc-top">
        ${tabs.length > 1 ? html`<select aria-label="Tab" @change=${(e: Event) => this.onTab((e.target as HTMLSelectElement).value)}>
          ${tabs.map(t => html`<option value=${t.id} ?selected=${t.id === this.tabId}>${t.name}</option>`)}</select>` : nothing}
        <input type="search" placeholder="Search" .value=${live(this.q)} @input=${(e: Event) => { this.q = (e.target as HTMLInputElement).value; this.schedule(); }} />
      </div>
      <div class="vsc-list">
        ${rows.length ? rows.map((r, i) => this.card(r, i, cols, titleCol)) : html`<div class="vsc-empty">
          ${q ? html`<b>No rows match.</b>` : html`<b>No rows yet.</b><span>Tap "Add row" to start.</span>`}</div>`}
      </div>
      ${this.readonly ? nothing : html`<button type="button" class="vsc-fab" @click=${() => this.addRow()}>+ Add row</button>`}
      ${open ? this.editor(open, cols) : nothing}`;
  }

  private card(r: DisplayRow, i: number, cols: SheetColumn[], titleCol: SheetColumn | undefined): TemplateResult {
    const title = titleCol ? cellText(this.value(r, titleCol), titleCol.type) : '';
    const fields = cols.filter(c => c !== titleCol).map(c => ({ c, v: this.value(r, c) })).filter(f => f.v !== null && f.v !== '').slice(0, 5);
    return html`<button type="button" class="vsc-card" @click=${() => { this.openKey = r.key; this.schedule(); }}>
      <span class="vsc-card__title"><span class="vsc-card__n">${i + 1}</span>${title || html`<span style="color:var(--vs-text-mute);font-weight:500">Untitled</span>`}${r.removed ? ' (shot removed)' : ''}</span>
      ${fields.map(f => html`<span class="vsc-card__field"><b>${f.c.name}</b><span>${this.show(f.c, f.v)}</span></span>`)}
    </button>`;
  }

  private show(c: SheetColumn, v: CellValue): TemplateResult | string {
    if (c.type === 'status') {
      const parts = c.multi ? String(v).split(/\s*,\s*/) : [String(v)];
      return html`${parts.map(p => html`<span class="vsg-chip" data-c=${c.options?.find(o => o.label === p)?.color ?? 'grey'}>${p}</span> `)}`;
    }
    if (c.type === 'date' && typeof v === 'string') return prettyDate(v);
    if (c.type === 'checkbox') return v === true ? 'Yes' : v === false ? 'No' : String(v);
    return cellText(v, c.type);
  }

  private addRow(): void {
    try {
      const [id] = addRows(this.std.store, this.blockId, this.tabId, 1);
      if (id) { this.openKey = id; this.schedule(); }
    } catch (e) { toast(e instanceof SheetError ? e.message : 'A row could not be added.', 'error'); }
  }

  private editor(row: DisplayRow, cols: SheetColumn[]): TemplateResult {
    const ro = this.readonly || !!row.removed;
    const close = () => { this.openKey = null; this.schedule(); };
    const field = (c: SheetColumn): TemplateResult => {
      const v = this.value(row, c);
      const label = html`<span>${c.name}</span>`;
      const commit = (val: unknown) => this.write(row, c, val);
      switch (c.type) {
        case 'checkbox':
          return html`<label class="vsc-field" style="flex-direction:row;align-items:center;gap:10px">
            <input type="checkbox" .checked=${live(v === true)} ?disabled=${ro} @change=${(e: Event) => commit((e.target as HTMLInputElement).checked)} />${label}</label>`;
        case 'status': {
          const chosen = new Set(String(v ?? '').split(/\s*,\s*/).filter(Boolean));
          return html`<div class="vsc-field">${label}<div class="vsc-choices">${(c.options ?? []).map(o => html`<button type="button" ?disabled=${ro}
              aria-pressed=${chosen.has(o.label) ? 'true' : 'false'}
              @click=${() => {
                if (c.multi) { if (chosen.has(o.label)) chosen.delete(o.label); else chosen.add(o.label); commit([...chosen].join(MULTI_SEPARATOR)); }
                else commit(chosen.has(o.label) ? null : o.label);
              }}><span class="vsg-chip" data-c=${o.color}>${o.label}</span></button>`)}</div></div>`;
        }
        case 'longtext':
          return html`<label class="vsc-field">${label}<textarea ?disabled=${ro} .value=${live(String(v ?? ''))} @change=${(e: Event) => commit((e.target as HTMLTextAreaElement).value)}></textarea></label>`;
        case 'date':
          return html`<label class="vsc-field">${label}<input type="date" ?disabled=${ro} .value=${live(/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : '')} @change=${(e: Event) => commit((e.target as HTMLInputElement).value || null)} /></label>`;
        case 'time':
          return html`<label class="vsc-field">${label}<input type="time" ?disabled=${ro} .value=${live(/^\d{2}:\d{2}$/.test(String(v ?? '')) ? String(v) : '')} @change=${(e: Event) => commit((e.target as HTMLInputElement).value || null)} /></label>`;
        case 'number':
          return html`<label class="vsc-field">${label}<input inputmode="decimal" ?disabled=${ro} .value=${live(v === null ? '' : String(v))} @change=${(e: Event) => commit((e.target as HTMLInputElement).value)} /></label>`;
        case 'duration':
          return html`<label class="vsc-field">${label}<input inputmode="numeric" placeholder="m:ss" ?disabled=${ro} .value=${live(typeof v === 'number' ? formatDuration(v) : String(v ?? ''))} @change=${(e: Event) => commit((e.target as HTMLInputElement).value)} /></label>`;
        case 'url': case 'media':
          return html`<label class="vsc-field">${label}<input type="url" inputmode="url" placeholder="https://" ?disabled=${ro} .value=${live(String(v ?? ''))} @change=${(e: Event) => commit((e.target as HTMLInputElement).value)} /></label>`;
        case 'link':
          return html`<div class="vsc-field">${label}<div>${cellText(v, c.type) || '—'}</div></div>`;
        default:
          return html`<label class="vsc-field">${label}<input ?disabled=${ro} .value=${live(String(v ?? ''))} @change=${(e: Event) => commit((e.target as HTMLInputElement).value)} /></label>`;
      }
    };
    return html`<div class="vsc-sheet-back" @click=${(e: Event) => { if (e.target === e.currentTarget) close(); }}>
      <div class="vsc-sheet" role="dialog" aria-label="Edit row">
        <div class="vsc-sheet__grab"></div>
        <div class="vsc-sheet__head"><b>${ro ? 'Row' : 'Edit row'}</b><button type="button" class="vsg-tool" @click=${close}>Done</button></div>
        ${row.removed ? html`<p class="vsc-note">This shot was removed from the board.</p>` : nothing}
        ${ro && !row.removed ? html`<p class="vsc-note">This board is open to view only.</p>` : nothing}
        ${cols.map(field)}
      </div>
    </div>`;
  }
}
