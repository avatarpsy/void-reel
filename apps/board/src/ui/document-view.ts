/**
 * The board as a page — read it, then send it to somebody.
 *
 * ── WHY A MODE AND NOT A DOWNLOAD BUTTON ─────────────────────────────────────
 * The same reasoning as the screenplay's focus mode, which this deliberately
 * mirrors down to the class names. An export the user cannot SEE before it
 * leaves is an export they do not trust: the order came from where things sit
 * on an infinite canvas, so the first question anybody will have is "did it read
 * my board the way I meant it?". Showing the page answers that, and it makes a
 * wrong order fixable by dragging a frame rather than mysterious.
 *
 * The layout does not move — the left pane changes what it holds and the chat
 * stays exactly where it was on the right, because "reorder that section and
 * then give me the PDF" is one sentence.
 *
 * ── PDF THROUGH THE BROWSER'S OWN PIPELINE ───────────────────────────────────
 * No JS PDF builder, for the reason `screenplay-focus.ts` already worked out:
 * the page on screen is already the document, so a library would add a second,
 * worse implementation of a layout we have plus a megabyte of bundle. `@media
 * print` restates it in real inches and the browser paginates, which also gets
 * widow/orphan control and a paper size the user picks in the dialog.
 *
 * It opens the USER'S print dialog. It never saves a file, and every message
 * about it must say so.
 */
import { boardDocument, documentMarkdown, type BoardDocument } from '../board/document';
import { toast } from './toast';

import type { MountedBoard } from '../blocksuite/editor';

/**
 * Every action takes an optional title, and none of them require one.
 *
 * The board's name lives on the PARENT — it is the index row the Boards tab and
 * the chat header read, not anything inside the Yjs document — so the board app
 * cannot look it up. Passing it in with the action is the honest arrangement:
 * the caller that knows the name supplies it, and an untitled export is a
 * document with no `# heading`, not a document called "undefined".
 */
export interface DocumentView {
  open(title?: string): void;
  close(): void;
  isOpen(): boolean;
  /** The browser's print dialog — the user chooses "Save as PDF". */
  print(title?: string): void;
  downloadMarkdown(title?: string): void;
  /** The document as markdown, for a tool result or the clipboard. */
  markdown(title?: string): string;
  /** The sections, so a caller that must bound its output can cut at a section
   *  boundary rather than mid-sentence. */
  sections(): Array<{ title: string; chunks: string[] }>;
  /** Counts, for a tool result that has to say what it made. */
  summary(title?: string): { sections: number; words: number; omittedOwned: number; unframed: boolean };
  destroy(): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c
  ));
}

/**
 * Inline marks, as HTML.
 *
 * A GENERAL markdown parser would be the wrong tool: this renders markdown THIS
 * MODULE'S SIBLING GENERATED, whose vocabulary is exactly the six constructs
 * below. Pulling in a parser to handle syntax we never emit is bundle spent on
 * a problem we do not have — and a parser would also happily interpret a stray
 * underscore in the user's own prose, which this cannot.
 */
