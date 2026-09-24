import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import './mutation-rpc';
import { handleImageRpc } from './rpc';
import { useProjectStore, getProjectRev } from '../stores/project-store';
import { useHistoryStore } from '../stores/history-store';
import { useUIStore } from '../stores/ui-store';
import { forgetBlock } from '../services/composition/block-source';
import { needsRerender } from '../services/composition/hash';
import type { TextLayer, ShapeLayer, ImageLayer } from '../types/project';

const SIZE = { width: 1000, height: 1000 };

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

const project = () => useProjectStore.getState().project!;
const depth = () => useHistoryStore.getState().getUndoDepth();

async function newProject() {
  return rpc({ type: 'voidspace:img-new-project', width: SIZE.width, height: SIZE.height });
}

describe('img-new-project', () => {
  beforeEach(reset);

  it('creates a project at the requested size', async () => {
    const r = await newProject();
    expect(r.ok).toBe(true);
    expect(project().artboards[0].size).toEqual(SIZE);
  });
});

describe('img-add-text', () => {
  beforeEach(reset);

  it.each(['700', 'bold'])('normalizes CSS weight %s so the saved project can reopen', async (fontWeight) => {
    await newProject();
    const result = await rpc({ type: 'voidspace:img-add-text', text: 'Cover', fontWeight });
    expect(result.ok).toBe(true);
    const layer = project().layers[result.layerId] as TextLayer;
    expect(layer.style.fontWeight).toBe(700);
    const saved = JSON.parse(JSON.stringify(project()));
    reset();
    useProjectStore.getState().loadProject(saved);
    expect(project().layers[result.layerId]).toEqual(layer);
  });

  it('rejects an invalid font weight without leaving a half-created layer', async () => {
    await newProject();
    const before = project();
    const result = await rpc({ type: 'voidspace:img-add-text', text: 'Cover', fontWeight: 'heavy-ish' });
    expect(result.type).toBe('voidspace:error');
    expect(result.error).toContain('fontWeight');
    expect(project()).toEqual(before);
  });

  it('creates a styled text layer in ONE undo step', async () => {
    await newProject();
    const before = depth();
    const r = await rpc({
      type: 'voidspace:img-add-text',
      text: 'Summer Sale',
      fontFamily: 'Anton', fontSize: 120, fontWeight: 700, color: '#ff0000',
    });
    expect(r.ok).toBe(true);
    // Layer AND style together — not an unstyled layer plus a separate restyle.
    expect(depth()).toBe(before + 1);

    const layer = project().layers[r.layerId] as TextLayer;
    expect(layer.content).toBe('Summer Sale');
    expect(layer.style.fontFamily).toBe('Anton');
    expect(layer.style.fontSize).toBe(120);
    expect(layer.style.color).toBe('#ff0000');
  });

  it('one undo removes the whole thing', async () => {
    await newProject();
    const r = await rpc({ type: 'voidspace:img-add-text', text: 'Hello' });
    useProjectStore.getState().undo();
    expect(project().layers[r.layerId]).toBeUndefined();
  });

  it('align anchors to the page with a safe margin', async () => {
    await newProject();
    const r = await rpc({
      type: 'voidspace:img-add-text', text: 'Caption',
      align: 'bottom-center', width: 400, fontSize: 40,
    });
    const b = r.bounds;
    expect(b.x).toBe(Math.round((SIZE.width - 400) / 2)); // horizontally centred
    expect(b.y + b.height).toBeLessThan(SIZE.height);      // stays inside the page
    expect(b.y).toBeGreaterThan(SIZE.height / 2);          // sits in the lower half
  });

  it('sizes a multi-line block from its real line count', async () => {
    await newProject();
    const one = await rpc({ type: 'voidspace:img-add-text', text: 'One', fontSize: 100 });
    const three = await rpc({ type: 'voidspace:img-add-text', text: 'One\nTwo\nThree', fontSize: 100 });
    expect(three.bounds.height).toBeGreaterThan(one.bounds.height * 2);
  });

  it('refuses empty text rather than making an invisible layer', async () => {
    await newProject();
    const r = await rpc({ type: 'voidspace:img-add-text', text: '   ' });
    expect(r.type).toBe('voidspace:error');
  });
});

