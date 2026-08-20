/**
 * Text boxes must be sized by MEASURING the wrapped text, not by counting the
 * newlines someone typed.
 *
 * The bug this pins shipped a deck. A slide read "A DIGITAL YOU" while its layer
 * held "A DIGITAL YOU\nTHAT NEVER CLOCKS OFF"; another read "THE PRESENCE THAT
 * NEVER". The height came from `content.split('\n').length`, so a headline that
 * WRAPPED — as a 150px headline in an 86%-wide box does — got a box tall enough
 * for the lines that were typed and nothing more. Everything past that was cut.
 *
 * It reads as an agent that cannot finish a sentence. It was a box that could
 * not measure one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import './mutation-rpc';
import { handleImageRpc } from './rpc';
import { useProjectStore } from '../stores/project-store';
import { useHistoryStore } from '../stores/history-store';
import { useUIStore } from '../stores/ui-store';
import type { TextLayer } from '../types/project';

const W = 1920;
const H = 1080;

/** Deterministic metrics: every glyph is 0.5em wide. Real enough to wrap, and
 *  it makes the expected line count arithmetic rather than a guess. */
const CHAR_EM = 0.5;
let realGetContext: any;

function installFakeCanvas() {
  realGetContext = HTMLCanvasElement.prototype.getContext;
  (HTMLCanvasElement.prototype as any).getContext = function (kind: string) {
    if (kind !== '2d') return null;
    let fontSize = 16;
    return {
      set font(v: string) { fontSize = parseFloat(/(\d+(?:\.\d+)?)px/.exec(v)?.[1] ?? '16'); },
      get font() { return `${fontSize}px sans-serif`; },
      textBaseline: 'alphabetic',
      measureText: (t: string) => ({
        width: t.length * fontSize * CHAR_EM,
        actualBoundingBoxAscent: fontSize * 0.8,
        actualBoundingBoxDescent: fontSize * 0.2,
      }),
    };
  };
}

function reset() {
  useHistoryStore.setState({
    undoStack: [], redoStack: [], baseProject: null, maxSize: 50,
    snapshots: [], mergeBarrierAt: 0, evictedCount: 0,
  });
  useProjectStore.setState({
    project: null, selectedLayerIds: [], selectedArtboardId: null,
    copiedLayers: [], copiedStyle: null, isDirty: false,
  });
  useUIStore.setState({ flattenedProjectId: null, editSource: null });
}

async function rpc(msg: Record<string, unknown>): Promise<any> {
  let reply: any = null;
  await handleImageRpc({ requestId: 'r', ...msg }, (p) => { reply = p; });
  return reply;
}

const layers = () => Object.values(useProjectStore.getState().project!.layers);
const textLayers = () => layers().filter((l: any) => l.type === 'text') as TextLayer[];

beforeEach(async () => {
  reset();
  installFakeCanvas();
  await rpc({ type: 'voidspace:img-new-project', width: W, height: H });
});
afterEach(() => {
  if (realGetContext) (HTMLCanvasElement.prototype as any).getContext = realGetContext;
});

