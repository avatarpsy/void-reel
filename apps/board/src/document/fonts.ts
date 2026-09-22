/**
 * REAL FONTS IN THE PDF, instead of the fourteen the format was born with.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACES — NOT A MISSING FEATURE, DATA LOSS
 * ══════════════════════════════════════════════════════════════════════════
 * pdf-lib's `StandardFonts` are the PDF base-14 — Helvetica, Times, Courier —
 * and they can only be encoded as WinAnsi: 224 characters of Western Europe.
 * Everything else was transliterated where possible and DROPPED where not, and
 * the exporter counted the casualties so the caller could apologise for them.
 *
 * What fell out of documents was not exotic. The rupee sign. A Polish or Turkish
 * name. Greek in a formula. Any Hindi at all. For a company in Hyderabad writing
 * to Indian customers, "your PDF cannot contain your own language" is not a
 * limitation, it is a product that does not work.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SUBSETS, FETCHED ONLY WHEN THE TEXT NEEDS THEM
 * ══════════════════════════════════════════════════════════════════════════
 * Noto is published per script, which is exactly the shape this wants: a
 * document in English fetches two small files, one with a Hindi paragraph
 * fetches Devanagari as well, and a board that never exports a PDF downloads no
 * fonts at all — every import here is a URL resolved at render time.
 *
 * `@pdf-lib/fontkit` reads WOFF2 directly (verified against these exact files),
 * so the compressed web font is what gets embedded; pdf-lib then subsets it
 * again to the glyphs actually used, which is why a document backed by a full
 * Unicode family still weighs a couple of hundred kilobytes.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ONE FONT CANNOT SET EVERY SCRIPT, SO THE PIECES CHOOSE
 * ══════════════════════════════════════════════════════════════════════════
 * A PDF text operation draws with ONE font, so mixed text has to be cut into
 * runs that each have a face able to set them. `pick` answers that per
 * character and `layout` in pdf.ts does the cutting. A character no loaded face
 * can set is still REPORTED rather than silently removed — the difference
 * between a known gap and a lie.
 */
import type { PDFDocument, PDFFont } from 'pdf-lib';

/** Sans — Noto Sans. */
import sansLatin400 from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url';
import sansLatin700 from '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff?url';
import sansLatin400i from '@fontsource/noto-sans/files/noto-sans-latin-400-italic.woff?url';
import sansLatin700i from '@fontsource/noto-sans/files/noto-sans-latin-700-italic.woff?url';
import sansLatinExt400 from '@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff?url';
import sansLatinExt700 from '@fontsource/noto-sans/files/noto-sans-latin-ext-700-normal.woff?url';
import sansCyr400 from '@fontsource/noto-sans/files/noto-sans-cyrillic-400-normal.woff?url';
import sansGreek400 from '@fontsource/noto-sans/files/noto-sans-greek-400-normal.woff?url';
import sansDeva400 from '@fontsource/noto-sans/files/noto-sans-devanagari-400-normal.woff?url';
import sansDeva700 from '@fontsource/noto-sans/files/noto-sans-devanagari-700-normal.woff?url';
import sansViet400 from '@fontsource/noto-sans/files/noto-sans-vietnamese-400-normal.woff?url';

/** Serif — Noto Serif, for the scripts it ships. */
import serifLatin400 from '@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff?url';
import serifLatin700 from '@fontsource/noto-serif/files/noto-serif-latin-700-normal.woff?url';
import serifLatin400i from '@fontsource/noto-serif/files/noto-serif-latin-400-italic.woff?url';
import serifLatin700i from '@fontsource/noto-serif/files/noto-serif-latin-700-italic.woff?url';
import serifLatinExt400 from '@fontsource/noto-serif/files/noto-serif-latin-ext-400-normal.woff?url';
import serifCyr400 from '@fontsource/noto-serif/files/noto-serif-cyrillic-400-normal.woff?url';
import serifGreek400 from '@fontsource/noto-serif/files/noto-serif-greek-400-normal.woff?url';

/**
 * India's own scripts, each its own Noto family.
 *
 * Added because the company writing these documents is in Hyderabad: a tool
 * that cannot set a customer's name in Telugu is not a document tool for them.
 * Each is fetched only when the text contains that script, so a document in
 * English costs nothing for any of it.
 */