describe('img-add-shape', () => {
  beforeEach(reset);

  it('creates a styled shape in one step', async () => {
    await newProject();
    const before = depth();
    const r = await rpc({
      type: 'voidspace:img-add-shape', shapeType: 'rectangle',
      fill: '#000000', fillOpacity: 0.5, cornerRadius: 12,
      x: 0, y: 800, width: 1000, height: 200,
    });
    expect(r.ok).toBe(true);
    expect(depth()).toBe(before + 1);
    const layer = project().layers[r.layerId] as ShapeLayer;
    expect(layer.shapeType).toBe('rectangle');
    expect(layer.shapeStyle.fill).toBe('#000000');
    expect(layer.shapeStyle.fillOpacity).toBe(0.5);
  });
});

describe('img-edit-layer', () => {
  beforeEach(reset);

  it('patches only the fields sent', async () => {
    await newProject();
    const { layerId } = await rpc({ type: 'voidspace:img-add-text', text: 'Hi', fontSize: 80, color: '#ffffff' });
    await rpc({ type: 'voidspace:img-edit-layer', layerId, color: '#00ff00' });

    const layer = project().layers[layerId] as TextLayer;
    expect(layer.style.color).toBe('#00ff00');
    expect(layer.style.fontSize).toBe(80); // untouched
    expect(layer.content).toBe('Hi');      // untouched
  });

  it('replaces the copy without disturbing style', async () => {
    await newProject();
    const { layerId } = await rpc({ type: 'voidspace:img-add-text', text: 'Old', fontFamily: 'Lora' });
    await rpc({ type: 'voidspace:img-edit-layer', layerId, text: 'New words' });
    const layer = project().layers[layerId] as TextLayer;
    expect(layer.content).toBe('New words');
    expect(layer.style.fontFamily).toBe('Lora');
  });

  it('edits several layers in one undo step', async () => {
    await newProject();
    const a = await rpc({ type: 'voidspace:img-add-text', text: 'A' });
    const b = await rpc({ type: 'voidspace:img-add-text', text: 'B' });
    const before = depth();
    await rpc({ type: 'voidspace:img-edit-layer', layerIds: [a.layerId, b.layerId], opacity: 0.4 });
    expect(depth()).toBe(before + 1);
    expect(project().layers[a.layerId].transform.opacity).toBe(0.4);
    expect(project().layers[b.layerId].transform.opacity).toBe(0.4);
  });

  it('names unknown layer ids instead of failing silently', async () => {
    await newProject();
    const r = await rpc({ type: 'voidspace:img-edit-layer', layerId: 'nope', opacity: 0.5 });
    expect(r.type).toBe('voidspace:error');
    expect(String(r.error)).toContain('nope');
  });

  it('is refused when the canvas moved under it', async () => {
    await newProject();
    const { layerId } = await rpc({ type: 'voidspace:img-add-text', text: 'Hi' });
    const staleRev = getProjectRev();
    useProjectStore.getState().addTextLayer('user typed this');

    const r = await rpc({ type: 'voidspace:img-edit-layer', layerId, opacity: 0.2, expectRev: staleRev });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('canvas_changed');
    expect(project().layers[layerId].transform.opacity).not.toBe(0.2);
  });
});

