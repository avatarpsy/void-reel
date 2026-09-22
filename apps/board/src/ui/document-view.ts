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
 * ── TWO WAYS OUT, AND THEY ARE NOT THE SAME PROMISE ──────────────────────────
 * `downloadFile` is the real one: it typesets an actual .docx or .pdf ON THIS
 * DEVICE and puts it on the user's disk. That is what the `Word` and `PDF`
 * buttons do, and no request is made at all — it works offline and costs the
 * user no storage.
 *
 * `print` is still here and still uses the browser's own pipeline, for the
 * reason `screenplay-focus.ts` worked out: the page on screen IS the document,
 * so `@media print` restates it in real inches and the browser paginates it
 * with the CSS the user is looking at. But it opens the USER'S print dialog and
 * SAVES NOTHING, so it cannot answer "send me the file" — which is why it is no
 * longer a button, only Ctrl+P and the agent's `print` action. Every message
 * about that path must still say a file was not saved.
 *
 * The typesetting lives in `../document`, not here and NOT on the server. It is
 * heavy work whose cost scales with how many people export at once, which is
 * the worst thing to put on a shared machine — and the browser already has the
 * fonts, the arithmetic and an idle CPU. The server is asked for one thing, on
 * one path: storing the finished bytes when an AGENT needs a URL.
 */
import { enterFocusMode } from './focus-lock';
import { boardDocument, documentMarkdown, type BoardDocument } from '../board/document';
import { toast } from './toast';
import { saveDocument, uploadDocument } from '../board/document-export';
import type { RenderedDocument } from '../document';

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
  /**
   * The browser's print dialog — the user chooses "Save as PDF", and NOTHING
   * is saved by us. For an actual file, `downloadFile`.
   */
  print(title?: string): void;
  /**
   * A real .docx or .pdf, typeset on this device and downloaded. The one action
   * here that produces a file somebody can email; resolves once it has.
   * Pass `upload` only from an agent, which needs a URL to report back.
   */
  downloadFile(
    format: 'pdf' | 'docx',
    title?: string,
    opts?: { upload?: boolean },
  ): Promise<RenderedDocument & { url?: string }>;
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

/** Released on close, so one definition of "a focus mode is open" holds
 *  for every mode — see `focus-lock.ts`. */
