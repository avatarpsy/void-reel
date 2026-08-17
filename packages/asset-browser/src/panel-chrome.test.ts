/**
 * The panel-chrome contract, and the thing that keeps it true.
 *
 * `panel-chrome.ts` (here) and `packages/ui/src/components/panel-chrome.tsx`
 * are two renderings of ONE control: the board draws it as DOM, the video and
 * image editors draw it with React. They cannot share a module — `@openreel/ui`
 * is a leaf package and the board has no React — so the last test in this file
 * reads the React source and fails if the two stop agreeing. Without it, the
 * duplication is a promise; with it, it is a fact.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PANEL_GLYPH,
  PANEL_RAIL_PX,
  allPanelsToggleTitle,
  isTypingTarget,
  loadPanelCollapsed,
  panelGlyph,
  panelIconSvg,
  panelToggleTitle,
  savePanelCollapsed,
} from './panel-chrome';

describe('the glyph points where the panel is going', () => {
  it('offers to close when open and to open when closed', () => {
    // The button shows the ACTION, not the state — a left panel that is open
    // shows the chevron that pushes it left. Getting this backwards is the
    // single most common way this control ends up unreadable.
    expect(panelGlyph('left', false)).toBe('left-close');
    expect(panelGlyph('left', true)).toBe('left-open');
    expect(panelGlyph('right', false)).toBe('right-close');
    expect(panelGlyph('right', true)).toBe('right-open');
  });

  it('mirrors left and right rather than reusing one icon', () => {
    // A right-hand panel wearing the left-hand icon is how "consistent" turns
    // into "wrong": the chevron would point INTO the canvas it is meant to free.
    expect(PANEL_GLYPH['left-close']).not.toBe(PANEL_GLYPH['right-close']);
    expect(PANEL_GLYPH['left-close']).toContain('M9 3v18');
    expect(PANEL_GLYPH['right-close']).toContain('M15 3v18');
  });

  it('renders lucide-shaped svg at the size asked for', () => {
    const svg = panelIconSvg('left-close', 16);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('width="16"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="2"');
  });
});

describe('wording', () => {
  it('names the panel, not the direction', () => {
    // "Collapse left panel" makes the user work out which one that is. They
    // know what they want gone by name.
    expect(panelToggleTitle('Assets', false)).toBe('Hide Assets');
    expect(panelToggleTitle('Assets', true)).toBe('Show Assets');
  });

  it('advertises the keyboard route on the all-panels control', () => {
    expect(allPanelsToggleTitle(true)).toBe('Hide all panels (Tab)');
    expect(allPanelsToggleTitle(false)).toBe('Show all panels (Tab)');
  });
});

describe('Tab must never steal a keystroke from a field', () => {
  it('refuses inputs, textareas, selects and contenteditable', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const note = document.createElement('div');
    // BlockSuite's blocks are contenteditable divs — Tab indents a list there,
    // and a panel toggle that swallowed it would break note editing on the board.
    note.contentEditable = 'true';
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(select)).toBe(true);
    expect(isTypingTarget(note)).toBe(true);
  });

  it('allows plain elements and a null target', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('the choice is remembered per panel', () => {
  it('round-trips and defaults to open for a panel never touched', () => {
    localStorage.clear();
    // A first-time user must get the panel, not an empty rail.
    expect(loadPanelCollapsed('assets')).toBe(false);
    savePanelCollapsed('assets', true);
    expect(loadPanelCollapsed('assets')).toBe(true);
    savePanelCollapsed('assets', false);
    expect(loadPanelCollapsed('assets')).toBe(false);
  });

  it('keys by ROLE so surfaces sharing a panel share the preference', () => {
    // `assets` is the same panel to a user whether they are on the board or in
    // the image editor; shutting it in one and finding it open in the other is
    // exactly the inconsistency this whole file exists to remove.
    localStorage.clear();
    savePanelCollapsed('assets', true);
    expect(localStorage.getItem('voidspace.panels.assets.collapsed')).toBe('1');
    expect(loadPanelCollapsed('inspector')).toBe(false);
  });

  it('honours an explicit fallback for panels that start shut', () => {
    localStorage.clear();
    expect(loadPanelCollapsed('agent', true)).toBe(true);
  });
});

describe('the React half agrees with this one', () => {
  // Vitest runs with cwd at this package's root, so the sibling package is one
  // level up. A miss here must FAIL rather than skip — a parity test that
  // quietly disappears when a file moves is worse than no parity test.
  const react = readFileSync(
    resolve(process.cwd(), '../ui/src/components/panel-chrome.tsx'),
    'utf8',
  );

  it('uses the same rail width', () => {
    // A 44px rail on one editor and a 38px rail on the next is precisely the
    // "everything is nearly the same" feeling this work removes.
    const m = react.match(/export const PANEL_RAIL_PX = (\d+)/);
    expect(m?.[1]).toBeDefined();
    expect(Number(m![1])).toBe(PANEL_RAIL_PX);
  });

  it('uses the same four lucide icons', () => {
    for (const icon of ['PanelLeftClose', 'PanelLeftOpen', 'PanelRightClose', 'PanelRightOpen']) {
      expect(react).toContain(icon);
    }
  });

  it('words the tooltips the same way', () => {
    // The React button builds its label inline; this asserts the two producers
    // still emit the identical string for the identical state.
    expect(react).toContain('`${collapsed ? "Show" : "Hide"} ${name}`');
    expect(react).toContain('"Hide all panels (Tab)"');
  });
});