describe('img-arrange', () => {
  beforeEach(reset);

  it('aligns to the page', async () => {
    await newProject();
    const { layerId } = await rpc({
      type: 'voidspace:img-add-shape', shapeType: 'rectangle',
      x: 0, y: 0, width: 200, height: 100,
    });
    await rpc({ type: 'voidspace:img-arrange', action: 'align', layerId, align: 'center middle' });
    const t = project().layers[layerId].transform;
    expect(t.x).toBe(Math.round((SIZE.width - 200) / 2));
    expect(t.y).toBe(Math.round((SIZE.height - 100) / 2));
  });

  it('deletes, and undo brings it back', async () => {
    await newProject();
    const { layerId } = await rpc({ type: 'voidspace:img-add-text', text: 'Doomed' });
    await rpc({ type: 'voidspace:img-arrange', action: 'delete', layerId });
    expect(project().layers[layerId]).toBeUndefined();
    useProjectStore.getState().undo();
    expect(project().layers[layerId]).toBeDefined();
  });

  it('groups several layers as one step', async () => {
    await newProject();
    const a = await rpc({ type: 'voidspace:img-add-text', text: 'A' });
    const b = await rpc({ type: 'voidspace:img-add-text', text: 'B' });
    const before = depth();
    const r = await rpc({ type: 'voidspace:img-arrange', action: 'group', layerIds: [a.layerId, b.layerId] });
    expect(r.ok).toBe(true);
    expect(depth()).toBe(before + 1);
  });

  it('rejects an unknown action by name', async () => {
    await newProject();
    const r = await rpc({ type: 'voidspace:img-arrange', action: 'teleport' });
    expect(r.type).toBe('voidspace:error');
    expect(String(r.error)).toContain('teleport');
  });
});

describe('img-page', () => {
  beforeEach(reset);

  it('adds a slide at the same size and selects it', async () => {
    await newProject();
    const r = await rpc({ type: 'voidspace:img-page', action: 'add' });
    expect(r.ok).toBe(true);
    expect(project().artboards).toHaveLength(2);
    expect(useProjectStore.getState().selectedArtboardId).toBe(r.pageId);
    expect(project().artboards[1].size).toEqual(SIZE);
  });

  it('refuses to remove the only page', async () => {
    await newProject();
    const r = await rpc({
      type: 'voidspace:img-page', action: 'remove',
      pageId: project().artboards[0].id,
    });
    expect(r.type).toBe('voidspace:error');
    expect(project().artboards).toHaveLength(1);
  });

  it('builds a carousel whose slides all stay the same size', async () => {
    await newProject();
    for (let i = 0; i < 3; i++) await rpc({ type: 'voidspace:img-page', action: 'add' });
    const sizes = project().artboards.map((a) => `${a.size.width}x${a.size.height}`);
    expect(new Set(sizes).size).toBe(1);
    expect(project().artboards).toHaveLength(4);
  });
});

describe('img-list-fonts', () => {
  beforeEach(reset);

  it('returns real families the agent can pass straight back', async () => {
    const r = await rpc({ type: 'voidspace:img-list-fonts' });
    expect(r.ok).toBe(true);
    const all = r.categories.flatMap((c: any) => c.fonts);
    expect(all).toContain('Inter');
    expect(all.length).toBeGreaterThan(10);
  });
});

describe('a whole poster is a sequence of single undo steps', () => {
  beforeEach(reset);

  it('builds, and unwinds one action at a time', async () => {
    await newProject();
    const start = depth();
    await rpc({
      type: 'voidspace:img-add-shape', shapeType: 'rectangle',
      fill: '#000000', fillOpacity: 0.55, x: 0, y: 700, width: 1000, height: 300,
    });
    await rpc({
      type: 'voidspace:img-add-text', text: 'BIG NEWS',
      align: 'bottom-center', fontSize: 90, color: '#ffffff',
    });
    await rpc({ type: 'voidspace:img-page', action: 'add' });

    expect(depth()).toBe(start + 3);
    for (let i = 0; i < 3; i++) useProjectStore.getState().undo();
    expect(depth()).toBe(start);
    expect(Object.keys(project().layers)).toHaveLength(0);
    expect(project().artboards).toHaveLength(1);
  });
});

