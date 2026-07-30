import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadGoogleFont } from './fonts-service';

/**
 * The webfont trap, pinned.
 *
 * A Google Fonts stylesheet only DECLARES @font-face rules. Browsers fetch the
 * actual font file lazily, when DOM layout needs it — and a <canvas> never
 * triggers that. So loading only the <link> left the canvas painting the
 * FALLBACK face forever: ask for Anton, get a serif, with no error anywhere and
 * a layer whose style.fontFamily says "Anton".
 *
 * `document.fonts.load()` is what actually fetches the file, so it must be part
 * of loading a font, not an optional extra at the call site.
 */
describe('loadGoogleFont', () => {
  let loadCalls: string[];

  beforeEach(() => {
    loadCalls = [];
    vi.stubGlobal('document', {
      querySelector: () => null,
      head: { appendChild: (el: any) => { setTimeout(() => el.onload?.(), 0); } },
      createElement: () => ({ rel: '', href: '', onload: null, onerror: null }),
      fonts: {
        load: (spec: string) => { loadCalls.push(spec); return Promise.resolve([]); },
      },
    });
  });

  it('fetches the font FILE, not just the stylesheet', async () => {
    await loadGoogleFont('Anton', ['400']);
    expect(loadCalls.length).toBeGreaterThan(0);
    expect(loadCalls.some((s) => s.includes('Anton'))).toBe(true);
  });

  it('requests every weight it declared in the stylesheet', async () => {
    await loadGoogleFont('Inter', ['400', '700']);
    expect(loadCalls.some((s) => s.startsWith('400 '))).toBe(true);
    expect(loadCalls.some((s) => s.startsWith('700 '))).toBe(true);
  });

  it('quotes the family so multi-word names parse as one font', async () => {
    // `600 16px Playfair Display` is invalid CSS shorthand and silently no-ops.
    await loadGoogleFont('Playfair Display', ['600']);
    expect(loadCalls.some((s) => s.includes('"Playfair Display"'))).toBe(true);
  });

  it('still resolves when a weight is unavailable', async () => {
    vi.stubGlobal('document', {
      querySelector: () => null,
      head: { appendChild: (el: any) => { setTimeout(() => el.onload?.(), 0); } },
      createElement: () => ({ rel: '', href: '', onload: null, onerror: null }),
      fonts: { load: () => Promise.reject(new Error('no such face')) },
    });
    // A missing weight must not fail the whole load — the family is still usable.
    await expect(loadGoogleFont('Anton', ['900'])).resolves.toBeUndefined();
  });
});