function inlineHtml(raw: string): string {
  let s = esc(raw);
  s = s.replace(/!\[\]\(([^)]*)\)/g, (_m, url) => `<img src="${url}" alt="" />`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

/** Block-level markdown → HTML, for the same bounded vocabulary. */
function blockHtml(md: string): string {
  const out: string[] = [];
  const listStack: Array<{ tag: 'ul' | 'ol'; indent: number }> = [];
  let quoting = false;

  const closeLists = (toIndent = -1) => {
    while (listStack.length && listStack[listStack.length - 1]!.indent > toIndent) {
      out.push(`</${listStack.pop()!.tag}>`);
    }
  };
  const closeQuote = () => { if (quoting) { out.push('</blockquote>'); quoting = false; } };

  for (const line of md.split('\n')) {
    const indent = (line.match(/^ */)?.[0].length ?? 0) / 2;
    const body = line.trim();

    if (!body) { closeLists(); closeQuote(); continue; }

    const heading = body.match(/^(#{1,6}) (.*)$/);
    if (heading) {
      closeLists(); closeQuote();
      const n = heading[1]!.length;
      out.push(`<h${n}>${inlineHtml(heading[2]!)}</h${n}>`);
      continue;
    }

    if (body === '---') { closeLists(); closeQuote(); out.push('<hr />'); continue; }

    const quote = body.match(/^> (.*)$/);
    if (quote) {
      closeLists();
      if (!quoting) { out.push('<blockquote>'); quoting = true; }
      out.push(`<p>${inlineHtml(quote[1]!)}</p>`);
      continue;
    }
    closeQuote();

    const item = body.match(/^(-|\d+\.) (.*)$/);
    if (item) {
      const tag: 'ul' | 'ol' = item[1] === '-' ? 'ul' : 'ol';
      closeLists(indent);
      const top = listStack[listStack.length - 1];
      if (!top || top.indent < indent) {
        out.push(`<${tag}>`);
        listStack.push({ tag, indent });
      }
      // A todo keeps its box, because an unticked box is information.
      const todo = item[2]!.match(/^\[([ x])\] (.*)$/);
      out.push(todo
        ? `<li class="todo"><input type="checkbox" disabled ${todo[1] === 'x' ? 'checked' : ''} />`
          + `${inlineHtml(todo[2]!)}</li>`
        : `<li>${inlineHtml(item[2]!)}</li>`);
      continue;
    }

    closeLists();
    // A line that is only an image becomes a figure rather than a paragraph, so
    // it can be centred and size-capped.
    const lone = body.match(/^!\[\]\(([^)]*)\)$/);
    out.push(lone ? `<figure><img src="${lone[1]}" alt="" /></figure>` : `<p>${inlineHtml(body)}</p>`);
  }

  closeLists();
  closeQuote();
  return out.join('\n');
}

export function installDocumentView(
  board: MountedBoard,
  container: HTMLElement,
): DocumentView {
  const el = document.createElement('div');
  // The SAME shell class as the screenplay's focus mode: identical chrome,
  // identical Esc behaviour, identical print unwrapping. Only the page inside
  // differs, which is the only thing that should.
  el.className = 'vs-focus vs-focus--doc';
  el.hidden = true;
  container.append(el);

  let onKey: ((e: KeyboardEvent) => void) | null = null;
  let docSub: { unsubscribe?: () => void } | null = null;
  let repaintTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last title supplied by a caller. Sticky, so the repaint that follows a
   *  board edit does not silently drop the heading the export was opened with. */
  let docTitle = '';

  const remember = (title?: string): void => {
    if (typeof title === 'string' && title.trim()) docTitle = title.trim();
  };

  const build = (): BoardDocument => boardDocument(board.std, docTitle);

  function wordsIn(doc: BoardDocument): number {
    return doc.sections
      .flatMap(s => s.chunks)
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
  }

  function render(): void {
    const doc = build();
    const words = wordsIn(doc);
    const empty = !doc.sections.some(s => s.chunks.length);

    /**
     * SAY WHERE THE ORDER CAME FROM.
     *
     * The single most likely complaint about this feature is "the sections are
     * in the wrong order", and the answer — it read your frames top-to-bottom,
     * then left-to-right — is not guessable from looking at the output. Stating
     * it turns a bug report into a drag.
     */
    const orderNote = doc.unframed
      ? 'No frames on this board, so everything is in the order it sits on the canvas — '
        + 'top to bottom. Draw a frame round a group to make it a section.'
      : 'Sections follow your frames, top to bottom then left to right. '
        + 'Drag a frame to reorder.';

    el.innerHTML = `
      <header class="vs-focus__bar">
        <button type="button" class="vs-focus__back" data-act="close" title="Back to the board (Esc)">
          ← Board
        </button>
        <div class="vs-focus__title">
          <strong>${esc(doc.title || 'Untitled document')}</strong>
          <span>${doc.sections.length} section${doc.sections.length === 1 ? '' : 's'} · ${words} words</span>
        </div>
        <div class="vs-focus__actions">
          <button type="button" class="vs-focus__btn" data-act="md"
                  title="Download the plain-text source — opens in Notion, Obsidian, Word, anything">
            .md
          </button>
          <button type="button" class="vs-focus__btn vs-focus__btn--primary" data-act="pdf"
                  title="Opens your print dialog — choose Save as PDF">
            Export PDF
          </button>
        </div>
      </header>

      <div class="vs-focus__scroll" data-page-scroll>
        ${empty
          ? `<div class="vs-focus__empty">
               <b>Nothing to put in a document yet.</b>
               <p>Notes, mind maps, shapes and pictures on the canvas become the document.
               Draw a <strong>frame</strong> round a group of them and its title becomes a
               heading. Ask the agent to lay your thinking out and it will appear here.</p>
             </div>`
          : `<article class="page vs-doc" data-page>
               ${doc.title ? `<h1 class="vs-doc__title">${esc(doc.title)}</h1>` : ''}
               ${doc.sections.map(s => `
                 <section class="vs-doc__section">
                   ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}
                   ${blockHtml(s.chunks.join('\n\n'))}
                 </section>`).join('')}
             </article>`}
      </div>

      <footer class="vs-focus__foot">
        <span>${esc(orderNote)}</span>
        <span>${doc.omittedOwned
          ? `${doc.omittedOwned} storyboard shot${doc.omittedOwned === 1 ? '' : 's'} not included — export those as a screenplay`
          : ''}</span>
      </footer>`;
  }

  // ── exporting ─────────────────────────────────────────────────────────────

  function exportPdf(title?: string): void {
    remember(title);
    const doc = build();
    if (!doc.sections.some(s => s.chunks.length)) {
      toast('There is nothing on the canvas to put in a document yet.', 'error');
      return;
    }
    if (el.hidden) open();

    // After the render that `open()` queued — printing a frame mid-render gives
    // a snapshot of the page on its way in. Guarded because this fires from a
    // rAF callback, where a throw is uncaught and points nowhere useful.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (typeof window.print === 'function') window.print();
    }));
  }

  function markdown(title?: string): string {
    remember(title);
    return documentMarkdown(build());
  }

  function downloadMarkdown(title?: string): void {
    remember(title);
    const doc = build();
    const text = documentMarkdown(doc);
    if (!doc.sections.some(s => s.chunks.length)) {
      toast('There is nothing on the canvas to put in a document yet.', 'error');
      return;
    }
    const name = (doc.title || 'board')
      .replace(/[^a-zA-Z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'board';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.md`;
    a.click();
    // Revoked next tick — immediately would race the download starting.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloaded ${name}.md`, 'info');
  }

  // ── input ─────────────────────────────────────────────────────────────────

  el.addEventListener('click', e => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') close();
    else if (act === 'pdf') exportPdf();
    else if (act === 'md') downloadMarkdown();
  });

  function open(title?: string): void {
    remember(title);
    if (!el.hidden) { render(); return; }
    render();
    el.hidden = false;
    document.documentElement.dataset.focusMode = 'document';

    /**
     * Repaint as the board changes underneath: the chat is still on screen so
     * the user can say "add a section about the budget", and a page that does
     * not move while the agent works reads as a broken export.
     *
     * DEBOUNCED. `blockUpdated` fires on every pointermove of a drag, so a
     * straight subscription rebuilds and re-renders the whole document on every
     * frame of every gesture — the same trap that made the board sluggish before
     * `doc-cache.ts` existed. 250ms is under the threshold where a repaint feels
     * disconnected from the edit that caused it, and far above a drag's frame
     * rate.
     */
    docSub = board.store.slots.blockUpdated.subscribe(() => {
      if (el.hidden) return;
      if (repaintTimer) clearTimeout(repaintTimer);
      repaintTimer = setTimeout(() => {
        repaintTimer = null;
        if (el.hidden) return;
        const scroll = el.querySelector<HTMLElement>('[data-page-scroll]')?.scrollTop ?? 0;
        render();
        const next = el.querySelector<HTMLElement>('[data-page-scroll]');
        if (next) next.scrollTop = scroll;
      }, 250);
    });

    onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey, true);
  }

  function close(): void {
    if (el.hidden) return;
    el.hidden = true;
    delete document.documentElement.dataset.focusMode;
    docSub?.unsubscribe?.();
    docSub = null;
    // A pending repaint would rebuild the document for a page nobody is looking
    // at, and on a remount would render into a torn-down overlay.
    if (repaintTimer) { clearTimeout(repaintTimer); repaintTimer = null; }
    if (onKey) document.removeEventListener('keydown', onKey, true);
    onKey = null;
  }

  const onOpen = () => open();
  container.addEventListener('voidspace-open-document', onOpen);

  return {
    open,
    close,
    isOpen: () => !el.hidden,
    print: exportPdf,
    downloadMarkdown,
    markdown,
    sections: () => build().sections,
    summary(title?: string) {
      remember(title);
      const doc = build();
      return {
        sections: doc.sections.length,
        words: wordsIn(doc),
        omittedOwned: doc.omittedOwned,
        unframed: doc.unframed,
      };
    },
    destroy() {
      container.removeEventListener('voidspace-open-document', onOpen);
      close();
      el.remove();
    },
  };
}
