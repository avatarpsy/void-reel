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

  /**
   * Output sizes this model can render, cheapest first.
   *
   * Per-model because they genuinely differ — Seedance 2.5 reaches 1080p, H3
   * reaches 2K, Fast stops at 720p — and because PRICE is keyed on them:
   * `pricePerSec` has one entry per resolution. A shared list would offer sizes
   * half the catalogue cannot render, at prices it does not charge.
   *
   * Empty for models that do not vary by size (and for local recipes), which is
   * the signal to hide the control rather than draw an empty one.
   *
   * OPTIONAL, not required-and-empty: a parent page from before these were sent
   * omits them entirely, and `undefined` is the honest description of that. The
   * readers already treat missing and empty the same way — no picker.
   */
  resolutions?: string[];
  /** Frame shapes the model accepts. Empty ⇒ it decides, so offer nothing. */
  aspectRatios?: string[];

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

  /**
   * Present when this model runs on ONE OF THE USER'S OWN MACHINES.
   *
   * A local model is not a cheaper cloud model, it is a different kind of thing,
   * and the two facts the card has to carry are both here: it costs nothing, and
   * it can be temporarily impossible. A cloud model is either offered or locked;
   * a local one can be offered, listed, chosen — and still be waiting on a 19 GB
   * download. `ready: false` is not an error state, it is a to-do, and `missing`
   * is the sentence that says what.
   */
  local?: {
    /** The machine, as the user calls it. Already inside `label` too, because a
     *  picker showing two identical rows is a coin flip. */
    nodeName: string;
    recipe: string;
    ready: boolean;
    /** One sentence naming the FIRST thing to fix. Empty when ready. */
    missing?: string;
  };
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
 * WHAT THIS MODEL WILL ACTUALLY TAKE — the card's own question, answered before
 * the user does the work rather than after.
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
 * Every clip card drew the same three wells — FIRST FRAME, LAST FRAME, MOTION
 * REF — whatever model the shot was set to. Most models take some of that and
 * not the rest: only some accept a distinct end keyframe, only some read
 * `@Image1` tags out of the prompt, only some speak. `checkShot` said so, but it
 * said so AFTERWARDS, as a warning on a card the user had already filled in.
 *
 * That is the wrong end of the interaction. A well is an invitation: drawing one
 * the model cannot read invites somebody to go and find a reference, decide it
 * is right, drag it in — and only then be told it will be ignored. The time is
 * already spent by the time the warning arrives, and being told after the fact
 * that the tool knew all along is the specific thing that makes a tool feel like
 * it is wasting you.
 *
 * ── WHY UNSUPPORTED WELLS ARE SHOWN, NOT HIDDEN ──────────────────────────────
 * Hiding them would stop the wasted work and cost something worse: the user
 * would never learn what the models differ ON. A card with two wells on one
 * model and three on another, with nothing to say why, reads as a bug. So the
 * well stays, visibly not-for-this-model, and says which capability is missing —
 * which turns "why can't I do this" into "so THAT is what changing the model
 * buys me", at the moment they are deciding.
 *
 * A well that ALREADY HOLDS media is never marked away: the reference is really
 * there, it has to stay visible and draggable, and `checkShot` is what explains
 * that it will not survive. Hiding media because the model changed is how a
 * board loses something quietly.
 */
export interface SlotSupport {
  /** False when this model cannot read anything put here. */
  supported: boolean;
  /** One sentence naming the missing capability, and what to do about it.
   *  Empty when supported. */
  why: string;
}

/**
 * Can this model be given media in this named slot?
 *
 * Answers for the CLIP slots only — a graphic's wells come from its block's
 * declared slots and no video model is involved, which is why `rolesFor` takes
 * the block rather than the caps.
 *
 * An unknown model (catalogue still loading, or a shot pointing at something
 * retired) answers YES to everything. A card that greys out its own inputs
 * because a fetch has not landed is worse than one that lets the user work and
 * warns later — and the warning path still exists.
 */
export function slotSupport(caps: ModelCaps | null, role: string): SlotSupport {
  const ok: SlotSupport = { supported: true, why: '' };
  if (!caps) return ok;

  switch (role) {
    case 'firstFrame':
      return caps.deliveryModes.includes('first-frame') ? ok : {
        supported: false,
        why: `${caps.label} builds from references rather than from an opening frame, so a `
          + 'first frame here is treated as one more reference. Pick a model with a '
          + 'first-frame mode to pin the exact opening image.',
      };
    case 'lastFrame':
      return caps.supportsLastFrame ? ok : {
        supported: false,
        why: `${caps.label} has no end-frame input — it decides its own last frame. Pick a `
          + 'model that takes one if the shot has to land on a specific image.',
      };
    case 'motionRef':
      return caps.usesReferenceTags ? ok : {
        supported: false,
        why: `${caps.label} does not read tagged references, so there is no way to point at a `
          + 'motion reference from the prompt. Describe the move in SHOT instead, or pick a '
          + 'model that reads @-tags.',
      };
    default:
      return ok;
  }
}

