/**
 * What the Inspector draws for a composition's slots, and what a slot edit does.
 *
 * Slots are the shared edit surface: the agent writes them and a person edits
 * the same ones by hand, which is what makes automation and manual editing the
 * same operation on the same structure rather than two systems bolted together.
 * That makes "which rows exist" a decision with consequences, so it lives here
 * and is tested, instead of being scattered through a panel component.
 *
 * TWO DIFFERENT THINGS ARE BOTH CALLED SLOTS, and keeping them apart is most of
 * this module: the MANIFEST is what holes a block declares, and belongs to the
 * block; the VALUES are what has been put in them, and live on the layer.
 */
import type { SlotSpec } from './document';
import type { CompositionSource } from '../../types/project';

export interface SlotField {
  key: string;
  kind: SlotSpec['kind'];
  /** A human label for the key — blocks name slots `key-text`, `source`, `bg`. */
  label: string;
  /** What is filled in now. Empty means unfilled. */
  value: string;
  /** The designer's sample, shown as a PLACEHOLDER and never as a value. */
  placeholder: string;
  /**
   * True when this key is filled in but the block does not declare it.
   *
   * Kept visible rather than hidden: `prepareComposition` warns about exactly
   * this case, and a value with no row is a value the user set that they have no
   * way to unset. It is usually a block that was edited after the slide was
   * made, and seeing it is how anybody works that out.
   */
  undeclared: boolean;
}

/** `key-text` and `keyText` both become "Key text". */
export function slotLabel(key: string): string {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Present and not blank — the same test the document builder applies, so the
 *  panel and the renderer agree about which slots are actually filled. */
function filled(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/**
 * One row per slot, declared ones first and in the order the block declares them.
 *
 * EVERY DECLARED SLOT GETS A ROW, filled or not. A hole you cannot see is a hole
 * you cannot fill, and an empty row is also the only thing that tells you the
 * block has a subtitle at all.
 *
 * THE SAMPLE IS A PLACEHOLDER, NEVER A VALUE. Putting the designer's demo text
 * into the input as a value would fill the slot the moment somebody clicked
 * away — and shipping the designer's sample inside a user's work is the failure
 * that survives all the way to a published deck. The placeholder shows what the
 * slot is for and commits to nothing.
 */
export function slotFields(
  manifest: Record<string, SlotSpec>,
  values: Record<string, string>,
): SlotField[] {
  const rows: SlotField[] = [];
  const declared = new Set<string>();

  for (const [key, spec] of Object.entries(manifest ?? {})) {
    if (!spec) continue;
    declared.add(key);
    rows.push({
      key,
      kind: spec.kind,
      label: slotLabel(key),
      value: filled(values?.[key]) ? String(values[key]) : '',
      placeholder: spec.sample ?? '',
      undeclared: false,
    });
  }

  for (const [key, value] of Object.entries(values ?? {})) {
    if (declared.has(key) || !filled(value)) continue;
    rows.push({
      key,
      // Nothing declares this one, so nothing says what kind it is. Text is the
      // only kind that cannot make things worse: it edits as what it is.
      kind: 'text',
      label: slotLabel(key),
      value: String(value),
      placeholder: '',
      undeclared: true,
    });
  }

  return rows;
}

/**
 * Set one slot on a composition.
 *
 * ── A BLANK VALUE REMOVES THE KEY ───────────────────────────────────────────
 * `''` and "absent" mean the same thing to the renderer — both leave the slot
 * unfilled — but they are DIFFERENT cache keys, because the fingerprint carries
 * every key it finds. Storing the blank would give two identical-looking slides
 * two different keys and two renders, and would make clearing a slot look like
 * an edit that changed nothing.
 *
 * ── `renderHash` IS DELIBERATELY NOT UPDATED ────────────────────────────────
 * It records which render the layer's pixels came from. Stamping a fresh hash
 * here would declare pixels that do not exist yet to be current, and
 * `needsRerender` — the one question the whole cache turns on — would answer no
 * for a slide nobody has rendered. Leaving it alone is what makes an edit go
 * stale, which is the point.
 */
export function withSlotValue(
  source: CompositionSource,
  key: string,
  value: string,
): CompositionSource {
  const slots = { ...source.slots };
  if (filled(value)) slots[key] = value;
  else delete slots[key];
  return { ...source, slots };
}