describe('rearranging: order, duplication, removal', () => {
  beforeEach(reset);

  /** Top-to-bottom stacking order of the active page. */
  const order = () => {
    const ab = project().artboards.find((a) => a.id === useProjectStore.getState().selectedArtboardId)!;
    return ab.layerIds;
  };

  async function threeLayers() {
    await newProject();
    const a = await rpc({ type: 'voidspace:img-add-text', text: 'A' });
    const b = await rpc({ type: 'voidspace:img-add-text', text: 'B' });
    const c = await rpc({ type: 'voidspace:img-add-text', text: 'C' });
    return [a.layerId, b.layerId, c.layerId] as string[];
  }

  it('brings a layer to the front', async () => {
    const [a] = await threeLayers();
    await rpc({ type: 'voidspace:img-arrange', action: 'bring_to_front', layerId: a });
    expect(order()[0]).toBe(a);
  });

  it('sends a layer to the back', async () => {
    const ids = await threeLayers();
    const front = order()[0];
    await rpc({ type: 'voidspace:img-arrange', action: 'send_to_back', layerId: front });
    expect(order()[order().length - 1]).toBe(front);
    expect(order()).toHaveLength(ids.length);
  });

  it('steps one position at a time', async () => {
    await threeLayers();
    const before = [...order()];
    await rpc({ type: 'voidspace:img-arrange', action: 'send_backward', layerId: before[0] });
    expect(order()[1]).toBe(before[0]);
  });

  it('reordering is ONE undo step and reverses exactly', async () => {
    const [a] = await threeLayers();
    const before = [...order()];
    const d = depth();
    await rpc({ type: 'voidspace:img-arrange', action: 'bring_to_front', layerId: a });
    expect(depth()).toBe(d + 1);
    useProjectStore.getState().undo();
    expect(order()).toEqual(before);
  });

  it('duplicates and the copy is independent', async () => {
    await newProject();
    const src = await rpc({ type: 'voidspace:img-add-text', text: 'Original', color: '#ffffff' });
    const r = await rpc({ type: 'voidspace:img-arrange', action: 'duplicate', layerId: src.layerId });
    const copyId = r.layerIds[0];
    expect(copyId).not.toBe(src.layerId);

    await rpc({ type: 'voidspace:img-edit-layer', layerId: copyId, text: 'Copy' });
    expect((project().layers[src.layerId] as TextLayer).content).toBe('Original');
    expect((project().layers[copyId] as TextLayer).content).toBe('Copy');
  });

  it('removes several layers in ONE undo step', async () => {
    const [a, b] = await threeLayers();
    const d = depth();
    await rpc({ type: 'voidspace:img-arrange', action: 'delete', layerIds: [a, b] });
    expect(depth()).toBe(d + 1);
    expect(project().layers[a]).toBeUndefined();
    expect(project().layers[b]).toBeUndefined();

    useProjectStore.getState().undo();
    expect(project().layers[a]).toBeDefined();
    expect(project().layers[b]).toBeDefined();
  });

  it('moves a layer to an exact position', async () => {
    await newProject();
    const { layerId } = await rpc({ type: 'voidspace:img-add-shape', shapeType: 'ellipse', x: 0, y: 0, width: 100, height: 100 });
    await rpc({ type: 'voidspace:img-edit-layer', layerId, x: 250, y: 400 });
    const t = project().layers[layerId].transform;
    expect(t.x).toBe(250);
    expect(t.y).toBe(400);
  });

  it('resizes without disturbing position', async () => {
    await newProject();
    const { layerId } = await rpc({ type: 'voidspace:img-add-shape', shapeType: 'rectangle', x: 50, y: 60, width: 100, height: 100 });
    await rpc({ type: 'voidspace:img-edit-layer', layerId, width: 300, height: 40 });
    const t = project().layers[layerId].transform;
    expect([t.x, t.y, t.width, t.height]).toEqual([50, 60, 300, 40]);
  });

  it('a multi-layer edit reads each layer LIVE, not from a stale snapshot', async () => {
    // Two edits to the SAME layer in one call: the second must see the first.
    await newProject();
    const { layerId } = await rpc({ type: 'voidspace:img-add-text', text: 'X', fontSize: 40 });
    await rpc({ type: 'voidspace:img-edit-layer', layerIds: [layerId, layerId], color: '#123456', fontSize: 90 });
    const layer = project().layers[layerId] as TextLayer;
    expect(layer.style.color).toBe('#123456');
    expect(layer.style.fontSize).toBe(90);
  });
});

