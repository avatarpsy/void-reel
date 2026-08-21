import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../../../stores/project-store';
import { useUIStore } from '../../../stores/ui-store';
import { resolveComposition } from '../../../services/composition/block-source';
import { slotFields, withSlotValue, type SlotField } from '../../../services/composition/slot-fields';
import { isMultilineSlot } from '../../../services/composition/slot-input-kind';
import type { SlotSpec } from '../../../services/composition/document';
import type { CompositionSource, ImageLayer } from '../../../types/project';

interface Props {
  layer: ImageLayer;
}

const INPUT =
  'w-full px-2 py-1.5 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary';

/**
 * The slots of a composition layer, as editable fields.
 *
 * ── WHY THIS IS THE WHOLE UI FOR A COMPOSITION ──────────────────────────────
 * A composition is a block plus the values put into its holes. The agent writes
 * those values and a person edits the same ones here, so automation and manual
 * editing are one operation on one structure — which is the merge point the
 * design is built around, not a convenience. Anything else about the layer
 * (position, opacity, effects, masks) is already handled by the ordinary image
 * sections, because a composition composites exactly like an image layer.
 *
 * ── THE MANIFEST IS FETCHED, NOT STORED ─────────────────────────────────────
 * What holes exist belongs to the BLOCK. Copying it onto the layer would leave
 * every slide placed before an edit offering yesterday's holes, so the block is
 * asked each time and the answer is cached for the page. Until it arrives, or
 * when it never does, the panel falls back to the keys that are already filled:
 * fewer rows than the block really has, but never a value the user cannot reach.
 */