let leaveFocus: (() => void) | null = null;

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

  /**
   * What to call this when nobody passed a name.
   *
   * The board's name lives on the PARENT, so opening this from the board's own
   * bar supplies no title and the header read "Untitled document" over a page
   * whose first line plainly said what it was. Every other document tool falls
   * back to the first heading; so does this now, and only "a document with no
   * words in it at all" is genuinely untitled.
   */
  const titleOf = (doc: BoardDocument): string => {
    if (doc.title.trim()) return doc.title.trim();
    for (const section of doc.sections) {
      if (section.title.trim()) return section.title.trim();
      // The heading the markdown itself opens with, if the frame had no name.
      const heading = section.chunks.join('\n').match(/^\s*#{1,3}\s+(.+)$/m);
      if (heading?.[1]?.trim()) return heading[1].trim();
    }
    return '';
  };

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
          <strong>${esc(titleOf(doc) || 'Untitled document')}</strong>
          <span>${doc.sections.length} section${doc.sections.length === 1 ? '' : 's'} · ${words} words</span>
        </div>
        <!-- Three buttons, three different promises: the .md source, a real
             Word file, a real PDF. Printing is deliberately NOT one of them —
             the browser already offers Ctrl+P, and a control here that opens a
             dialog and saves nothing is what users mistook for an export.
             (No backticks in here: this sits inside a template literal.) -->
        <div class="vs-focus__actions">
          <span class="vs-focus__lead">Download</span>
          <button type="button" class="vs-focus__btn" data-act="md"
                  title="The plain-text source — for Notion, Obsidian or a repo">
            .md
          </button>
          <button type="button" class="vs-focus__btn" data-act="docx"
                  title="A real Word document you can edit and comment on">
            Word
          </button>
          <button type="button" class="vs-focus__btn vs-focus__btn--primary" data-act="pdf"
                  title="A real PDF — looks the same everywhere">
            PDF
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
               <!-- The SUPPLIED title only, never the derived one. The
                    fallback reads the document's own first heading, which is
                    the right name for the window and the file and the wrong
                    thing to print at the top of the page — that heading is
                    already on the page, so printing it too showed the name
                    twice. Only a title somebody actually gave us is content.
                    (No backticks in here: this sits inside a template literal.) -->
               ${doc.title.trim() ? `<h1 class="vs-doc__title">${esc(doc.title.trim())}</h1>` : ''}
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

  /**
   * A REAL FILE, typeset HERE.
   *
   * This is what `Export PDF` used to mean and did not do: it opened the print
   * dialog, which belongs to the browser, so nothing was saved unless the user
   * finished the job themselves and nothing existed for an agent to hand back.
   *
   * The markdown it renders is the FULL document — never the capped copy the
   * `markdown` agent action returns. A document silently missing its later
   * sections would look finished, which is the worst way to be wrong.
   *
   * `upload` is the one thing that touches the network, and only an AGENT sets
   * it: a tool result has to carry a URL. A user pressing a button gets the
   * file on their disk and is billed no storage for it.
   */
  let exporting = false;
  async function downloadFile(
    format: 'pdf' | 'docx',
    title?: string,
    opts: { upload?: boolean } = {},
  ): Promise<RenderedDocument & { url?: string }> {
    remember(title);
    const doc = build();
    if (!doc.sections.some(s => s.chunks.length)) {
      throw new Error('There is nothing on the canvas to put in a document yet.');
    }
    // One at a time. Double-clicking Word used to be free; it is now a second
    // full typesetting pass while the first is still running.
    if (exporting) throw new Error('A document is already being made — one moment.');
    exporting = true;
    const label = format === 'docx' ? 'Word document' : 'PDF';
    const buttons = el.querySelectorAll<HTMLButtonElement>('.vs-focus__btn');
    buttons.forEach(b => { b.disabled = true; });
    toast(`Making your ${label}…`, 'info');
    try {
      const out = await saveDocument(documentMarkdown(doc), titleOf(doc) || 'Document', format);
      const shared = opts.upload ? await uploadDocument(out) : out;
      toast(
        out.droppedGlyphs
          ? `${out.fileName} — ${out.droppedGlyphs} character${out.droppedGlyphs === 1 ? '' : 's'} `
            + '(emoji or non-Latin) could not be set in a PDF. Try Word for those.'
          : `Downloaded ${out.fileName}`,
        out.droppedGlyphs ? 'error' : 'info',
      );
      return shared;
    } catch (e: any) {
      toast(e?.message || `That ${label} could not be made.`, 'error');
      // Rethrown, not swallowed: the button already showed the message, and the
      // AGENT caller must not be told a file exists when none does.
      throw e;
    } finally {
      exporting = false;
      buttons.forEach(b => { b.disabled = false; });
    }
  }

  /** The browser's print dialog. Kept for the agent's `print` action and Ctrl+P. */
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
    const name = (titleOf(doc) || 'board')
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
    // `.catch` and not `void`: downloadFile RETHROWS so the agent caller cannot
    // be told a file exists when none does, and an unhandled rejection here
    // would surface as a console error for a failure the user already saw as a
    // toast.
    else if (act === 'pdf') downloadFile('pdf').catch(() => {});
    else if (act === 'docx') downloadFile('docx').catch(() => {});
    else if (act === 'md') downloadMarkdown();
  });

  function open(title?: string): void {
    remember(title);
    if (!el.hidden) { render(); return; }
    render();
    el.hidden = false;
    leaveFocus?.();
    // 'board-page', not 'document': this is the whole BOARD read as a page,
    // and `document-focus.ts` is one note. Both used to report 'document',
    // which made the attribute useless for telling them apart.
    leaveFocus = enterFocusMode('board-page');

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
    leaveFocus?.();
    leaveFocus = null;
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
    downloadFile,
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