/**
 * The capability facts worth putting ON the card, as short chips.
 *
 * Chosen for what CHANGES WHAT YOU DO: whether you can pin the end, whether
 * references can be pointed at by name, whether the model speaks and makes its
 * own sound, and how long a clip may be. Everything else in `ModelCaps` is
 * either pricing (already shown) or plumbing.
 *
 * `on` drives the styling rather than the wording, so a chip reads the same way
 * whichever answer it carries — "no end frame" is as much a fact worth knowing
 * as "end frame", and a list of only the yeses would leave the user to infer the
 * noes from silence.
 */
export interface CapChip {
  label: string;
  on: boolean;
  title: string;
}

export function capChips(caps: ModelCaps | null): CapChip[] {
  if (!caps) return [];

  const lengths = caps.allowedDurations.length
    ? `${caps.allowedDurations.join(' / ')}s`
    : `${caps.minDurationSec}–${caps.maxDurationSec}s`;

  return [
    {
      label: caps.supportsLastFrame ? 'end frame' : 'no end frame',
      on: caps.supportsLastFrame,
      title: caps.supportsLastFrame
        ? 'Takes a distinct closing keyframe, so the shot can be made to land on an exact image.'
        : 'Decides its own last frame. A LAST FRAME reference cannot be used with this model.',
    },
    {
      label: caps.usesReferenceTags ? '@tags' : 'no @tags',
      on: caps.usesReferenceTags,
      title: caps.usesReferenceTags
        ? `Reads @${caps.referenceTagSyntax}1-style tags, so the prompt can name a specific `
          + 'reference — "she turns, like @Video1".'
        : 'Reads references as a set, with no way to point at one from the prompt.',
    },
    {
      label: caps.nativeDialogue ? 'speaks' : 'silent',
      on: caps.nativeDialogue,
      title: caps.nativeDialogue
        ? 'Generates spoken dialogue itself, on camera, from lines written in SHOT.'
        : 'Makes no speech. Anything in NARRATION is voiced separately and laid over the clip.',
    },
    {
      label: caps.nativeAudio ? 'own sound' : 'no sound',
      on: caps.nativeAudio,
      title: caps.nativeAudio
        ? 'Generates its own ambient sound. Effects you attach are layered on top.'
        : 'Produces picture only — every sound on this shot comes from what you attach.',
    },
    ...(caps.acceptsVoiceReference ? [{
      label: 'voice ref',
      on: true,
      title: 'Can be given a voice to imitate, attached as an audio reference.',
    }] : []),
    { label: lengths, on: true, title: `How long a clip this model will make. ${
      caps.allowedDurations.length
        ? 'It snaps to these lengths — anything else is rounded.'
        : `Anything from ${caps.minDurationSec} to ${caps.maxDurationSec} seconds.`}` },
  ];
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
  if (shot.durationSec <= 0) return snapDuration(caps, caps.minDurationSec);
  return snapDuration(caps, shot.durationSec);
}

/**
 * THE LENGTH THIS MODEL WILL ACTUALLY PRODUCE.
 *
 * Clamping to min/max was only half the rule, and the missing half was already
 * described in `ModelCaps`: `allowedDurations` is "discrete lengths the model
 * snaps to". Seedance does 4, 5, 8, 10, 12, 15 — it does not do 7. That list was
 * being reported to the agent by `board_model_catalog` and used by nothing, so
 * a shot planned at 7s was estimated at 7s, totalled at 7s, and sent as 7s, and
 * whatever the provider then did with it — round, refuse, or pick for us — was
 * a surprise arriving after the charge.
 *
 * NEAREST, WITH TIES GOING UP. A tie means the user's intent sits exactly
 * between two lengths, and of the two only the longer one can still be trimmed
 * on the timeline; the shorter one is gone. So the tie-break is the recoverable
 * direction rather than the cheaper one.
 *
 * Applied inside `plannedSeconds` so the cost estimate, the board's runtime
 * total, the card's warnings and the generation request all say the same number.
 * They have disagreed before, and a summary that contradicts itself is worse
 * than one that is merely approximate.
 */
