/**
 * Voidspace text-to-speech + script enhancement for the editor's
 * Text-to-Speech panel.
 *
 * Replaces the old BYOK ElevenLabs / openreel-Piper TTS and the BYOK
 * Anthropic/OpenAI "enhance" call. Talks ONLY to the Voidspace Studio server
 * proxies, so the central ElevenLabs + LLM keys and the credit ledger stay
 * server-side — same pattern as the Suno audio client (services/suno) and
 * the caption STT client (services/voidspace-transcribe):
 *
 *   POST /api/studio/gen-voiceover  → ElevenLabs TTS (charges studio_tts).
 *                                     skipStt:true → no captions = no extra
 *                                     per-minute STT charge (TTS-only).
 *   POST /api/studio/enhance-text   → LLM rewrite for TTS (charges 1 credit,
 *                                     uses the user's agent model).
 *
 * Auth: the user's Firebase ID token forwarded as `Authorization: Bearer`.
 */

import { auth } from "../config/firebase-config";
import { toast } from "../stores/notification-store";
import type { ElevenLabsVoice, ElevenLabsModel } from "../components/editor/inspector/tts-types";

async function authHeader(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to use AI voice tools.");
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

function apiBase(): string {
  if (typeof window !== "undefined") {
    try {
      if (window.parent && window.parent !== window) {
        return window.parent.location.origin;
      }
    } catch {
      /* cross-origin — use current origin */
    }
  }
  return "";
}

async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw);
    return j?.statusMessage || j?.message || j?.statusText || raw || `HTTP ${res.status}`;
  } catch {
    return raw || `HTTP ${res.status}`;
  }
}

/** True when a Voidspace user is signed in, so the TTS panel can route through
 *  the credit-charged Voidspace API instead of being dead (BYOK removed). */
export function isVoidspaceTtsAvailable(): boolean {
  return !!auth.currentUser;
}

/**
 * Curated set of stable, long-standing public ElevenLabs voices. gen-voiceover
 * takes a raw ElevenLabs voice_id, so we expose a small reliable picker rather
 * than the user's whole (BYOK) library. Shaped as ElevenLabsVoice so the
 * existing VoiceBrowser renders them unchanged.
 */
export const VOIDSPACE_TTS_VOICES: ElevenLabsVoice[] = [
  { voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", category: "premade", labels: { gender: "female", accent: "american", description: "calm narration" } },
  { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", category: "premade", labels: { gender: "female", accent: "american", description: "soft news" } },
  { voice_id: "XB0fDUnXU5powFXDhCwa", name: "Charlotte", category: "premade", labels: { gender: "female", accent: "english", description: "warm" } },
  { voice_id: "pNInz6obpgDQGcFmaJgB", name: "Adam", category: "premade", labels: { gender: "male", accent: "american", description: "deep narration" } },
  { voice_id: "ErXwobaYiN019PkySvjV", name: "Antoni", category: "premade", labels: { gender: "male", accent: "american", description: "well-rounded" } },
  { voice_id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", category: "premade", labels: { gender: "male", accent: "british", description: "news presenter" } },
  { voice_id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh", category: "premade", labels: { gender: "male", accent: "american", description: "young, deep" } },
  { voice_id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", category: "premade", labels: { gender: "female", accent: "american", description: "strong" } },
];

/** TTS models the studio registry exposes (the user's pick maps straight to
 *  gen-voiceover's `model`). Shaped as ElevenLabsModel for the ModelSelector. */
export const VOIDSPACE_TTS_MODELS: ElevenLabsModel[] = [
  { model_id: "eleven_v3", name: "ElevenLabs v3 (Expressive)", can_do_text_to_speech: true },
  { model_id: "eleven_multilingual_v2", name: "Multilingual v2", can_do_text_to_speech: true },
  { model_id: "eleven_turbo_v2_5", name: "Turbo v2.5", can_do_text_to_speech: true },
  { model_id: "eleven_flash_v2_5", name: "Flash v2.5", can_do_text_to_speech: true },
];

/**
 * Synthesize speech via Voidspace TTS and return the audio as a Blob (the shape
 * the editor's TTS pipeline already consumes). Charges credits server-side and
 * surfaces the amount via a toast.
 */
export async function synthesizeViaVoidspace(
  text: string,
  voiceId: string,
  model?: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const headers = await authHeader();
  const base = apiBase();

  // Only forward a model the server actually knows (else gen-voiceover 400s on
  // a stale BYOK id); otherwise let it pick its default.
  const known = new Set(VOIDSPACE_TTS_MODELS.map((m) => m.model_id));
  const safeModel = model && known.has(model) ? model : undefined;

  const res = await fetch(`${base}/api/studio/gen-voiceover`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      script: text,
      voiceId: voiceId || undefined,
      model: safeModel,
      // Use the picked voice (not an avatar's cloned voice) and don't run STT
      // captions — the TTS panel only needs the audio.
      narrationOverride: true,
      skipStt: true,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Voice generation failed: ${await errorText(res)}`);
  const data = (await res.json()) as { audioUrl?: string; charged?: number; balance?: number };
  if (!data.audioUrl) throw new Error("Voice generation returned no audio.");

  // Pull the generated mp3 down as a Blob so it flows through the existing
  // store → media-import → timeline path unchanged.
  const audioRes = await fetch(data.audioUrl, { signal });
  if (!audioRes.ok) throw new Error(`Failed to download generated audio (${audioRes.status}).`);
  const blob = await audioRes.blob();

  if (typeof data.charged === "number" && data.charged > 0) {
    toast.success("Voiceover generated", `${data.charged} credits used`);
  }
  return blob;
}

/** Rewrite a script for better TTS delivery via the Voidspace LLM (agent
 *  model). Charges a small credit fee server-side. */
export async function enhanceTextViaVoidspace(
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const headers = await authHeader();
  const base = apiBase();
  const res = await fetch(`${base}/api/studio/enhance-text`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw new Error(`Text enhancement failed: ${await errorText(res)}`);
  const data = (await res.json()) as { text?: string };
  return data.text ?? text;
}
