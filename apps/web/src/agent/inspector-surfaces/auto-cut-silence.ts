/**
 * Inspector surface: Auto-Cut Silence.
 *
 * Exposes the editor's existing silence-cutting bridge to the agent, so
 * "clean up the pauses in my recording" is a single deterministic call.
 *
 * Why this matters for the record→explainer flow: without it the agent could
 * only remove pauses INDIRECTLY — transcribe the take (a paid STT round-trip),
 * infer gaps from word timestamps, then issue one remove_range per gap. That is
 * slow, costs credits, and is only as accurate as the transcript's timings.
 * This surface reads the actual waveform instead: it is exact, instant, free,
 * and runs entirely on-device (Web Audio decode + amplitude analysis in
 * @openreel/core's audio engine — no API, no model, no network).
 *
 * It wraps the SAME bridge the Auto-Cut Silence Inspector section drives
 * (analyzeClip → cutSilence), per the surface design rules — the agent and the
 * button cannot diverge.
 *
 * Requires the clip's media BLOB to be present locally, which is true for
 * anything the user recorded or imported. A cloud-only clip (an AI-generated
 * scene that was never materialized) has no blob and is reported as skipped
 * rather than silently doing nothing.
 */
import type { InspectorSurface } from "./types";
import {
  getSilenceCutBridge,
  DEFAULT_SILENCE_SETTINGS,
  type SilenceSettings,
} from "../../bridges/silence-cut-bridge";

interface AutoCutSilenceConfig {
  /** dBFS below which a 100 ms window counts as silence. Default -40. */
  thresholdDb?: number;
  /** Ignore silences shorter than this (seconds). Default 0.5. */
  minSilenceSec?: number;
  /** Breath kept on each side of a cut (seconds). Default 0.1. */
  padSec?: number;
  /** Analyse and report only — make no edits. */
  dryRun?: boolean;
}

export const surface: InspectorSurface<AutoCutSilenceConfig> = {
  name: "auto-cut-silence",
  description:
    "Detect silent gaps in a recorded clip's audio and ripple-delete them, tightening pauses and dead air. On-device waveform analysis — exact, free, and far more precise than cutting from a transcript. Use for 'remove the pauses', 'tighten this up', 'cut the dead air' on a webcam/screen/uploaded take.",
  appliesTo: ["video", "audio"],
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      thresholdDb: {
        type: "number",
        minimum: -80,
        maximum: -10,
        description:
          "Silence threshold in dBFS (default -40). Lower = stricter, cuts less. Raise toward -30 for a noisy room, drop toward -50 for a very quiet one.",
      },
      minSilenceSec: {
        type: "number",
        minimum: 0.05,
        maximum: 10,
        description:
          "Shortest gap worth cutting, in seconds (default 0.5). Below ~0.3 the result starts sounding clipped and unnatural.",
      },
      padSec: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Breath left on each side of every cut, in seconds (default 0.1). Keeps speech from being chopped at the consonant.",
      },
      dryRun: {
        type: "boolean",
        description:
          "Report what WOULD be cut without changing the timeline. Use this first when the user wants to see the damage before committing.",
      },
    },
  },
  async apply(clip, config, _ctx) {
    const cfg = config || {};
    const settings: SilenceSettings = {
      threshold:
        typeof cfg.thresholdDb === "number" ? cfg.thresholdDb : DEFAULT_SILENCE_SETTINGS.threshold,
      minSilenceDuration:
        typeof cfg.minSilenceSec === "number"
          ? cfg.minSilenceSec
          : DEFAULT_SILENCE_SETTINGS.minSilenceDuration,
      paddingBefore:
        typeof cfg.padSec === "number" ? cfg.padSec : DEFAULT_SILENCE_SETTINGS.paddingBefore,
      paddingAfter:
        typeof cfg.padSec === "number" ? cfg.padSec : DEFAULT_SILENCE_SETTINGS.paddingAfter,
    };

    try {
      const bridge = getSilenceCutBridge();
      const analysis = await bridge.analyzeClip(clip.id, settings);
      const found = analysis.silentRegions.length;

      if (found === 0) {
        return { ok: true, note: "No silence found at this threshold — nothing cut." };
      }

      const removed = analysis.totalSilenceDuration;
      const summary =
        `${found} silent gap${found === 1 ? "" : "s"}, ` +
        `${removed.toFixed(1)}s of ${analysis.clipDuration.toFixed(1)}s`;

      if (cfg.dryRun) {
        return { ok: true, note: `Would cut ${summary} (dry run — timeline unchanged).` };
      }

      const res = await bridge.cutSilence(clip.id, analysis.silentRegions);
      if (!res.success) {
        return { ok: false, error: res.error || "Silence cut failed" };
      }
      return { ok: true, note: `Cut ${summary}.` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The common, actionable failure: the clip's bytes aren't in the browser.
      if (/blob not found/i.test(msg)) {
        return {
          ok: false,
          error:
            "This clip has no local audio to analyse (it's a cloud asset). Auto-cut silence works on recordings and imported files.",
        };
      }
      return { ok: false, error: msg };
    }
  },
};