/**
 * The batch composer. What is worth asserting is not that it adds layers — the
 * single-layer paths already prove that — but the four properties that are the
 * whole reason it exists, and that a future refactor could silently lose.
 */
describe('img-compose-slide', () => {
  beforeEach(reset);

  it('builds a whole slide as ONE undo step', async () => {
    await newProject();
    const before = depth();
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      background: '#0b1020',
      elements: [
        { kind: 'shape', shapeType: 'rectangle', fill: '#000000', fillOpacity: 0.5 },
        { kind: 'text', text: 'The hook', fontSize: 120, color: '#ffffff', align: 'top-left' },
        { kind: 'text', text: 'One supporting line', fontSize: 40, align: 'bottom-left' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(3);
    // Three layers and a background change — but ONE press of Ctrl+Z undoes the
    // slide. That is the property; six entries would be the old behaviour.
    expect(depth()).toBe(before + 1);
  });

  it('undo removes the entire slide, not part of it', async () => {
    await newProject();
    const layersBefore = Object.keys(project().layers).length;
    await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [
        { kind: 'text', text: 'A' },
        { kind: 'text', text: 'B' },
        { kind: 'shape', shapeType: 'ellipse' },
      ],
    });
    expect(Object.keys(project().layers).length).toBe(layersBefore + 3);
    useProjectStore.getState().undo();
    expect(Object.keys(project().layers).length).toBe(layersBefore);
  });

  it('adds elements in stacking order — later ones sit on top', async () => {
    await newProject();
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [
        { kind: 'shape', shapeType: 'rectangle' },
        { kind: 'text', text: 'over the top' },
      ],
    });
    const page = project().artboards.find((a) => a.id === r.pageId)!;
    // NOTE THE CONVENTION: index 0 of layerIds is the TOP layer. Canvas draws
    // the array REVERSED (Canvas.tsx) and addLayer inserts at 0, so the LAST
    // element listed ends up FIRST in the array — which is exactly what "later
    // ones sit on top" means here. Asserting increasing indices would be
    // asserting the opposite, which is the mistake this comment exists to stop.
    const positions = r.layerIds.map((id: string) => page.layerIds.indexOf(id));
    expect(positions.every((p: number) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => b - a));
    // Stated bluntly so the intent survives a refactor of the convention:
    // the text was listed last, so the text is on top.
    expect(page.layerIds[0]).toBe(r.layerIds[1]);
  });

  it('newPage inherits the deck size, so slide 7 cannot be a different shape', async () => {
    await newProject();
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      newPage: true,
      name: 'Slide 2',
      elements: [{ kind: 'text', text: 'Second slide' }],
    });
    expect(r.ok).toBe(true);
    expect(project().artboards).toHaveLength(2);
    expect(r.size).toEqual(SIZE);
    expect(r.pageName).toBe('Slide 2');
  });

  it('refuses the WHOLE slide when one image cannot be resolved', async () => {
    await newProject();
    const layersBefore = Object.keys(project().layers).length;
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [
        { kind: 'text', text: 'Kept?' },
        { kind: 'image', assetId: 'does-not-exist' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('asset_not_found');
    // Names WHICH element failed — the agent can fix that one and resend.
    expect(r.message).toContain('element 1');
    // And nothing was committed: a half-built slide looks finished and is not.
    expect(Object.keys(project().layers).length).toBe(layersBefore);
  });

  it('honours the stale-read guard', async () => {
    await newProject();
    const staleRev = getProjectRev() - 1;
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      expectRev: staleRev,
      elements: [{ kind: 'text', text: 'should not land' }],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('canvas_changed');
  });

  it('refuses an unknown element kind rather than silently skipping it', async () => {
    await newProject();
    const r = await rpc({
      type: 'voidspace:img-compose-slide',
      elements: [{ kind: 'video', text: 'nope' }],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_request');
  });
});

/**
 * `img-place-image` used to hand-roll its transaction and, in doing so, dropped
 * the rev guard its own schema tells the agent to pass. This is the regression
 * test for that: the tool that says "pass expectRev — it is what stops you
 * overwriting an edit the user just made" must actually honour it.
 */
describe('img-place-image — the stale-read guard', () => {
  beforeEach(reset);

  it('refuses a placement computed from a stale read', async () => {
    await newProject();
    const r = await rpc({
      type: 'voidspace:img-place-image',
      assetId: 'anything',
      expectRev: getProjectRev() - 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('canvas_changed');
  });
});

/**
 * A composition is the opposite trade from `img-compose-slide`: the layout, the
 * type scale and the margins were designed by somebody who knew what they were
 * doing, and the agent supplies only the words. These pin the places where
 * supplying the words can go wrong QUIETLY — a slot name the block does not
 * have, the older `variables` vocabulary, and a render that does not exist.
 */
describe('img-place-composition', () => {
  const BLOCK_HTML = '<!DOCTYPE html><html><body>'
    + '<div data-composition-id="stat-punch" data-width="1080" data-height="1920">'
    + '<div class="headline">Sample headline</div></div></body></html>';

  const MANIFEST = {
    headline: { kind: 'text', sel: '.headline', sample: 'Sample headline' },
    subtitle: { kind: 'text', sel: '.subtitle', sample: 'Sample subtitle' },
    accent: { kind: 'color', var: '--accent' },
  };

  const realFetch = globalThis.fetch;

  /** Answer the blocks route for `name` and 404 for anything else, which is what
   *  a block that does not exist actually looks like. */
  function library(name: string, tier = 'starter') {
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.name !== name) return { ok: false, json: async () => ({ ok: false }) } as Response;
      return {
        ok: true,
        json: async () => ({ ok: true, name, tier, html: BLOCK_HTML, slots: MANIFEST }),
      } as Response;
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    reset();
    // The block loader caches by name for the life of the module, so each test
    // starts by forgetting the previous one's answer rather than inheriting it.
    forgetBlock('stat-punch');
  });

  afterEach(() => { globalThis.fetch = realFetch; });

  async function place(over: Record<string, unknown> = {}) {
    library('stat-punch');
    return rpc({
      type: 'voidspace:img-place-composition',
      block: 'stat-punch',
      slots: { headline: 'Reach by month' },
      ...over,
    });
  }

  it('places a composition in ONE undo step', async () => {
    await newProject();
    const before = depth();
    const r = await place();
    expect(r.ok).toBe(true);
    expect(depth()).toBe(before + 1);
  });

  it('lands as an IMAGE layer carrying its source, not a new layer type', async () => {
    // The load-bearing decision: z-order, opacity, masks and export all work
    // with no special cases precisely because this is an image layer.
    await newProject();
    const r = await place();
    const layer = project().layers[r.layerId] as ImageLayer;
    expect(layer.type).toBe('image');
    expect(layer.composition?.block).toBe('stat-punch');
    expect(layer.composition?.slots).toEqual({ headline: 'Reach by month' });
  });

  it('records the tier the block resolved from', async () => {
    // A user block can shadow a starter of the same name; without this, a later
    // render could resolve a different design under the same label.
    await newProject();
    library('stat-punch', 'user');
    const r = await rpc({ type: 'voidspace:img-place-composition', block: 'stat-punch' });
    expect((project().layers[r.layerId] as ImageLayer).composition?.tier).toBe('user');
  });

  it('leaves renderHash empty, because nothing has rendered it', async () => {
    // Stamping a current hash would tell needsRerender that pixels nobody has
    // made are up to date.
    await newProject();
    const r = await place();
    const layer = project().layers[r.layerId] as ImageLayer;
    expect(layer.composition?.renderHash).toBe('');
    expect(needsRerender(layer.composition!)).toBe(true);
  });

  it('is full-bleed by default, and lays the block out in the PAGE frame', async () => {
    await newProject();
    const r = await place();
    expect(r.bounds).toEqual({ x: 0, y: 0, width: SIZE.width, height: SIZE.height });
    const layer = project().layers[r.layerId] as ImageLayer;
    // Not the block's native 1080x1920. The frame is the decision the page makes
    // and the block follows it — that is the whole point of the override.
    expect(layer.composition?.frameWidth).toBe(SIZE.width);
    expect(layer.composition?.frameHeight).toBe(SIZE.height);
  });

  it('honours an explicit box and alignment', async () => {
    await newProject();
    const r = await place({ width: 400, height: 300, align: 'top-left', margin: 20 });
    expect(r.bounds).toEqual({ x: 20, y: 20, width: 400, height: 300 });
  });

  it('REFUSES `variables`, and says which word to use', async () => {
    // The board settled this vocabulary. Accepting it quietly would spread the
    // wrong word across two surfaces; ignoring it would drop the agent's content
    // on the floor with an `ok` in front of it.
    await newProject();
    library('stat-punch');
    const r = await rpc({
      type: 'voidspace:img-place-composition',
      block: 'stat-punch',
      variables: { headline: 'Reach by month' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_request');
    expect(r.message).toMatch(/slots/);
  });

  it('REFUSES a slot the block does not declare, and names the ones it has', async () => {
    // A slide committed with its headline missing looks finished and is not, and
    // the agent that got an `ok` has no reason to look.
    await newProject();
    const r = await place({ slots: { headlin: 'typo' } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown_slot');
    expect(r.message).toMatch(/headline, subtitle, accent/);
  });

  it('reports the slots nobody filled', async () => {
    await newProject();
    const r = await place();
    expect([...r.unfilled].sort()).toEqual(['accent', 'subtitle']);
  });

  it('refuses a block that cannot be loaded, leaving no undo entry', async () => {
    // The fetch happens before the transaction opens, so a bad name costs
    // nothing and leaves no empty step to press Ctrl+Z through.
    await newProject();
    const before = depth();
    library('something-else');
    const r = await rpc({ type: 'voidspace:img-place-composition', block: 'stat-punch' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('block_not_found');
    expect(depth()).toBe(before);
  });

  it('refuses a call that names neither a block nor html', async () => {
    await newProject();
    const r = await rpc({ type: 'voidspace:img-place-composition', slots: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_request');
  });

  it('takes authored html, which declares no slots to check against', async () => {
    await newProject();
    const r = await rpc({
      type: 'voidspace:img-place-composition',
      html: '<div data-composition-id="mine" data-width="1920" data-height="1080"></div>',
      slots: { anything: 'goes' },
    });
    expect(r.ok).toBe(true);
    const layer = project().layers[r.layerId] as ImageLayer;
    expect(layer.composition?.inlineHtml).toContain('data-composition-id="mine"');
    expect(layer.composition?.slots).toEqual({ anything: 'goes' });
  });

  it('drops a blank slot value rather than storing the blank', async () => {
    // Blank and absent render identically and key differently, so storing the
    // blank would give two identical slides two renders.
    await newProject();
    const r = await place({ slots: { headline: 'Reach', subtitle: '  ' } });
    expect((project().layers[r.layerId] as ImageLayer).composition?.slots)
      .toEqual({ headline: 'Reach' });
  });

  it('refuses a stale read, like every other mutation', async () => {
    await newProject();
    library('stat-punch');
    const r = await rpc({
      type: 'voidspace:img-place-composition',
      block: 'stat-punch',
      expectRev: getProjectRev() - 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('canvas_changed');
  });

  it('one undo takes the whole composition back off the page', async () => {
    await newProject();
    const r = await place();
    expect(project().layers[r.layerId]).toBeDefined();
    useProjectStore.getState().undo();
    expect(project().layers[r.layerId]).toBeUndefined();
  });

  /**
   * ── EDITING A PLACED BLOCK ────────────────────────────────────────────────
   * Changing one slot used to mean placing the block again, which is not the
   * same operation: every other slot has to be retyped from memory, anything
   * forgotten reverts to the sample or vanishes, and the slide arrives as a
   * second layer beside the first. Watched an agent spend fifteen minutes, two
   * renders and a vision call on a one-word change for exactly this reason.
   */
  describe('slot patch via img-edit-layer', () => {
    it('MERGES: a slot you do not name keeps its value', async () => {
      await newProject();
      const r = await place({ slots: { headline: 'Reach by month', subtitle: 'Since May' } });
      library('stat-punch');
      const e = await rpc({
        type: 'voidspace:img-edit-layer', layerId: r.layerId, slots: { headline: 'Reach by week' },
      });
      expect(e.ok).toBe(true);
      const layer = project().layers[r.layerId] as ImageLayer;
      expect(layer.composition?.slots).toEqual({ headline: 'Reach by week', subtitle: 'Since May' });
    });

    it('does not place a second layer', async () => {
      // The whole point: an edit edits, and the deck keeps one layer per slide.
      await newProject();
      const r = await place();
      const countBefore = Object.keys(project().layers).length;
      library('stat-punch');
      await rpc({ type: 'voidspace:img-edit-layer', layerId: r.layerId, slots: { subtitle: 'New' } });
      expect(Object.keys(project().layers).length).toBe(countBefore);
    });

    it('CLEARS a slot on empty, rather than storing a blank', async () => {
      // A stored "" would give a cleared slide and a slide that never had the
      // line two different render keys for the same picture.
      await newProject();
      const r = await place({ slots: { headline: 'Keep', subtitle: 'Drop me' } });
      library('stat-punch');
      await rpc({ type: 'voidspace:img-edit-layer', layerId: r.layerId, slots: { subtitle: '' } });
      const layer = project().layers[r.layerId] as ImageLayer;
      expect(layer.composition?.slots).toEqual({ headline: 'Keep' });
      expect('subtitle' in (layer.composition?.slots ?? {})).toBe(false);
    });

    it('restyles several slides in ONE undo step', async () => {
      await newProject();
      const a = await place();
      library('stat-punch');
      const b = await place();
      const before = depth();
      library('stat-punch');
      const e = await rpc({
        type: 'voidspace:img-edit-layer', layerIds: [a.layerId, b.layerId],
        slots: { accent: '#0066FF' },
      });
      expect(e.ok).toBe(true);
      expect(depth()).toBe(before + 1);
      for (const id of [a.layerId, b.layerId]) {
        expect((project().layers[id] as ImageLayer).composition?.slots.accent).toBe('#0066FF');
      }
    });

    it('refuses a slot the block does not declare, and names the ones it does', async () => {
      // Accepted-and-ignored is the worst outcome: the agent is told the edit
      // landed and then describes a slide that is not on screen.
      await newProject();
      const r = await place();
      library('stat-punch');
      const e = await rpc({
        type: 'voidspace:img-edit-layer', layerId: r.layerId, slots: { nope: 'x' },
      });
      expect(e.type).toBe('voidspace:error');
      expect(String(e.error)).toContain('nope');
      expect(String(e.error)).toContain('headline');
    });

    it('refuses slots on a layer that is not a placed block', async () => {
      await newProject();
      const t = await rpc({ type: 'voidspace:img-add-text', text: 'Hi' });
      const e = await rpc({
        type: 'voidspace:img-edit-layer', layerId: t.layerId, slots: { headline: 'x' },
      });
      expect(e.type).toBe('voidspace:error');
      expect(String(e.error)).toContain('placed block');
    });

    it('leaves an ordinary edit alone — no block fetch, no slot changes', async () => {
      // The common edit must not pay for a manifest lookup, so `fetch` is left
      // pointing at nothing: reaching for it here would throw.
      await newProject();
      const r = await place({ slots: { headline: 'Keep me' } });
      globalThis.fetch = (() => { throw new Error('should not fetch'); }) as unknown as typeof fetch;
      const e = await rpc({ type: 'voidspace:img-edit-layer', layerId: r.layerId, opacity: 0.5 });
      expect(e.ok).toBe(true);
      const layer = project().layers[r.layerId] as ImageLayer;
      expect(layer.transform.opacity).toBe(0.5);
      expect(layer.composition?.slots).toEqual({ headline: 'Keep me' });
    });
  });
});