import indTelugu400 from '@fontsource/noto-sans-telugu/files/noto-sans-telugu-telugu-400-normal.woff?url';
import indTelugu700 from '@fontsource/noto-sans-telugu/files/noto-sans-telugu-telugu-700-normal.woff?url';
import indTamil400 from '@fontsource/noto-sans-tamil/files/noto-sans-tamil-tamil-400-normal.woff?url';
import indTamil700 from '@fontsource/noto-sans-tamil/files/noto-sans-tamil-tamil-700-normal.woff?url';
import indBengali400 from '@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-400-normal.woff?url';
import indBengali700 from '@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-700-normal.woff?url';
import indGujarati400 from '@fontsource/noto-sans-gujarati/files/noto-sans-gujarati-gujarati-400-normal.woff?url';
import indKannada400 from '@fontsource/noto-sans-kannada/files/noto-sans-kannada-kannada-400-normal.woff?url';

export type Style = 'regular' | 'bold' | 'italic' | 'boldItalic' | 'mono';

type Covers = (cp: number) => boolean;

interface Face {
  url: string;
  style: Style;
  covers: Covers;
}

const inRange = (...ranges: Array<[number, number]>): Covers => (cp) =>
  ranges.some(([a, b]) => cp >= a && cp <= b);

/**
 * Google's own subset ranges, trimmed to what decides a fetch.
 *
 * `LATIN` deliberately includes the currency block (U+20A0-20BF) — that is
 * where the rupee sign lives, and its absence from WinAnsi is the single most
 * embarrassing thing this module fixes.
 */
const LATIN = inRange([0x0000, 0x00ff], [0x0131, 0x0131], [0x2000, 0x206f], [0x20a0, 0x20bf], [0x2122, 0x2122]);
const LATIN_EXT = inRange([0x0100, 0x024f], [0x1e00, 0x1eff], [0x2c60, 0x2c7f], [0xa720, 0xa7ff]);
const CYRILLIC = inRange([0x0400, 0x04ff], [0x2de0, 0x2dff], [0xa640, 0xa69f]);
const GREEK = inRange([0x0370, 0x03ff], [0x1f00, 0x1fff]);
const DEVANAGARI = inRange([0x0900, 0x097f], [0xa8e0, 0xa8ff]);
const BENGALI = inRange([0x0980, 0x09ff]);
const GUJARATI = inRange([0x0a80, 0x0aff]);
const TAMIL = inRange([0x0b80, 0x0bff]);
const TELUGU = inRange([0x0c00, 0x0c7f]);
const KANNADA = inRange([0x0c80, 0x0cff]);
const VIETNAMESE = inRange([0x0102, 0x0103], [0x0110, 0x0111], [0x1ea0, 0x1ef9], [0x20ab, 0x20ab]);

/**
 * What the PDF base-14 can encode — Latin-1 plus cp1252's additions.
 *
 * Kept because it is the FLOOR. If a web font cannot be fetched (offline, a
 * blocked asset, a stale cache) the document must still be set in something,
 * and that something is the fourteen fonts every PDF reader has built in.
 * Without this floor a failed fetch produced a document with no glyphs at all
 * and a dropped-character count equal to its own length — caught by a test that
 * runs with no network, which is exactly the condition it describes.
 */
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const WINANSI: Covers = (cp) =>
  (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)
  || CP1252_EXTRA.has(String.fromCodePoint(cp));

const face = (url: string, style: Style, covers: Covers): Face => ({ url, style, covers });

function facesFor(serif: boolean): Face[] {
  const latin = serif
    ? [
      face(serifLatin400, 'regular', LATIN), face(serifLatin700, 'bold', LATIN),
      face(serifLatin400i, 'italic', LATIN), face(serifLatin700i, 'boldItalic', LATIN),
      face(serifLatinExt400, 'regular', LATIN_EXT),
      face(serifCyr400, 'regular', CYRILLIC), face(serifGreek400, 'regular', GREEK),
    ]
    : [
      face(sansLatin400, 'regular', LATIN), face(sansLatin700, 'bold', LATIN),
      face(sansLatin400i, 'italic', LATIN), face(sansLatin700i, 'boldItalic', LATIN),
      face(sansLatinExt400, 'regular', LATIN_EXT), face(sansLatinExt700, 'bold', LATIN_EXT),
      face(sansCyr400, 'regular', CYRILLIC), face(sansGreek400, 'regular', GREEK),
    ];
  return [
    ...latin,
    // Devanagari ships in the sans family only. Hindi set in Noto Sans inside a
    // serif document is far better than Hindi that is missing.
    face(sansDeva400, 'regular', DEVANAGARI), face(sansDeva700, 'bold', DEVANAGARI),
    face(indTelugu400, 'regular', TELUGU), face(indTelugu700, 'bold', TELUGU),
    face(indTamil400, 'regular', TAMIL), face(indTamil700, 'bold', TAMIL),
    face(indBengali400, 'regular', BENGALI), face(indBengali700, 'bold', BENGALI),
    face(indGujarati400, 'regular', GUJARATI),
    face(indKannada400, 'regular', KANNADA),
    face(sansViet400, 'regular', VIETNAMESE),
    // Mono is Latin-only by nature; `code` in another script is vanishingly rare
    // and falls through the ladder to a face that can set it.
    face(sansLatin400, 'mono', LATIN),
  ];
}