export function snapDuration(caps: ModelCaps, wanted: number): number {
  const inRange = Math.max(caps.minDurationSec, Math.min(caps.maxDurationSec, wanted));
  if (!caps.allowedDurations.length) return inRange;

  let best = caps.allowedDurations[0]!;
  for (const d of caps.allowedDurations) {
    const closer = Math.abs(d - inRange) < Math.abs(best - inRange);
    const tie = Math.abs(d - inRange) === Math.abs(best - inRange);
    if (closer || (tie && d > best)) best = d;
  }
  return best;
}

/**
 * The size this shot will actually render at.
 *
 * A shot stores `''` until someone picks, and `''` is not a size — so every
 * reader would otherwise have to decide for itself what unset means, and they
 * would not agree. The model's FIRST resolution is the answer, because that is
 * already what `pricePerSec`, the server's `gen-frame` and every existing caller
 * treat as the default; picking anything else here would quote one size and
 * render another.
 *
 * A stored value that the model does not offer is discarded rather than
 * honoured. Models change under saved boards — Fast has no 1080p — and a shot
 * asking for a size its model cannot make is a generation that fails at the
 * provider rather than at the picker.
 */
export function resolutionFor(
  shot: { resolution?: string; model: string },
  caps?: ModelCaps | null,
): string {
  const m = caps ?? effectiveModel(shot.model);
  const offered = m?.resolutions ?? [];
  if (!offered.length) return '';
  const want = (shot.resolution ?? '').trim();
  return want && offered.includes(want) ? want : offered[0];
}

/** Same rule for the frame shape. */
export function aspectFor(
  shot: { aspect?: string; model: string },
  caps?: ModelCaps | null,
): string {
  const m = caps ?? effectiveModel(shot.model);
  const offered = m?.aspectRatios ?? [];
  if (!offered.length) return '';
  const want = (shot.aspect ?? '').trim();
  return want && offered.includes(want) ? want : offered[0];
}

export function estimateShotCredits(
  shot: { kind?: string; model: string; durationSec: number; resolution?: string },
): number | null {
  // A composition is RENDERED, not generated. There is no model call to bill.
  if (shot.kind === 'hyperframes') return 0;

  const caps = effectiveModel(shot.model);
  if (!caps) return null;

  // A LOCAL MODEL IS FREE, and that is zero rather than "unknown". Falling
  // through would reach `return null` — the catalogue sends `credits: 0` and
  // `pricePerSec: {}`, neither of which passes the `> 0` guards below — and the
  // card would then print nothing at all where "no gen cost" belongs. Silence
  // reads as a missing price, not as a free one.
  if (caps.local) return 0;

  // Not planned yet: priced at the model's shortest allowed clip, which is the
  // floor rather than a guess at what they will choose. See `plannedSeconds`.
  const seconds = plannedSeconds(shot);

  // PRICE THE SIZE THEY CHOSE. This used to take the first entry of
  // `pricePerSec` unconditionally, which was right while nobody could choose —
  // and became a card quoting 480p over a shot set to render at 1080p, off by
  // more than 4× on Seedance 2.5. `resolutionFor` falls back to that same first
  // entry, so an unset shot is priced exactly as before.
  const rate = caps.pricePerSec?.[resolutionFor(shot, caps)];
  const perSec = typeof rate === 'number' ? rate : Object.values(caps.pricePerSec ?? {})[0];
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

  /**
   * A LOCAL MODEL THAT CANNOT RUN YET, said here rather than at generation time.
   *
   * This is the whole argument for warnings-not-errors applied to hardware. The
   * user picks a model on the card, and the card is where they find out that the
   * machine needs a 19 GB file — while it is still cheap to either go and get it
   * or pick something else. Discovering it after pressing Generate, having
   * arranged twelve shots around it, is the same information delivered at the
   * worst possible moment.
   *
   * First in the list, because nothing else about the shot matters until the
   * model can actually run.
   */
  if (caps.local && !caps.local.ready) {
    out.push({
      message: `${caps.label} is not ready on ${caps.local.nodeName}. `
        + (caps.local.missing || 'It needs setting up before this shot can be generated.'),
    });
  }

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

  /**
   * THERE WAS A WARNING HERE, and removing it is the point.
   *
   * It fired when a NARRATION was written against a model with no native
   * dialogue: "this line will be voiced separately with TTS and laid over the
   * clip". Every word of that is true — and it is true on EVERY model, because
   * a narration is a separate track by definition ("spoken separately, not by
   * the video", says the field itself). Flagging it only on some models framed
   * the normal case as a problem, and implied that on a speaking model the
   * narrator would be performed on camera instead, which is not something
   * anybody wants a narrator to be.
   *
   * A warning that fires on correct work teaches people to ignore warnings.
   */

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
