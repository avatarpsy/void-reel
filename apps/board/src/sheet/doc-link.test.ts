import { describe, expect, it } from 'vitest';

import { docPath, docValue, parseDocValue, parseVoidspaceLink } from './doc-link';

describe('doc link values', () => {
  it('round-trips every form', () => {
    for (const ref of [
      { block: 'n1' },
      { block: 's1', tab: 't2' },
      { board: 'b9', block: 'n1' },
      { project: 'p7', block: 'n1', tab: 't1' },
    ]) expect(parseDocValue(docValue(ref))).toEqual(ref);
  });

  it('refuses what is not one', () => {
    expect(parseDocValue('shot:abc')).toBeNull();
    expect(parseDocValue('doc:')).toBeNull();
    expect(parseDocValue('doc:a b')).toBeNull();
    expect(parseDocValue(42)).toBeNull();
  });

  it('builds the page that opens it', () => {
    expect(docPath({ board: 'b9', block: 'n1', tab: 't' })).toBe('/ai/board?board=b9&open=n1&tab=t');
    expect(docPath({ project: 'p7', block: 'n1' })).toBe('/project/p7?open=n1');
    expect(docPath({ block: 'n1' })).toBeNull();
  });
});

describe('pasted links', () => {
  it('reads a board document link', () => {
    expect(parseVoidspaceLink('https://voidspace.ai/ai/board?board=b9&open=n1')).toEqual({ kind: 'doc', ref: { board: 'b9', block: 'n1' } });
    expect(parseVoidspaceLink('https://www.voidspace.ai/ai/board?board=b9&open=s1&tab=t2')).toEqual({ kind: 'doc', ref: { board: 'b9', block: 's1', tab: 't2' } });
  });

  it('reads a shared project link, edit link included', () => {
    expect(parseVoidspaceLink('https://voidspace.ai/project/p7/launch-film?open=n1#edit=abc')).toEqual({ kind: 'doc', ref: { project: 'p7', block: 'n1' } });
  });

  it('reads a plain board link as a board', () => {
    expect(parseVoidspaceLink('voidspace.ai/ai/board?board=b9')).toEqual({ kind: 'board', boardId: 'b9' });
  });

  it('accepts the page host for local builds only when told', () => {
    expect(parseVoidspaceLink('http://localhost:3091/ai/board?board=b9&open=n1')).toBeNull();
    expect(parseVoidspaceLink('http://localhost:3091/ai/board?board=b9&open=n1', 'localhost:3091')).toEqual({ kind: 'doc', ref: { board: 'b9', block: 'n1' } });
  });

  it('ignores other sites and plain words', () => {
    expect(parseVoidspaceLink('https://example.com/ai/board?board=b9&open=n1')).toBeNull();
    expect(parseVoidspaceLink('Episode 3 script')).toBeNull();
    expect(parseVoidspaceLink('https://voidspace.ai/pricing')).toBeNull();
  });
});
