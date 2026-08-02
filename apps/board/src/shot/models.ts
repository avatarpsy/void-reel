/**
 * What each video model can be given — the board's copy of the catalogue.
 *
 * IT IS RECEIVED, NEVER HARDCODED. The truth lives in
 * `studio/src/models/video-gen-config.ts` next to the registry, and the parent
 * page hands it over on mount (`voidspace:board-models`). A table written out
 * again here would be correct for exactly as long as it took someone to add a
 * model, and the failure would be silent: the board would offer a reference the
 * model cannot read and the user would find out from a bad video.
 *
 * WHY THE BOARD NEEDS IT AT ALL, when generation happens later:
 *
 *  • A model decides which references are even LEGAL. Only some take a distinct
 *    last frame; only some parse `@Image1` tags; only some speak. Attaching a
 *    last frame to a model that ignores it is work the user did for nothing,
 *    and nothing downstream will tell them.
 *  • Duration caps are a STORY constraint, not a technical footnote. "This beat
 *    runs 20 seconds" is a different film on a model that stops at 10.
 *  • The agent has to be able to answer "which model should this shot use?"
 *    with a reason, and the reason is always one of these facts.
 */
import { checkComposition, findBlock, mediaSlots } from './blocks';


export interface ModelCaps {
  id: string;
  label: string;
  /** Registry price for one call, in credits, at the model's first resolution. */
  credits?: number;
  /** Per-second price by resolution, when the model bills that way. */
  pricePerSec?: Record<string, number>;
  locked?: boolean;

  minDurationSec: number;
  maxDurationSec: number;
  /** Discrete lengths the model snaps to. Empty = anything in range. */
  allowedDurations: number[];

  /** The model generates spoken dialogue itself. */
  nativeDialogue: boolean;
  /** The model generates ambient sound / effects itself. */
  nativeAudio: boolean;
  /** It can be given a voice to imitate (`@Audio1`). */
  acceptsVoiceReference: boolean;
  /** It accepts a distinct END keyframe. */
  supportsLastFrame: boolean;
  /** It reads `@Image1`-style tags in the prompt. */
  usesReferenceTags: boolean;
  /** Capital `Image` (Seedance) or lowercase `image` (Grok). */
  referenceTagSyntax: 'Image' | 'image';
  deliveryModes: Array<'first-frame' | 'reference'>;
  defaultDelivery: 'first-frame' | 'reference';
}

let catalogue: ModelCaps[] = [];
let defaultModelId = '';

/**
 * Who to tell when the catalogue lands.
 *
 * THIS IS NOT OPTIONAL PLUMBING. The catalogue arrives from the parent page a
 * moment AFTER the canvas has mounted and painted — it is a network fetch away —
 * so by the time it exists, every shot card has already rendered without it.
 * The cards are driven by their block props, and the catalogue is not a prop, so
 * nothing would ever mark them dirty: they sat there reading "Model — not
 * chosen" about shots whose model was plainly set, and no reference showed its
 * @-tag. Measured exactly that before this existed.
 */
const listeners = new Set<() => void>();

