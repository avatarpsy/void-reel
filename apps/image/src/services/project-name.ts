/**
 * What to CALL a project in the user's library.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * A project was named after the format it was made from and never renamed
 * again, so a library of a hundred image projects showed the same card over and
 * over: "Presentation 16:9 · 6 pages · Edited Aug 21", eight times on screen,
 * distinguishable only by a page count. Finding a deck again was guesswork, and
 * the covers do not rescue it — deck slides are dark by design, so a dark cover
 * on a dark card reads as an empty rectangle.
 *
 * The deck already knows what it is called: it is written on the title slide.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────
 * It never overwrites a name somebody chose. Only the untouched default —
 * the format preset, or "Untitled" — is replaced, because a name the user typed
 * is a decision and a derived name is a guess. That is also why this is a
 * display-time derivation rather than a rename: nothing on the document is
 * changed, so the moment the user types their own title it wins with no
 * conflict to resolve.
 */
import type { Project, Artboard, Layer, TextLayer, ImageLayer } from '../types/project';

/**
 * Names that mean "nobody has named this yet".
 *
 * The canvas presets are the names every project is born with. Matching is
 * case-insensitive and ignores a trailing " copy"/" (2)" so a duplicated deck
 * is still treated as unnamed rather than inheriting a guess about the original.
 */
const DEFAULT_NAME_PATTERNS: RegExp[] = [
  /^untitled/i,
  /^presentation\b/i,
  /^instagram\b/i,
  /^facebook\b/i,
  /^twitter\b/i,
  /^linkedin\b/i,
  /^tiktok\b/i,
  /^pinterest\b/i,
  /^youtube\b/i,
  /^a4\b/i,
  /^letter\b/i,
  /^poster\b/i,
  /^business card/i,
  /^desktop wallpaper/i,
  /^4k wallpaper/i,
  /^mobile wallpaper/i,
  /^logo square/i,
  /^favicon/i,
  /^post$/i,
  /^story$/i,
  /^thumbnail$/i,
  /^document$/i,
  /^custom\b/i,
];

/** True when the project still carries the name it was born with. */
export function isDefaultProjectName(name: string | undefined): boolean {
  const n = String(name ?? '').trim();
  if (!n) return true;
  return DEFAULT_NAME_PATTERNS.some((re) => re.test(n));
}

/**
 * Slots that hold the thing a slide is ABOUT, best first.
 *
 * A block's headline is the title of the deck when it is on the title slide.
 * `eyebrow` is deliberately absent: it holds a category ("WHAT IT IS"), which
 * is the one string on the slide guaranteed not to identify the deck.
 */
const TITLE_SLOTS = ['headline', 'title', 'heading', 'subtitle', 'sub'];

/** One line, trimmed, with runs of whitespace collapsed. */
function tidy(raw: string): string {
  return String(raw).replace(/\s+/g, ' ').trim();
}

/**
 * Cut to a length that fits a library card without ending mid-word.
 *
 * A hard slice produces "From one creator to a real busine", which reads as a
 * bug. Backing up to the last space and adding an ellipsis reads as a title.
 */
function clip(text: string, max = 60): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

/** The title-ish text on one layer, or ''. */
function titleFromLayer(layer: Layer | undefined): string {
  if (!layer || layer.visible === false) return '';

  const composition = (layer as ImageLayer).composition;
  if (composition) {
    const slots = composition.slots ?? {};
    for (const key of TITLE_SLOTS) {
      const v = tidy(String(slots[key] ?? ''));
      if (v) return v;
    }
    return '';
  }

  if (layer.type === 'text') {
    // Only the first line: a headline layer often carries the wrapped copy
    // baked in as newlines, and the first line is the headline.
    const first = tidy(String((layer as TextLayer).content ?? '').split('\n')[0] ?? '');
    return first;
  }

  return '';
}

/**
 * The best title text on a page.
 *
 * Layers are read in the order the page stacks them, which is the order they
 * were added — so a block placed as the slide comes before decoration added
 * afterwards. The first layer that offers a title wins; nothing is scored,
 * because a rule you can predict beats a rule that is usually cleverer.
 */
export function titleFromPage(project: Project, artboard: Artboard | undefined): string {
  if (!artboard) return '';
  for (const id of artboard.layerIds) {
    const found = titleFromLayer(project.layers[id]);
    if (found) return found;
  }
  return '';
}

/**
 * What the library should call this project.
 *
 * Returns the existing name untouched unless it is still the format default AND
 * the first page offers something better.
 */
export function projectDisplayName(project: Project | null | undefined): string {
  const current = tidy(String(project?.name ?? ''));
  if (!project) return current || 'Untitled';
  if (!isDefaultProjectName(current)) return current;

  const derived = titleFromPage(project, project.artboards[0]);
  if (!derived) return current || 'Untitled';

  return clip(derived);
}
