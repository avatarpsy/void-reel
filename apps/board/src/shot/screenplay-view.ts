/**
 * What the screenplay says about itself — the facts every view of it shares.
 *
 * The page itself is drawn by ONE editor (`screenplay-editor.ts`), on the
 * canvas and in focus mode alike, from `screenplay-lines.ts`. What lives here
 * is the summary around it: the parsed script, the coverage line the tag and
 * the focus bar show, and how many shots each scene has, which is what the
 * margin marks count.
 */
import type { BlockStdScope } from '@blocksuite/std';

import { perRev } from '../board/doc-cache';
import type { ParsedScript } from './fountain';
import { boardCoverage } from './resolution';
import { readParsed, readScript } from './screenplay-doc';
import { readShots } from './shots';

export interface ScreenplayView {
  script: ParsedScript;
  /** The raw Fountain. */
  text: string;
  /** "3/8 scenes covered · 2 off-script", or '' when there is no script yet. */
  stat: string;
  /** Scenes covered by at least one shot. */
  covered: number;
}

export function screenplayView(std: BlockStdScope): ScreenplayView {
  // Both memoised per document revision — see `board/doc-cache.ts`. This is
  // called from renders that run whenever any block changes.
  const text = readScript(std);
  const script = readParsed(std);
  const cov = boardCoverage(std);
  const covered = cov.scenes.filter(s => s.shots > 0).length;
  return {
    script,
    text,
    covered,
    stat: script.scenes.length
      ? `${covered}/${script.scenes.length} scenes covered${cov.offScript ? ` · ${cov.offScript} off-script` : ''}`
      : '',
  };
}

/**
 * Shots per scene KEY, straight off the board.
 *
 * By key rather than by the saved script's scenes, because the page counts
 * coverage for the text being TYPED: a scene heading written a moment ago
 * already has its key, and if shots point at it the mark should say so before
 * the script has been saved.
 */
export function shotsByScene(std: BlockStdScope): Map<string, number> {
  return perRev(std, 'script:shots-by-scene', () => {
    const count = new Map<string, number>();
    for (const s of readShots(std)) {
      if (s.sceneKey) count.set(s.sceneKey, (count.get(s.sceneKey) ?? 0) + 1);
    }
    return count;
  });
}