export interface DocumentFonts {
  /**
   * The face to set this character in for the style asked for, or null when no
   * loaded face has it. Null is the signal to report a dropped glyph.
   */
  pick(style: Style, codePoint: number): PDFFont | null;
  /** Always a real font — for measuring, and for text with nothing awkward in it. */
  base(style: Style): PDFFont;
}

/**
 * Bold italic degrades to bold, then italic, then regular — the ladder a word
 * processor walks. Text is never left unset for want of a slant.
 */
const LADDER: Record<Style, Style[]> = {
  regular: ['regular', 'bold', 'italic', 'boldItalic'],
  bold: ['bold', 'regular', 'boldItalic', 'italic'],
  italic: ['italic', 'regular', 'boldItalic', 'bold'],
  boldItalic: ['boldItalic', 'bold', 'italic', 'regular'],
  mono: ['mono', 'regular', 'bold'],
};

/**
 * Fetch and embed exactly the faces this document needs.
 *
 * A face that will not load is not fatal: the document is set in what did load
 * and `pick` reports whatever it then cannot place. A PDF missing one accent
 * beats no PDF at all.
 */
export async function loadDocumentFonts(
  pdf: PDFDocument,
  serif: boolean,
  text: string,
): Promise<DocumentFonts> {
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  pdf.registerFontkit(fontkit as never);

  const faces = facesFor(serif);
  const needed = new Set<Face>();
  // Latin always: digits, punctuation and spaces live there whatever the script.
  for (const f of faces) if (f.covers === LATIN) needed.add(f);
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    for (const f of faces) if (f.covers(cp)) needed.add(f);
  }

  const loaded = await Promise.all([...needed].map(async (f) => {
    try {
      const res = await fetch(f.url);
      if (!res.ok) return null;
      const font = await pdf.embedFont(await res.arrayBuffer(), { subset: true });
      return { face: f, font };
    } catch {
      // Falls through to the standard faces below.
      return null;
    }
  }));

  /**
   * ORDERED BY THE FACE LIST, not by which fetch finished first.
   *
   * `pick` returns the FIRST face that covers a character, so completion order
   * would decide whether an accented letter came from the Latin face or the
   * Latin-Extended one — a document whose typography changed between runs for
   * no reason anybody could see.
   */
  const embedded = faces
    .map((f) => loaded.find((e) => e && e.face === f))
    .filter((e): e is { face: Face; font: PDFFont } => !!e);

  /**
   * THE FLOOR, always embedded and always last. Web fonts win where they
   * loaded; where none did, the document is still set in the base-14 rather
   * than coming out empty.
   */
  const { StandardFonts } = await import('pdf-lib');
  const std: Array<[Style, string]> = serif
    ? [['regular', StandardFonts.TimesRoman], ['bold', StandardFonts.TimesRomanBold],
      ['italic', StandardFonts.TimesRomanItalic], ['boldItalic', StandardFonts.TimesRomanBoldItalic],
      ['mono', StandardFonts.Courier]]
    : [['regular', StandardFonts.Helvetica], ['bold', StandardFonts.HelveticaBold],
      ['italic', StandardFonts.HelveticaOblique], ['boldItalic', StandardFonts.HelveticaBoldOblique],
      ['mono', StandardFonts.Courier]];
  for (const [style, name] of std) {
    embedded.push({ face: face('', style, WINANSI), font: await pdf.embedFont(name as never) });
  }

  const byStyle = (style: Style) => embedded.filter((e) => e.face.style === style);
  const fallback = embedded[embedded.length - 1]!.font;

  return {
    pick(style, cp) {
      for (const s of LADDER[style]) {
        for (const e of byStyle(s)) if (e.face.covers(cp)) return e.font;
      }
      return null;
    },
    base(style) {
      for (const s of LADDER[style]) {
        const first = byStyle(s)[0];
        if (first) return first.font;
      }
      return fallback;
    },
  };
}