export function onModelCatalogue(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Replace the catalogue, and repaint anything that reads it. */
export function setModelCatalogue(models: ModelCaps[], defaultId = ''): void {
  catalogue = models.filter(m => m && typeof m.id === 'string');
  defaultModelId = defaultId || catalogue[0]?.id || '';
  listeners.forEach(fn => {
    try { fn(); } catch { /* one bad listener must not stop the rest repainting */ }
  });
}

export function allModels(): ModelCaps[] {
  return catalogue;
}

export function defaultModel(): string {
  return defaultModelId;
}

export function findModel(id: string | undefined | null): ModelCaps | null {
  if (!id) return null;
  return catalogue.find(m => m.id === id) ?? null;
}

/** The model a shot will actually be generated with — its own, or the default. */
export function effectiveModel(shotModel: string): ModelCaps | null {
  return findModel(shotModel) ?? findModel(defaultModelId);
}

/**
 * What is wrong with this shot's inputs, given its model.
 *
 * WARNINGS, NOT ERRORS, and that distinction is the whole design. A person
 * arranging a storyboard is thinking, not configuring: refusing a last frame
 * because they have not chosen a model yet would be the tool arguing with them.
 * So nothing is blocked, and the board says plainly what will not survive
 * generation — early, while it is still cheap to change either the reference or
 * the model.
 */
export interface ShotWarning {
  mediaId?: string;
  message: string;
}

/**
 * ROUGHLY WHAT THIS SHOT WILL COST TO GENERATE, in credits.
 *
 * WHY AN ESTIMATE IS WORTH SHOWING AT ALL. The board is where a video is
 * decided, and length is the single biggest lever on price — a 15-second shot
 * on the top tier costs several times a 5-second one on the cheap tier, and
 * nobody discovers that until after they have paid for twelve of them. Showing
 * it beside the duration turns "how long should this be" into a decision with
 * a visible consequence.
 *
 * DELIBERATELY APPROXIMATE, and labelled that way everywhere it is shown. The
 * real charge happens at generation time against the registry, includes
 * resolution and per-image surcharges this cannot know, and may have moved
 * since the catalogue was fetched. A number presented as exact and then billed
 * differently is worse than no number; a `~` is honest and still useful.
 *
 * Returns null when it genuinely cannot be known — no model, or a model with no
 * pricing — rather than guessing zero, which would read as "free".
 */
/**
 * HOW LONG THIS SHOT WILL ACTUALLY RUN, given what is set so far.
 *
 * ONE RULE, used by both the cost estimate and the board's runtime total —
 * they disagreed before, and the board read "3 shots · 17s · ~103 cr" where the
 * 17s ignored a shot the 103 cr had charged for. A summary that contradicts
 * itself is worse than one that is merely approximate.
 *
 * An unset clip runs at its model's minimum, because that is what would be
 * generated if the user pressed go now. An unset graphic runs 5s, which is what
 * the render pipeline uses (`hfDur` in useStudioPipeline). Returns 0 only when
 * nothing can be said at all — no model, no length.
 */
export function plannedSeconds(shot: { kind?: string; model: string; durationSec: number }): number {
  if (shot.kind === 'hyperframes') return shot.durationSec > 0 ? shot.durationSec : 5;
  const caps = effectiveModel(shot.model);
  if (!caps) return shot.durationSec > 0 ? shot.durationSec : 0;
  return shot.durationSec > 0
    ? Math.max(caps.minDurationSec, Math.min(caps.maxDurationSec, shot.durationSec))
    : caps.minDurationSec;
}

export function estimateShotCredits(
  shot: { kind?: string; model: string; durationSec: number },
): number | null {
  // A composition is RENDERED, not generated. There is no model call to bill.
  if (shot.kind === 'hyperframes') return 0;

  const caps = effectiveModel(shot.model);
  if (!caps) return null;

  // Not planned yet: priced at the model's shortest allowed clip, which is the
  // floor rather than a guess at what they will choose. See `plannedSeconds`.
  const seconds = plannedSeconds(shot);

  const perSec = caps.pricePerSec ? Object.values(caps.pricePerSec)[0] : undefined;
  if (typeof perSec === 'number' && perSec > 0) return Math.round(perSec * seconds * 100) / 100;
  // Flat-priced models bill per call regardless of length.
  if (typeof caps.credits === 'number' && caps.credits > 0) return caps.credits;
  return null;
}

/** `12.5` → `~13 cr`. Rounded, because an estimate that reads as exact lies. */
export function formatCredits(credits: number | null): string {
  if (credits === null) return '';
  if (credits === 0) return 'no gen cost';
  return `~${credits < 10 ? credits.toFixed(1) : Math.round(credits)} cr`;
}

export function checkShot(
  shot: {
    kind?: string;
    model: string;
    durationSec: number;
    voiceover: string;
    composition?: string;
    compositionVars?: Record<string, string>;
    media: Array<{ id: string; role: string; kind: string }>;
  },
): ShotWarning[] {
  /**
   * A GRAPHIC IS NOT GENERATED, so none of the model warnings apply — it has no
   * end-frame input to lack and no clip cap to exceed. Warning about them would
   * be reporting problems with a model this shot will never use. What CAN be
   * wrong with it is about the block, and that lives in `checkComposition`.
   */
  if (shot.kind === 'hyperframes') {
    const out: ShotWarning[] = [];
    if (!shot.composition) {
      out.push({
        message: 'No block chosen yet — pick one from the library, or say what this graphic '
          + 'should show and I will find one that fits.',
      });
    }
    out.push(...checkComposition({
      composition: shot.composition ?? '',
      compositionVars: shot.compositionVars,
      // Which media slots the shot has actually filled, so a well that HAS a
      // picture is not reported as still wanting one.
      filledMedia: shot.media.map(m => String(m.role)),
    }).map(message => ({ message })));

    /**
     * A REFERENCE THAT IS NOT IN ANY SLOT does nothing to a graphic — the
     * composition lays out what its slots name and ignores the rest. Naming the
     * legal slots turns "why is my picture missing" into one click.
     */
    const block = findBlock(shot.composition ?? '');
    const wanted = mediaSlots(block).map(sl => sl.key);
    const stranded = shot.media.filter(m =>
      m.kind !== 'audio' && m.role !== 'reference' && !wanted.includes(String(m.role)));
    if (wanted.length && stranded.length) {
      out.push({
        mediaId: stranded[0].id,
        message: `That reference is tagged "${stranded[0].role}", which `
          + `${shot.composition} has no slot for. It wants ${wanted.join(', ')} — retag it, or it `
          + 'will not appear.',
      });
    }
    return out;
  }

  const caps = effectiveModel(shot.model);
  if (!caps) return [];
  const out: ShotWarning[] = [];

  for (const m of shot.media) {
    if (m.role === 'lastFrame' && !caps.supportsLastFrame) {
      out.push({
        mediaId: m.id,
        message: `${caps.label} has no end-frame input, so this last frame will be ignored. `
          + 'Use a model that supports one, or make it a plain reference.',
      });
    }
    if (m.role === 'motionRef' && !caps.usesReferenceTags) {
      out.push({
        mediaId: m.id,
        message: `${caps.label} does not read tagged references, so this motion reference `
          + 'cannot be pointed at from the prompt.',
      });
    }
    if (m.kind === 'audio' && m.role === 'sfx' && caps.nativeAudio) {
      out.push({
        mediaId: m.id,
        message: `${caps.label} generates its own ambient sound — this effect will be layered `
          + 'on top rather than replacing it.',
      });
    }
  }

  if (shot.voiceover.trim() && !caps.nativeDialogue) {
    out.push({
      message: `${caps.label} does not speak — this line will be voiced separately with TTS `
        + 'and laid over the clip.',
    });
  }

  if (shot.durationSec > 0 && shot.durationSec > caps.maxDurationSec) {
    out.push({
      message: `${caps.label} caps a clip at ${caps.maxDurationSec}s, so ${shot.durationSec}s `
        + 'will be cut short. Split the beat in two, or pick a model with a longer cap.',
    });
  }

  return out;
}

/**
 * The positional tag a reference carries in the prompt — `@Image2`, `@Video1`.
 *
 * NUMBERED PER KIND, IN LIST ORDER, which is the contract the generation step
 * already implements (`useStudioPipeline`: "@-numbering is array-index based
 * server-side, so list order == @Image order"). Getting this wrong is not a
 * cosmetic slip: the prompt would talk about @Image2 while the model was handed
 * something else there.
 *
 * Returns '' for a model that does not read tags, so the caller writes nothing
 * rather than writing something the model will choke on.
 */
export function referenceTag(
  caps: ModelCaps | null,
  media: Array<{ id: string; kind: string }>,
  mediaId: string,
): string {
  if (!caps?.usesReferenceTags) return '';
  const target = media.find(m => m.id === mediaId);
  if (!target) return '';
  const slot = target.kind === 'image' ? caps.referenceTagSyntax
    : target.kind === 'video' ? 'Video'
      : 'Audio';
  const n = media.filter(m => m.kind === target.kind).findIndex(m => m.id === mediaId) + 1;
  return n > 0 ? `@${slot}${n}` : '';
}