export function CompositionSection({ layer }: Props) {
  const { updateLayer } = useProjectStore();
  const source = layer.composition as CompositionSource;

  const [manifest, setManifest] = useState<Record<string, SlotSpec>>({});
  const [notice, setNotice] = useState('');

  /**
   * Keyed on the BLOCK, not on the layer or its values.
   *
   * The manifest changes when the block does and at no other time, so making
   * this depend on the layer would re-ask for it on every keystroke — a fetch
   * per character, and a panel that rebuilds itself while somebody types in it.
   */
  const blockKey = source.block ?? (source.inlineHtml ? 'inline' : '');

  useEffect(() => {
    let cancelled = false;
    setNotice('');
    void resolveComposition(source).then((resolved) => {
      if (cancelled) return;
      if (!resolved) {
        setManifest({});
        setNotice(
          source.block
            ? `Could not load "${source.block}", so only the slots already filled are shown.`
            : 'This composition has no block and no html.',
        );
        return;
      }
      setManifest(resolved.manifest);
      setNotice(resolved.warnings[0] ?? '');
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockKey]);

  const setSlot = (key: string, value: string) => {
    updateLayer<ImageLayer>(layer.id, {
      composition: withSlotValue(layer.composition as CompositionSource, key, value),
    });
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const fields = slotFields(manifest, source.slots ?? {});

  /**
   * Double-clicking the slide asks to edit its words.
   *
   * A slide built from a block has no text layer to put a caret in — the words
   * are slots — so the honest equivalent is to put the cursor in the field that
   * holds the words.
   *
   * The HEADLINE, specifically, and not merely the first text slot. Manifests
   * list the eyebrow first, so "first text slot" landed on the small kicker
   * above the headline — a real field, and not the one anybody double-clicked
   * the slide to change. Falls back to the first plain text slot for a block
   * that names its main line something else.
   */
  const namedHeadline = fields.find(
    (f) => f.kind === 'text' && /^(headline|title|heading)$/i.test(f.key),
  )?.key;
  const firstTextSlot =
    namedHeadline ?? fields.find((f) => f.kind === 'text' && !f.values?.length)?.key ?? '';
  const editFocusNonce = useUIStore((s) => s.editFocusNonce);
  useEffect(() => {
    if (!editFocusNonce || !firstTextSlot) return;
    // After the panel has drawn its rows — the section may have only just been
    // switched to by the same double-click.
    const t = setTimeout(() => {
      const el = rootRef.current?.querySelector<HTMLInputElement>(
        `[data-slot-key="${CSS.escape(firstTextSlot)}"]`,
      );
      el?.focus();
      el?.select();
    }, 60);
    return () => clearTimeout(t);
  }, [editFocusNonce, firstTextSlot]);

  return (
    <div className="space-y-4" ref={rootRef}>
      <div className="p-3 bg-secondary/30 rounded-lg space-y-1">
        <div className="text-[11px] text-foreground">
          {source.block ? source.block : 'Authored composition'}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {source.tier ? `${source.tier} block · ` : ''}
          {source.frameWidth} × {source.frameHeight}
        </div>
      </div>

      {notice && (
        <p className="text-[10px] text-muted-foreground leading-relaxed">{notice}</p>
      )}

      {fields.length === 0 ? (
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          This block declares no slots — it is used as designed.
        </p>
      ) : (
        <div className="space-y-3">
          {fields.map((field) => (
            <SlotInput key={field.key} field={field} onChange={(v) => setSlot(field.key, v)} />
          ))}
        </div>
      )}

      <div>
        <label className="block text-[10px] text-muted-foreground mb-1">Unfilled slots</label>
        <select
          value={source.fillMode}
          onChange={(e) => updateLayer<ImageLayer>(layer.id, {
            composition: { ...source, fillMode: e.target.value as CompositionSource['fillMode'] },
          })}
          className={INPUT}
        >
          {/* The wording is the decision, not the mode name: "render" hiding an
              unfilled slot is what stops the designer's demo text shipping
              inside somebody's deck. */}
          <option value="render">Hide them</option>
          <option value="preview">Show the designer&apos;s sample</option>
        </select>
      </div>
    </div>
  );
}

/**
 * One slot, typed.
 *
 * A colour is a CSS variable and gets a swatch; media is a url and gets a url
 * field with a thumbnail, because the thing that goes wrong with an image slot
 * is a url that does not load, and a preview is how you see that immediately.
 * Everything else is text.
 */
function SlotInput({ field, onChange }: { field: SlotField; onChange: (value: string) => void }) {
  const label = (
    <label className="block text-[10px] text-muted-foreground mb-1">
      {field.label}
      {field.undeclared && (
        <span
          className="ml-1 text-[9px] text-muted-foreground/70"
          title="This value is set, but the block does not declare a slot for it — it may have been edited since."
        >
          (not in this block)
        </span>
      )}
    </label>
  );

  /**
   * A FIXED SET OF VALUES IS A MENU, whatever kind the slot is.
   *
   * Checked before `kind`, because an enum's kind describes what it stores and
   * the menu describes what you may store. The entrance animation is a text
   * slot with six legal answers; as a text box it showed one of them as a
   * placeholder and hid the rest, so the only way to find "fadeIn" was to ask
   * the agent for it.
   */
  if (field.values?.length) {
    return (
      <div>
        {label}
        <select
          value={field.value}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        >
          {/* An empty option is what "leave it alone" looks like, and without
              it a slot nobody has set would silently adopt the first value the
              moment the panel drew it. */}
          <option value="">
            {field.placeholder ? `Default (${field.placeholder})` : 'Default'}
          </option>
          {field.values.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
          {/* A value set before the block declared its options would otherwise
              vanish from the menu and be lost on the next change. */}
          {field.value && !field.values.includes(field.value) && (
            <option value={field.value}>{field.value}</option>
          )}
        </select>
      </div>
    );
  }

  if (field.kind === 'color') {
    // A colour slot with nothing in it has no colour to show, and a swatch
    // defaulting to black would read as "black is set" when nothing is.
    const swatch = field.value || field.placeholder || '#000000';
    return (
      <div>
        {label}
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(swatch) ? swatch : '#000000'}
            onChange={(e) => onChange(e.target.value)}
            className="w-8 h-8 rounded border border-input cursor-pointer"
          />
          <input
            type="text"
            value={field.value}
            placeholder={field.placeholder || '#000000'}
            onChange={(e) => onChange(e.target.value)}
            className={`${INPUT} font-mono flex-1`}
          />
        </div>
      </div>
    );
  }

  if (field.kind === 'image' || field.kind === 'video') {
    return (
      <div>
        {label}
        <input
          type="text"
          value={field.value}
          placeholder={field.placeholder || 'Image URL'}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        />
        {field.kind === 'image' && field.value && (
          <div className="mt-1.5 rounded-md border border-input bg-background overflow-hidden">
            <img src={field.value} alt="" className="block max-h-24 w-full object-contain" />
          </div>
        )}
      </div>
    );
  }

  // See  for why an input is not safe for every text slot.
  const multiline = isMultilineSlot(field.value, field.placeholder);

  if (multiline) {
    return (
      <div>
        {label}
        <textarea
          data-slot-key={field.key}
          value={field.value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className={`${INPUT} resize-y min-h-[46px] leading-snug`}
        />
      </div>
    );
  }

  return (
    <div>
      {label}
      <input
        type="text"
        data-slot-key={field.key}
        value={field.value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      />
    </div>
  );
}
