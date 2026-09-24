/**
 * What every line of the script IS — the one description the page is drawn from.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY PER SOURCE LINE
 * ══════════════════════════════════════════════════════════════════════════
 * The screenplay used to be drawn twice: a formatted page to read, and a plain
 * textarea to write in. They could not look alike — one indented dialogue and
 * centred the title, the other showed `Title:`, `##` and `=` flush left — so
 * every edit felt like opening a different document.
 *
 * Now one editor draws both, and it formats the SOURCE line by line, as you
 * type. That needs, for each line of the Fountain: what element it is, which
 * characters are syntax to hide, whether a scene heading has shots, and
 * whether a printed page begins there. This computes exactly that, and nothing
 * here touches the DOM, so it is tested directly.
 *
 * The page breaks come from `layoutScreenplay` — the function the PDF is set
 * by — so a hairline on screen is where the paper actually turns.
 */
import { parseFountain, type Element, type ParsedScript } from './fountain';
import { layoutScreenplay } from '../document/screenplay-pdf';

export interface PageLine {
  /** The Fountain element this line is, or 'blank'. */
  type: Element['type'];
  /** A title-page field's name — `title`, `credit`, `draft date`. */
  key?: string;
  /** For a scene heading: how many shots cover it, or an em dash for none. */
  mark?: string;
  covered?: boolean;
  /** Character ranges in the line that are Fountain syntax, not script. */
  syntax: Array<[number, number]>;
  /** The script page that begins at this line, when one does. */
  pageStart?: number;
}

export interface PageModel {
  script: ParsedScript;
  lines: PageLine[];
  /** Script pages, not counting the title page — a page runs about a minute. */
  pages: number;
  /** Notes (`[[…]]`) and the boneyard (`/* … *\/`), as offsets into the text. */
  hidden: Array<[number, number]>;
}

/** The syntax in a line, by what the line turned out to be. */
function syntaxOf(type: string, raw: string): Array<[number, number]> {
  const lead = (re: RegExp): Array<[number, number]> => {
    const m = re.exec(raw);
    return m && m[0].length ? [[0, m[0].length]] : [];
  };
  switch (type) {
    case 'title_field': return lead(/^\s*[^:]+:\s*/);
    case 'section': return lead(/^\s*#+\s*/);
    case 'synopsis': return lead(/^\s*=\s*/);
    case 'page_break': return raw.length ? [[0, raw.length]] : [];
    case 'scene_heading': return lead(/^\s*\.(?!\.)/);
    case 'character': return lead(/^\s*@/);
    case 'transition': return lead(/^\s*>\s*/);
    case 'centered': {
      const open = lead(/^\s*>\s*/);
      const close = /\s*<\s*$/.exec(raw);
      return close ? [...open, [close.index, raw.length]] : open;
    }
    default: return [];
  }
}

export function pageModel(text: string, shots: (key: string) => number = () => 0): PageModel {
  const source = String(text ?? '');
  const script = parseFountain(source);
  const raw = source.split('\n');

  const byLine = new Map<number, Element>();
  for (const el of script.elements) byLine.set(el.line, el);
  const sceneAt = new Map(script.scenes.map((s) => [s.fromLine, s] as const));

  const layout = layoutScreenplay(script.elements, { title: script.title, credit: script.credit });
  /**
   * The page turns straight after the last thing PRINTED on the page before —
   * not just above the first thing printed on the next. The lines between
   * (blank lines, a sequence heading, its synopsis) do not print, and they
   * lead INTO the next scene; drawn above the break, a sequence heading read
   * as part of the title page.
   */
  const unprinted = (i: number) => {
    const t = byLine.get(i)?.type ?? 'blank';
    return t === 'blank' || t === 'section' || t === 'synopsis' || t === 'page_break';
  };
  const starts = new Map<number, number>();
  for (const s of layout.starts) {
    // Page 1 needs a break only when a title page sits above it.
    if (s.page === 1 && !layout.title) continue;
    let at = s.line;
    while (at > 0 && unprinted(at - 1)) at--;
    starts.set(at, s.page);
  }

  const lines: PageLine[] = raw.map((line, i) => {
    const el = byLine.get(i);
    const type = el?.type ?? 'blank';
    const out: PageLine = { type, syntax: syntaxOf(type, line) };
    if (el?.key) out.key = el.key;
    if (type === 'scene_heading') {
      const scene = sceneAt.get(i);
      const n = scene ? shots(scene.key) : 0;
      out.mark = n > 0 ? String(n) : '—';
      out.covered = n > 0;
    }
    const page = starts.get(i);
    if (page !== undefined) out.pageStart = page;
    return out;
  });

  const hidden: Array<[number, number]> = [];
  for (const re of [/\/\*[\s\S]*?\*\//g, /\[\[[\s\S]*?\]\]/g]) {
    for (const m of source.matchAll(re)) hidden.push([m.index!, m.index! + m[0].length]);
  }

  return { script, lines, pages: script.empty ? 0 : layout.pages.length, hidden };
}
