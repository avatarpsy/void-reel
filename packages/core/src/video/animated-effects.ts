/**
 * EFFECT KEYFRAMES, IN ONE PLACE FOR PREVIEW AND EXPORT.
 *
 * A clip's `effect.brightness` / `effect.contrast` / `effect.saturation` /
 * `effect.blur` keyframes, applied to its effects at a clip-local time. Each is
 * written to the param key the renderer READS (`value`, `radius` for blur) —
 * upstream OpenReel's fix (#62): the old code wrote `brightness` etc., which no
 * renderer reads, so animated looks never showed. An effect with keyframes but
 * not yet on the clip is synthesised, so animating needs no "add effect" first.
 *
 * Export (`VideoEngine`) and the editor's preview (`applyEffectsToFrame`) both
 * call this, so an animated look plays the same on screen and in the file.
 */
import type { Effect, Keyframe } from "../types/timeline";
import { keyframeEngine } from "./keyframe-engine";

const EFFECT_KEYFRAME_PROPS = ["effect.brightness", "effect.contrast", "effect.saturation", "effect.blur"];

/** Does this clip animate any effect? Cheap — a gate for the effects pass. */
export function hasEffectKeyframes(keyframes: readonly Keyframe[] | undefined): boolean {
  return !!keyframes?.some((k) => EFFECT_KEYFRAME_PROPS.includes(k.property));
}

export function animateEffects(
  clipId: string,
  baseEffects: Effect[],
  keyframes: Keyframe[],
  localTime: number,
): Effect[] {
  if (keyframes.length === 0) {
    return baseEffects;
  }

  // Each entry maps a keyframe property → effect type and the actual
  // param key the renderer reads (see EFFECT_DEFINITIONS in types/effects.ts).
  const effectPropertyMap: Array<{
    keyframeProp: string;
    effectType: string;
    paramKey: string;
  }> = [
    { keyframeProp: "effect.brightness", effectType: "brightness", paramKey: "value" },
    { keyframeProp: "effect.contrast", effectType: "contrast", paramKey: "value" },
    { keyframeProp: "effect.saturation", effectType: "saturation", paramKey: "value" },
    { keyframeProp: "effect.blur", effectType: "blur", paramKey: "radius" },
  ];

  const animatedByType = new Map<string, { paramKey: string; value: number }>();

  for (const { keyframeProp, effectType, paramKey } of effectPropertyMap) {
    const effectKfs = keyframeEngine.getKeyframesForProperty(
      keyframes,
      keyframeProp,
    );
    if (effectKfs.length === 0) continue;
    const result = keyframeEngine.getValueAtTime(effectKfs, localTime);
    if (typeof result.value === "number") {
      animatedByType.set(effectType, { paramKey, value: result.value });
    }
  }

  if (animatedByType.size === 0) {
    return baseEffects;
  }

  // Patch existing effects with interpolated values.
  const seen = new Set<string>();
  const patched = baseEffects.map((effect) => {
    const animated = animatedByType.get(effect.type);
    if (!animated) return effect;
    seen.add(effect.type);
    return {
      ...effect,
      params: { ...effect.params, [animated.paramKey]: animated.value },
    };
  });

  // Synthesize effects that have keyframes but aren't on the clip yet,
  // so users can animate brightness/contrast/etc. without first adding the
  // effect manually.
  for (const [effectType, { paramKey, value }] of animatedByType) {
    if (seen.has(effectType)) continue;
    patched.push({
      id: `kf-synth-${clipId}-${effectType}`,
      type: effectType as Effect["type"],
      enabled: true,
      params: { [paramKey]: value },
    } as Effect);
  }

  return patched;
}