describe('text is wrapped to fit the box it is given', () => {
  // The renderer draws `content.split('\n')` and nothing else — no wrapping. So
  // 'fits' means the stored text already contains the breaks, and every line is
  // narrower than the box. Anything else runs past the artboard and is cut there.
  const widthOf = (line: string, fontSize: number) => line.length * fontSize * CHAR_EM;

  it('breaks a long headline into lines that fit, instead of letting it run off the page', async () => {
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [{ kind: 'text', text: 'A DIGITAL YOU THAT NEVER CLOCKS OFF', fontSize: 120, lineHeight: 1.2, width: 900, x: 100, y: 100 }],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const layer = textLayers()[0];
    const lines = layer.content.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(widthOf(line, layer.style.fontSize)).toBeLessThanOrEqual(layer.transform.width + 1);
    }
    // and no word was lost on the way
    expect(layer.content.replace(/\s+/g, ' ')).toBe('A DIGITAL YOU THAT NEVER CLOCKS OFF');
  });

  it('gives the box room for every line it wrapped to', async () => {
    await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [{ kind: 'text', text: 'A DIGITAL YOU THAT NEVER CLOCKS OFF', fontSize: 120, lineHeight: 1.2, width: 900, x: 100, y: 100 }],
    });
    const layer = textLayers()[0];
    const lines = layer.content.split('\n').length;
    expect(layer.transform.height).toBeGreaterThanOrEqual(Math.ceil(120 * 1.2 * lines));
  });

  it('shrinks the type when a single word cannot be broken to fit', async () => {
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [{ kind: 'text', text: 'INCOMPREHENSIBILITIES', fontSize: 200, lineHeight: 1.2, width: 600, x: 0, y: 0 }],
    });
    expect(r.ok).toBe(true);
    const layer = textLayers()[0];
    expect(layer.style.fontSize).toBeLessThan(200);
    expect(widthOf(layer.content, layer.style.fontSize)).toBeLessThanOrEqual(600 + 1);
    expect((r.warnings ?? []).join(' ')).toMatch(/stepped down/);
  });

  it('leaves text that already fits completely alone', async () => {
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [{ kind: 'text', text: 'MEET', fontSize: 40, lineHeight: 1.2, width: 900, height: 400, x: 100, y: 100 }],
    });
    expect(r.ok).toBe(true);
    const layer = textLayers()[0];
    expect(layer.content).toBe('MEET');
    expect(layer.style.fontSize).toBe(40);
    expect(layer.transform.height).toBe(400);
  });

  it('keeps line breaks the caller typed', async () => {
    await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [{ kind: 'text', text: 'ONE\nTWO\nTHREE', fontSize: 40, lineHeight: 1.2, width: 1600, x: 100, y: 100 }],
    });
    const layer = textLayers()[0];
    expect(layer.content).toBe('ONE\nTWO\nTHREE');
    expect(layer.transform.height).toBeGreaterThanOrEqual(Math.ceil(40 * 1.2 * 3));
  });

  it('applies to img_add_text too — the same flaw lived in both paths', async () => {
    const page = useProjectStore.getState().project!.artboards[0];
    const r = await rpc({
      type: 'voidspace:img-add-text',
      pageId: page.id,
      text: 'A DIGITAL YOU THAT NEVER CLOCKS OFF',
      fontSize: 120, lineHeight: 1.2, width: 900, x: 100, y: 100,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const layer = textLayers()[0];
    expect(layer.content.split('\n').length).toBeGreaterThan(1);
    for (const line of layer.content.split('\n')) {
      expect(widthOf(line, layer.style.fontSize)).toBeLessThanOrEqual(layer.transform.width + 1);
    }
  });

  it('leaves the text untouched when there is no canvas to measure with', async () => {
    (HTMLCanvasElement.prototype as any).getContext = () => null;
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [{ kind: 'text', text: 'ONE\nTWO', fontSize: 40, lineHeight: 1.2, width: 900, x: 10, y: 10 }],
    });
    expect(r.ok).toBe(true);
    const layer = textLayers()[0];
    expect(layer.content).toBe('ONE\nTWO');
    expect(layer.transform.height).toBeGreaterThanOrEqual(Math.ceil(40 * 1.2 * 2));
  });
});

/**
 * Overlap is the failure that the wrap fix creates, so it ships with it.
 *
 * A caller places a subline "below the headline" using the y it expects the
 * headline to end at. Once the headline wraps to three lines, that y is inside
 * it, and the slide renders two sentences printed over each other. The caller
 * cannot predict the wrap, so the tool has to say.
 */
describe('overlapping text is reported back', () => {
  it('names both layers and how far they overlap', async () => {
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [
        { kind: 'text', text: 'A DIGITAL YOU THAT NEVER CLOCKS OFF', fontSize: 120, lineHeight: 1.2, width: 900, x: 100, y: 100 },
        { kind: 'text', text: 'Psy is already awake when you are.', fontSize: 30, lineHeight: 1.2, width: 900, x: 100, y: 260 },
      ],
    });
    expect(r.ok).toBe(true);
    const w = (r.warnings ?? []).join(' ');
    expect(w).toMatch(/overlap/i);
    // The label is the first WRAPPED line, which is what the user sees on the slide.
    expect(w).toMatch(/A DIGITAL YOU/);
  });

  it('stays quiet when the layers are clear of each other', async () => {
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [
        { kind: 'text', text: 'MEET', fontSize: 40, lineHeight: 1.2, width: 400, x: 100, y: 100 },
        { kind: 'text', text: 'PSY', fontSize: 40, lineHeight: 1.2, width: 400, x: 100, y: 600 },
      ],
    });
    expect(r.ok).toBe(true);
    expect((r.warnings ?? []).join(' ')).not.toMatch(/overlap/i);
  });
});
