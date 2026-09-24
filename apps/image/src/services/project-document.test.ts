import { expect, it } from 'vitest';
import { compactProjectDocument } from './project-document';
import type { Project } from '../types/project';

it('saves current and hidden artwork without carrying discarded render assets or changing undo state', () => {
  const project = { id: 'draft', layers: {
    current: { type: 'image', sourceId: 'current', visible: true },
    hidden: { type: 'image', sourceId: 'reference', visible: false },
    text: { type: 'text', content: 'Editable headline' },
  }, assets: { current: { dataUrl: 'pixels' }, reference: { dataUrl: 'reference pixels' }, discarded: { dataUrl: 'old large render' } } } as unknown as Project;
  const saved = compactProjectDocument(project);
  expect(Object.keys(saved.assets)).toEqual(['current', 'reference']);
  expect(saved.layers).toBe(project.layers);
  expect(Object.keys(project.assets)).toEqual(['current', 'reference', 'discarded']);
});
