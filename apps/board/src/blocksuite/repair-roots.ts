import * as Y from 'yjs';

/** Older clients seeded an empty root before merging a saved cloud board.
 * BlockSuite renders one root but its gfx controller picks the first surface.
 * Consolidate containers before mounting, retaining every child and element. */
export function repairBoardRoots(doc: Y.Doc): number {
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const byFlavour = (flavour: string) => [...blocks].filter(([, b]) => b.get('sys:flavour') === flavour);
  const roots = byFlavour('affine:page');
  const surfaces = byFlavour('affine:surface');
  if (roots.length <= 1 && surfaces.length <= 1) return 0;
  const children = (b: Y.Map<unknown>) => (b.get('sys:children') as Y.Array<string>)?.toArray() || [];
  const weight = (id: string, visited = new Set<string>()): number => {
    if (visited.has(id)) return 0;
    visited.add(id); const b = blocks.get(id);
    return b ? 1 + children(b).reduce((n, c) => n + weight(c, visited), 0) : 0;
  };
  const ranked = (rows: [string, Y.Map<unknown>][]) => rows.sort((a, b) => weight(b[0]) - weight(a[0]) || a[0].localeCompare(b[0]));
  const identity = doc.getMap<string>('boardIdentity');
  const root = roots.find(([id]) => id === identity.get('pageId')) || ranked(roots)[0];
  const surface = surfaces.find(([id]) => id === identity.get('surfaceId')) || ranked(surfaces)[0];
  if (!root || !surface) throw new Error('The board has incomplete canvas containers. Its saved data has been kept.');
  const append = (to: Y.Map<unknown>, ids: string[]) => {
    const list = to.get('sys:children') as Y.Array<string>;
    const present = new Set(list.toArray());
    const extra = ids.filter(id => !present.has(id) && (present.add(id), true));
    if (extra.length) list.push(extra);
  };
  doc.transact(() => {
    identity.set('pageId', root[0]);
    identity.set('surfaceId', surface[0]);
    const discardedSurfaces = new Set(surfaces.filter(([id]) => id !== surface[0]).map(([id]) => id));
    for (const [id, s] of surfaces) {
      if (id === surface[0]) continue;
      append(surface[1], children(s));
      const from = (s.get('prop:elements') as Y.Map<unknown>)?.get('value') as Y.Map<unknown> | undefined;
      const into = (surface[1].get('prop:elements') as Y.Map<unknown>)?.get('value') as Y.Map<unknown> | undefined;
      if (from?.size && !into) throw new Error('Canvas elements could not be merged safely. Saved originals have been kept.');
      from?.forEach((value, key) => {
        if (!into!.has(key)) into!.set(key, value instanceof Y.AbstractType ? value.clone() : value);
      });
    }
    for (const [, r] of roots) append(root[1], children(r).filter(id => !discardedSurfaces.has(id)));
    append(root[1], [surface[0]]);
    const list = root[1].get('sys:children') as Y.Array<string>;
    for (let i = list.length - 1; i >= 0; i--) if (discardedSurfaces.has(list.get(i))) list.delete(i, 1);
    // Only container records are removed. Child blocks and original bytes stay.
    for (const [id] of surfaces) if (id !== surface[0]) blocks.delete(id);
    for (const [id] of roots) if (id !== root[0]) blocks.delete(id);
  }, 'repair-board-roots');
  return roots.length + surfaces.length - 2;
}
