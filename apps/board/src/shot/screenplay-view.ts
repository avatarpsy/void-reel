/**
 * The screenplay page, as ROWS — one description, two painters.
 *
 * The card on the canvas paints these with Lit; the focus overlay paints them
 * with plain DOM (chrome that sits over the editor never joins BlockSuite's
 * render cycle — see `ui/board-ui.ts`). Both must agree about what the page
 * SAYS, or the same script reads differently depending on which one you opened,
 * and the margin marks — the whole reason to look at the page while working —
 * stop being trustworthy.
 *
 * So: this module decides what the page says. The two painters decide only how
 * it looks, and they share the class names so the typography cannot drift
 * either.
 */
import type { BlockStdScope } from '@blocksuite/std';

import type { Element, ParsedScript } from './fountain';
import { boardCoverage } from './resolution';
import { readParsed, readScript } from './screenplay-doc';

export interface ScreenplayRow extends Element {
  /**
   * The MARGIN MARK for this line, or null when it carries none.
   *
   * Only scene headings get one: the number of shots covering that scene, or an
   * em dash for none. Drawn in the margin and never in the prose — the script
   * has to read as the script, not as a checklist.
   */
  mark: string | null;
  covered: boolean;
}

export interface ScreenplayView {
  script: ParsedScript;
  /** The raw Fountain, for the editor half. */
  text: string;
  rows: ScreenplayRow[];
  /** "3/8 scenes covered · 2 off-script", or '' when there is no script yet. */
  stat: string;
  /** Scenes covered by at least one shot. */
  covered: number;
}

export function screenplayView(std: BlockStdScope): ScreenplayView {
  const text = readScript(std);
  // Both memoised per document revision — see `board/doc-cache.ts`. This is
  // called from the card's render, which runs whenever any block changes.
  const script = readParsed(std);
  const cov = boardCoverage(std);
  const byKey = new Map(cov.scenes.map(s => [s.key, s] as const));

  // Which source line each scene heading sits on, so the mark lands on it.
  const markAtLine = new Map<number, { mark: string; covered: boolean }>();
  for (const scene of script.scenes) {
    const c = byKey.get(scene.key);
    markAtLine.set(scene.fromLine, {
      mark: c && c.shots > 0 ? `${c.shots}` : '—',
      covered: !!c && c.shots > 0,
    });
  }

  const covered = cov.scenes.filter(s => s.shots > 0).length;

  return {
    script,
    text,
    covered,
    rows: script.elements.map(e => {
      const m = markAtLine.get(e.line);
      return { ...e, mark: m ? m.mark : null, covered: !!m?.covered };
    }),
    stat: script.scenes.length
      ? `${covered}/${script.scenes.length} scenes covered${cov.offScript ? ` · ${cov.offScript} off-script` : ''}`
      : '',
  };
}

/** The class list for a row, shared so both painters style identically. */
export function rowClass(row: ScreenplayRow): string {
  return `el-${row.type}${row.mark !== null ? ' marker' : ''}`;
}
