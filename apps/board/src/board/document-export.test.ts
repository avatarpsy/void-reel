/**
 * Making a document here, and sharing one only when asked.
 *
 * The behaviour worth pinning is the split. A user pressing a button must
 * touch the network ZERO times — that is the whole point of typesetting on the
 * device — and an agent must get a URL, because a tool result cannot hand
 * somebody a file that exists only in their Downloads folder. Getting that
 * backwards is invisible in a screenshot and obvious in a bill.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@openreel/asset-browser', () => ({ defaultApiBase: () => 'https://api.test' }));

const getParentToken = vi.fn();
vi.mock('./parent-auth', () => ({ getParentToken: (force?: boolean) => getParentToken(force) }));

// No pictures are fetched in these documents; the module is mocked so the test
// never depends on the board's media proxy being reachable.
vi.mock('../document/images', () => ({ loadImages: async () => new Map() }));

import { makeDocument, saveDocument, uploadDocument } from './document-export';

function res(status: number, body: any = null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? '')),
  } as Response;
}

const MD = '# Report\n\nA paragraph with **bold** in it.\n\n- one\n- two\n';

beforeEach(() => {
  getParentToken.mockReset().mockResolvedValue('tok-1');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

async function magic(blob: Blob, n: number): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return String.fromCharCode(...bytes.subarray(0, n));
}

describe('makeDocument', () => {

/**
 * ── "NO REQUEST" MEANS NO DOCUMENT SERVICE, NOT NO FETCH ─────────────────────
 *
 * These used to assert `fetch` was never called, which said the right thing
 * until the renderer began embedding real fonts: it now loads its own bundled
 * woff2 files, and that is still the document being typeset ON THIS DEVICE.
 *
 * What the test is actually protecting is that no CONTENT leaves — nothing is
 * posted anywhere, nothing is rendered by a server. So it checks what was asked
 * for rather than whether anything was asked for at all.
 */
function assertOnlyLocalAssets(spy: any): void {
  for (const call of (spy?.mock?.calls ?? [])) {
    const url = String(call?.[0] ?? '');
    const init = call?.[1] ?? {};
    expect(String(init.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(url, `unexpected request to ${url}`).toMatch(/\.woff2?($|\?)|^blob:|^data:/);
  }
}

  it('produces a real PDF, here, with no request at all', async () => {
    const doc = await makeDocument(MD, 'Report', 'pdf');
    expect(await magic(doc.blob, 5)).toBe('%PDF-');
    expect(doc.fileName).toBe('Report.pdf');
    expect(doc.pages).toBeGreaterThanOrEqual(1);
    assertOnlyLocalAssets(globalThis.fetch);
  }, 30_000);

  /** A .docx is a zip — "PK" is the only signature that makes it openable. */
  it('produces a real Word file, here, with no request at all', async () => {
    const doc = await makeDocument(MD, 'Report', 'docx');
    expect(await magic(doc.blob, 2)).toBe('PK');
    expect(doc.fileName).toBe('Report.docx');
    assertOnlyLocalAssets(globalThis.fetch);
  }, 30_000);

  it('gives the .md source the title it would otherwise lack', async () => {
    const doc = await makeDocument('Body only.', 'Notes', 'md');
    expect(await doc.blob.text()).toBe('# Notes\n\nBody only.');
    const already = await makeDocument('# Notes\n\nBody.', 'Notes', 'md');
    expect(await already.blob.text()).toBe('# Notes\n\nBody.');
  });

  it('refuses an empty document before doing any work', async () => {
    await expect(makeDocument('   ', 'T', 'pdf')).rejects.toThrow(/nothing on this board/i);
  });

  /**
   * THE ONE THAT WOULD HAVE TAKEN THE FEATURE DOWN. pdf-lib's standard fonts
   * throw on anything outside cp1252, and users type arrows and emoji daily.
   */
  it('survives characters the PDF fonts cannot encode, and counts them', async () => {
    const doc = await makeDocument('Done ✓ revenue → ¥2m 🎉 日本語', 'Unicode', 'pdf');
    expect(await magic(doc.blob, 5)).toBe('%PDF-');
    expect(doc.droppedGlyphs).toBeGreaterThan(0);
  }, 30_000);

  it('does not report dropped glyphs for ordinary prose', async () => {
    const doc = await makeDocument('Plain ascii — with a dash and "quotes".', 'Plain', 'pdf');
    expect(doc.droppedGlyphs).toBe(0);
  }, 30_000);
});

describe('saveDocument', () => {
  it('puts the file on the disk and still never calls the server', async () => {
    const click = vi.fn();
    const a = { click, remove: vi.fn(), href: '', download: '', rel: '' } as any;
    const create = vi.spyOn(document, 'createElement').mockReturnValue(a);
    vi.spyOn(document.body, 'appendChild').mockImplementation((n: any) => n);
    // Patch the two STATICS rather than stubbing the global: replacing `URL`
    // with a plain object takes the constructor with it, and happy-dom needs
    // it the moment the download anchor is clicked.
    (URL as any).createObjectURL = () => 'blob:x';
    (URL as any).revokeObjectURL = () => {};

    await saveDocument(MD, 'Report', 'docx');

    expect(a.download).toBe('Report.docx');
    expect(click).toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    create.mockRestore();
    vi.restoreAllMocks();
  }, 30_000);
});

describe('uploadDocument — the ONLY path that touches the network', () => {
  const made = {
    blob: new Blob(['x'], { type: 'application/pdf' }),
    fileName: 'Report.pdf', format: 'pdf' as const, bytes: 1,
  };

  it('posts multipart to the store-only endpoint, and lets the browser set the boundary', async () => {
    (globalThis.fetch as any).mockResolvedValue(res(200, { ok: true, url: 'https://s.test/r.pdf' }));
    const out = await uploadDocument(made);

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.test/api/studio/upload-attachment');
    expect(init.body).toBeInstanceOf(FormData);
    // A hand-set Content-Type omits the boundary and the upload silently fails.
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(out.url).toBe('https://s.test/r.pdf');
  });

  /** A board left open past the token's ~1h life. One forced refresh, not a loop. */
  it('retries once with a fresh token on a 401', async () => {
    getParentToken.mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
    (globalThis.fetch as any)
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200, { url: 'u' }));
    await uploadDocument(made);
    expect(getParentToken).toHaveBeenNthCalledWith(2, true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry when there was never a token', async () => {
    getParentToken.mockResolvedValue(null);
    (globalThis.fetch as any).mockResolvedValue(res(401));
    await expect(uploadDocument(made)).rejects.toThrow(/sign in/i);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  /** "out of space" and "it broke" are different things to tell somebody. */
  it('passes the server\'s own words through for a storage failure', async () => {
    (globalThis.fetch as any).mockResolvedValue(res(507, 'You are out of space.'));
    await expect(uploadDocument(made)).rejects.toThrow('You are out of space.');
  });

  /** The file already exists locally, so the message must not say it was lost. */
  it('says the document is made even when the upload fails', async () => {
    (globalThis.fetch as any).mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(uploadDocument(made)).rejects.toThrow(/document is made/i);
  });

  it('treats a 200 with no link as a failure rather than a success', async () => {
    (globalThis.fetch as any).mockResolvedValue(res(200, { ok: true }));
    await expect(uploadDocument(made)).rejects.toThrow(/without a link/i);
  });
});
