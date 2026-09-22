/**
 * A RENDERING BENCH, not a test of anything.
 *
 * `VS_DOC_IN=<file.md> VS_DOC_OUT=<dir> npx vitest run src/document/eyeball`
 * typesets a real markdown file to PDF and Word where a human can open them.
 * It exists because the faults this feature has actually shipped — a logo the
 * size of a page, a heading over a masthead, text overprinting the line above —
 * are all invisible to an assertion and obvious to an eye.
 *
 * It does nothing at all without the environment variables, so it costs a
 * normal run one skipped test.
 */
import { describe, it, expect } from 'vitest';

import { renderDocument } from './index';

describe('eyeball', () => {
  it('typesets a file when asked to', async () => {
    const source = process.env.VS_DOC_IN;
    const dir = process.env.VS_DOC_OUT;
    if (!source || !dir) return;

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const markdown = await fs.readFile(source, 'utf8');
    const title = process.env.VS_DOC_TITLE || path.basename(source, '.md');

    for (const format of ['pdf', 'docx'] as const) {
      const out: any = await renderDocument({
        markdown,
        title,
        ...(process.env.VS_DOC_HEADER ? { header: process.env.VS_DOC_HEADER } : {}),
        ...(process.env.VS_DOC_FOOTER ? { footer: process.env.VS_DOC_FOOTER } : {}),
        ...(process.env.VS_DOC_MARGIN ? { margin: process.env.VS_DOC_MARGIN as any } : {}),
      }, format);
      const file = path.join(dir, `${title}.${format}`);
      await fs.writeFile(file, Buffer.from(await out.blob.arrayBuffer()));
      console.log(`EYEBALL ${file} pages=${out.pages ?? '-'} dropped=${out.droppedGlyphs ?? 0}`);
    }
    expect(true).toBe(true);
  }, 180_000);
});
